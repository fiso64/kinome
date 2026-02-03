import { Elysia, t } from 'elysia'
import { cors } from '@elysiajs/cors'
import { staticPlugin } from '@elysiajs/static'
import path from 'path'
import fs from 'fs'

import { initializeStartup } from './services/startup.service'
import * as libraryService from './services/library.service'
import * as settingsService from './services/settings.service'
import { resolveLibraryPath } from './services/paths.service'
import { loadDbIntoMemory } from './services/library.service'
import { WebTransport } from './transport/web.transport'
import { setTransport } from './transport.registry'
import * as authService from './services/auth.service'
import { v2Routes } from './routes/v2.elysia'

// 1. Initialize Services
const port = process.env.PORT || 3000

function getDefaultUserDataPath(): string {
  const appName = 'media-browser'
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', appName)
  } else if (process.platform === 'darwin') {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', appName)
  } else {
    return path.join(process.env.HOME || '', '.config', appName)
  }
}

const userDataPath = process.env.USER_DATA_PATH || getDefaultUserDataPath()
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true })
}

initializeStartup(userDataPath)

const webTransport = new WebTransport()
setTransport(webTransport)

// 2. Setup Elysia App
const app = new Elysia()
  .use(cors())
  // Logger Middleware
  .onBeforeHandle(({ request }) => {
    const url = new URL(request.url).pathname
    if (url.startsWith('/api/') && !url.startsWith('/api/assets')) {
      (request as any)._startTime = Date.now()
      console.log(`[API] [REQUEST] ${request.method} ${url}`)
    }
  })
  .onAfterHandle(({ request, set }) => {
    const url = new URL(request.url).pathname
    if (url.startsWith('/api/') && !url.startsWith('/api/assets')) {
      const duration = Date.now() - ((request as any)._startTime || Date.now())
      console.log(`[API] [RESPONSE] ${request.method} ${url} - Status: ${set.status || 200} (${duration}ms)`)
    }
  })
  // Auth Middleware
  .derive(async ({ request, set }) => {
    const url = new URL(request.url).pathname
    if (!url.startsWith('/api')) return {}

    const settings = await settingsService.readSettings()

    // Auth Check Logic
    const isPublic = ['/api/login', '/api/check-auth', '/api/setup-admin', '/api/assets'].some(p => url.startsWith(p))
    if (settings.allowUnauthenticated || isPublic) {
      return { authenticated: true }
    }

    // Check token
    const authHeader = request.headers.get('authorization')
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : new URL(request.url).searchParams.get('token')

    if (token && authService.validateToken(token)) {
      return { authenticated: true }
    }

    // If not authenticated and not public, throw error or set status
    if (url.startsWith('/api') && !isPublic) {
      set.status = 401
      throw new Error('Unauthorized')
    }

    return { authenticated: false }
  })
  // WebSocket
  .ws('/ws', {
    open(ws) {
      console.log(`[WebTransport] Client connected: ${ws.id}`)
      ws.subscribe('broadcast')
    },
    close(ws) {
      console.log(`[WebTransport] Client disconnected: ${ws.id}`)
    }
  })
  // Assets (High-performance streaming)
  .get('/api/assets/*', async ({ params, set }) => {
    try {
      let relativePath = decodeURIComponent(params['*'])
      if (relativePath.includes('?')) {
        relativePath = relativePath.split('?')[0]
      }

      let fullPath = resolveLibraryPath(relativePath)

      if (!fs.existsSync(fullPath)) {
        const imagesPath = resolveLibraryPath(path.join('images', relativePath))
        if (fs.existsSync(imagesPath)) {
          fullPath = imagesPath
        }
      }

      if (fs.existsSync(fullPath)) {
        return Bun.file(fullPath)
      } else {
        set.status = 404
        return 'Not found'
      }
    } catch (e) {
      set.status = 500
      return 'Error'
    }
  })
  // API Routes
  .group('/api', app => app
    .get('/check-auth', async ({ request }) => {
      const authHeader = request.headers.get('authorization')
      const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : new URL(request.url).searchParams.get('token')

      const isValid = token ? authService.validateToken(token) : false
      const state = await authService.getAuthState()

      return {
        ...state,
        authenticated: state.allowUnauthenticated || isValid
      }
    })
    .post('/login', async ({ body }: { body: any }) => {
      const { password } = body
      if (!password) {
        return { success: false, message: 'Password required' }
      }
      const token = await authService.login(password)
      if (token) {
        return { success: true, token }
      } else {
        return { success: false, message: 'Invalid password' }
      }
    })
    .post('/setup-admin', async ({ body }: { body: any }) => {
      try {
        const { password, unauthenticated } = body
        return await authService.setupAdmin(password, unauthenticated)
      } catch (error: any) {
        return { success: false, message: error.message }
      }
    })
    .post('/change-password', async ({ body }: { body: any }) => {
      const { password } = body
      if (!password) {
        return { success: false, message: 'Password required' }
      }
      await authService.updateAdminPassword(password)
      return { success: true }
    })
    // Library Endpoints
    .post('/perform-search', ({ body }: { body: any }) => libraryService.performSearch(body))
    .get('/library-root', () => libraryService.getLibraryRoot())
    .get('/item-details/:id', ({ params }) => libraryService.getItemDetails(params.id))
    .get('/item-by-id/:id', ({ params }) => libraryService.getItemById(params.id))
    .get('/children/:id', ({ params }) => libraryService.getChildren(params.id))
    .get('/hidden-children/:id', ({ params }) => libraryService.getHiddenChildren(params.id))
    .get('/parent/:id', ({ params }) => libraryService.getParent(params.id))
    .get('/autocomplete-suggestions', () => libraryService.getAutocompleteSuggestions())
    .post('/user-update-item', async ({ body }: { body: any }) => {
      await libraryService.updateItem(body, true)
      return 'OK'
    })
    .post('/apply-initial-folder-settings', async ({ body }: { body: any }) => {
      await libraryService.applyInitialFolderSettings(body.settings)
      return 'OK'
    })
    .post('/perform-initial-scan', async ({ body, set }: { body: any, set: any }) => {
      const { path } = body
      if (!path || typeof path !== 'string') {
        set.status = 400
        return 'Path is required'
      }
      return libraryService.performInitialScan(path)
    })
    .post('/perform-full-rescan', ({ body }: { body: any }) => libraryService.performFullRescan(body.path))
    .post('/refresh-library', () => libraryService.refreshLibrary())
    .post('/play-file', ({ body }: { body: any }) => libraryService.playFile(body.file, (opt) => console.log(opt)))
    .post('/play-file-with', ({ body }: { body: any }) => libraryService.playFileWith(body.file, body.command, (opt) => console.log(opt)))
    .post('/record-playback', async ({ body }: { body: any }) => {
      await libraryService.recordPlayback(body.itemId)
      return 'OK'
    })
    .post('/assign-seasons-and-episodes', async ({ body, set }: { body: any, set: any }) => {
      const { showId, seasonStrategy, episodeStrategy, fetchMetadata } = body
      try {
        await libraryService.assignSeasonsAndEpisodes(showId, seasonStrategy, episodeStrategy, fetchMetadata)
        return { success: true }
      } catch (error: any) {
        set.status = 500
        return { error: error.message }
      }
    })
    .post('/clear-item-metadata', ({ body }: { body: any }) => libraryService.clearItemMetadata(body.itemId, body.childrenOnly))
    .post('/clear-virtual-folder-metadata', ({ body }: { body: any }) => libraryService.clearVirtualFolderMetadata(body.itemIds))
    .post('/fetch-credits', async ({ body }: { body: any }) => {
      await libraryService.fetchCredits(body.itemId)
      return 'OK'
    })
    .post('/manual-search', async ({ body }: { body: any }) => {
      const settings = await settingsService.readSettings()
      return libraryService.manualSearch(body.query, body.type, settings.tmdbApiKey, body.year, body.tmdbId)
    })
    .post('/get-tmdb-images', async ({ body }: { body: any }) => {
      const settings = await settingsService.readSettings()
      return libraryService.getTmdbImages(body.tmdbId, body.mediaType, settings.tmdbApiKey, body.language)
    })
    .post('/user-apply-tmdb-result', async ({ body }: { body: any }) => {
      await libraryService.applyManualMatch(body.itemId, body.result, body.mediaType)
      return 'OK'
    })
    .post('/user-set-image', async ({ body }: { body: any }) => {
      await libraryService.setImage(body.itemId, body.imageType, body.source)
      return 'OK'
    })
    .post('/remove-image', async ({ body }: { body: any }) => {
      await libraryService.removeImage(body.itemId, body.imageType)
      return 'OK'
    })
    .post('/mark-watched', async ({ body }: { body: any }) => {
      await libraryService.markAsWatched(body.itemId)
      return 'OK'
    })
    .post('/mark-unwatched', async ({ body }: { body: any }) => {
      await libraryService.markAsUnwatched(body.itemId)
      return 'OK'
    })
    .get('/folder-watched-state/:id', async ({ params }) => {
      const state = await libraryService.getFolderWatchedState(params.id)
      return { state }
    })
    .get('/continue-watching-items', () => libraryService.getContinueWatchingItems())
    .get('/continue-watching-for-show/:id', ({ params }) => libraryService.getContinueWatchingForShow(params.id))
    .post('/dismiss-continue-watching', async ({ body }: { body: any }) => {
      await libraryService.setContinueWatchingDismissed(body.itemId)
      return 'OK'
    })
    .post('/dismiss-next-up', async ({ body }: { body: any }) => {
      await libraryService.setNextUpDismissed(body.itemId)
      return 'OK'
    })
    .post('/reveal-in-explorer', async ({ body }: { body: any }) => {
      await libraryService.revealInExplorer(body.path)
      return 'OK'
    })
    .post('/trash-item', ({ body }: { body: any }) => libraryService.trashItem(body.path))
    .post('/delete-item-from-db', ({ body }: { body: any }) => libraryService.deleteItemFromDb(body.itemId))
    .post('/rename-item', ({ body }: { body: any }) => libraryService.renameItem(body.oldPath, body.newName))
    .get('/item-properties/*', async ({ params }) => {
      const itemPath = decodeURIComponent(params['*'])
      return libraryService.getItemProperties(itemPath)
    })
    // Streaming
    .get('/stream/:id', async ({ params, set }) => {
      const item = await libraryService.getItemById(params.id) as any
      if (!item || !item.path) {
        set.status = 404
        return 'File not found'
      }
      const filePath = await libraryService.getAbsolutePath(item.path)
      if (!filePath) {
        set.status = 404
        return 'File not found'
      }
      if (filePath.startsWith('http')) {
        return Response.redirect(filePath)
      }
      return Bun.file(filePath)
    })
    .get('/stream/:id/:filename', async ({ params, set }) => {
      const item = await libraryService.getItemById(params.id) as any
      if (!item || !item.path) {
        set.status = 404
        return 'File not found'
      }
      const filePath = await libraryService.getAbsolutePath(item.path)
      if (!filePath) {
        set.status = 404
        return 'File not found'
      }
      return Bun.file(filePath)
    })
    .get('/playlist/:id', async ({ params, query, request, set }) => {
      try {
        const id = params.id.endsWith('.m3u') ? params.id.slice(0, -4) : params.id
        const playlist = await libraryService.generatePlaylist(id)
        if (!playlist || playlist.length === 0) {
          set.status = 404
          return 'Item not found'
        }

        const url = new URL(request.url)
        const host = url.host
        const protocol = url.protocol

        let m3uContent = '#EXTM3U\n'
        for (const item of playlist) {
          let title = item.title || item.name
          const f = item as any
          if (typeof f.seasonNumber === 'number' && typeof f.episodeNumber === 'number') {
            const s = f.seasonNumber.toString().padStart(2, '0')
            const e = f.episodeNumber.toString().padStart(2, '0')
            title = `S${s}E${e} - ${title}`
          }

          m3uContent += `#EXTINF:-1,${title}\n`
          const filename = encodeURIComponent(item.name)
          const token = query.token as string
          const streamUrl = `${protocol}//${host}/api/stream/${item.id}/${filename}`
          m3uContent += token ? `${streamUrl}?token=${token}\n` : `${streamUrl}\n`
        }

        set.headers['Content-Type'] = 'audio/x-mpegurl'
        return m3uContent
      } catch (e) {
        set.status = 500
        return 'Error'
      }
    })
    .get('/library-media-source-path', () => settingsService.getAbsoluteMediaSourcePath())
    .post('/resolve-media-source-path', ({ body }: { body: any }) => settingsService.resolveMediaSourcePath(body.path, body.isRelative))
    .post('/execute-custom-action', async ({ body }: { body: any }) => {
      await libraryService.executeCustomAction(body.itemId, body.commandId, (opt) => console.log(opt))
      return 'OK'
    })
    .get('/settings', async () => {
      const settings = await settingsService.readSettings()
      const sanitized = { ...settings }
      delete (sanitized as any).adminPasswordHash
      return sanitized
    })
    .post('/save-settings', async ({ body }: { body: any }) => {
      await settingsService.saveSettingsChanges(body)
      const newSettings = await settingsService.readSettings()
      const sanitized = { ...newSettings }
      delete (sanitized as any).adminPasswordHash
      webTransport.notifySettingsUpdated(sanitized as any)
      return sanitized
    })
    .use(v2Routes)
  )

// 3. Static Files (Production only)
if (process.env.NODE_ENV === 'production') {
  const distPath = path.resolve((import.meta as any).dir, '../../out/renderer')
  app.use(staticPlugin({
    assets: distPath,
    prefix: '/'
  }))
  // Fallback to index.html for SPA
  app.get('*', () => Bun.file(path.join(distPath, 'index.html')))
}

// 4. Start Server
app.get('/', ({ set }) => {
  if (process.env.NODE_ENV !== 'production') {
    return `
      <html>
        <head><title>Media Browser Backend</title></head>
        <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #121212; color: #fff;">
          <h1>🦊 Media Browser Backend is running</h1>
          <p>This is the API server. To view the app, open <a href="http://localhost:5173" style="color: #4facfe;">http://localhost:5173</a> (Vite Dev Server).</p>
        </body>
      </html>
    `
  }
  set.status = 404
  return 'Not found'
})

async function start() {
  console.log('[Server] Loading database into memory...')
  await loadDbIntoMemory()

  const settings = await settingsService.readSettings()
  const finalPort = settings.serverPort || Number(port)

  app.listen(finalPort, (server) => {
    webTransport.initialize(server)
    console.log(`🦊 Elysia is running at http://${server?.hostname}:${server?.port}`)
  })
}

start().catch((err) => {
  console.error('[Server] Failed to start:', err)
  process.exit(1)
})