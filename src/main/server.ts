import { Elysia, t } from 'elysia'
import { cors } from '@elysiajs/cors'
import { staticPlugin } from '@elysiajs/static'
import path from 'path'
import fs from 'fs'

import { initializeStartup } from './services/startup.service'
import * as libraryService from './services/library.service'
import * as settingsService from './services/settings.service'
import { resolveLibraryPath } from './services/paths.service'
import { WebTransport } from './transport/web.transport'
import { setTransport } from './transport.registry'
import * as authService from './services/auth.service'
import { v2Routes } from './routes/v2.elysia'

// --- Security Middleware & Constants ---

const PUBLIC_PATHS = ['/api/login', '/api/check-auth', '/api/setup-admin']

// Simple in-memory rate limiter for login
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>()
const RATE_LIMIT_WINDOW = 15 * 60 * 1000 // 15 mins
const MAX_ATTEMPTS = 10

// Stream playback debounce to prevent DB spam on range requests
const playbackDebounce = new Map<string, number>()
const PLAYBACK_DEBOUNCE_WINDOW = 5 * 60 * 1000 // 5 mins

function recordPlaybackDebounced(itemId: string) {
  const now = Date.now()
  const last = playbackDebounce.get(itemId) || 0
  if (now - last > PLAYBACK_DEBOUNCE_WINDOW) {
    playbackDebounce.set(itemId, now)
    libraryService.recordPlayback(itemId).catch(console.error)
  }
}

function checkRateLimit(ip: string): { allowed: boolean; waitTime?: number } {
  const now = Date.now()
  const attempt = loginAttempts.get(ip)

  if (attempt) {
    if (now - attempt.lastAttempt > RATE_LIMIT_WINDOW) {
      loginAttempts.delete(ip)
      return { allowed: true }
    }
    if (attempt.count >= MAX_ATTEMPTS) {
      const waitTime = Math.ceil((RATE_LIMIT_WINDOW - (now - attempt.lastAttempt)) / 60000)
      return { allowed: false, waitTime }
    }
  }
  return { allowed: true }
}

function recordFailedAttempt(ip: string) {
  const attempt = loginAttempts.get(ip) || { count: 0, lastAttempt: Date.now() }
  attempt.count++
  attempt.lastAttempt = Date.now()
  loginAttempts.set(ip, attempt)
}

function resetRateLimit(ip: string) {
  loginAttempts.delete(ip)
}

// 1. Initialize Services
const port = process.env.PORT || 3000

/**
 * Resolves the directory where settings.json and the database should live.
 * Priority:
 * 1. Environment Variable (MEDIA_BROWSER_DATA) - Best for Docker/Systemd
 * 2. "./data" folder relative to CWD - Best for Portable/Dev use
 * 3. OS Default (AppData/.config) - Best for standard Desktop install
 */
function resolveUserDataPath(): string {
  const appName = 'media-browser'

  // 1. Environment Variable
  if (process.env.MEDIA_BROWSER_DATA) {
    console.log(`[Startup] Using data path from env: ${process.env.MEDIA_BROWSER_DATA}`)
    return process.env.MEDIA_BROWSER_DATA
  }

  // 2. Portable Mode (Check if 'data' folder exists in current working directory)
  const localDataPath = path.resolve(process.cwd(), 'data')
  if (fs.existsSync(localDataPath)) {
    console.log(`[Startup] Detected 'data' folder. Running in Portable Mode: ${localDataPath}`)
    return localDataPath
  }

  // 3. OS Standards (Fallback)
  let osPath = ''
  if (process.platform === 'win32') {
    osPath = path.join(process.env.APPDATA || '', appName)
  } else if (process.platform === 'darwin') {
    osPath = path.join(process.env.HOME || '', 'Library', 'Application Support', appName)
  } else {
    // Linux/Unix: Respect XDG_CONFIG_HOME
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config')
    osPath = path.join(xdgConfig, appName)
  }

  console.log(`[Startup] Using OS default data path: ${osPath}`)
  return osPath
}

const userDataPath = resolveUserDataPath()

// Ensure directory exists
if (!fs.existsSync(userDataPath)) {
  try {
    fs.mkdirSync(userDataPath, { recursive: true })
  } catch (e) {
    console.error(`[Startup] CRITICAL: Could not create data directory at ${userDataPath}`)
    console.error(`Please check permissions or set MEDIA_BROWSER_DATA environment variable.`)
    process.exit(1)
  }
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
      ; (request as any)._startTime = Date.now()
      console.log(`[API] [REQUEST] ${request.method} ${url}`)
    }
  })
  .onAfterHandle(({ request, set }) => {
    const url = new URL(request.url).pathname
    if (url.startsWith('/api/') && !url.startsWith('/api/assets')) {
      const duration = Date.now() - ((request as any)._startTime || Date.now())
      console.log(
        `[API] [RESPONSE] ${request.method} ${url} - Status: ${set.status || 200} (${duration}ms)`
      )
    }
  })
  .onError(({ code, error, request }) => {
    const url = new URL(request.url).pathname
    console.error(`[API] [ERROR] ${request.method} ${url} - Code: ${code}`)
    console.error(error)
    return { error: (error as any).message || 'Internal Server Error' }
  })
  // Auth Plugin (Deny-by-Default)
  .use((app) =>
    app.derive(async ({ request, set }) => {
      const url = new URL(request.url).pathname

      // Skip non-API/WS routes (frontend assets)
      if (!url.startsWith('/api') && !url.startsWith('/ws')) return { authenticated: true }

      // Check Whitelist
      const isPublic = PUBLIC_PATHS.some((p) => url.startsWith(p))
      const settings = await settingsService.readSettings()

      if (settings.allowUnauthenticated || isPublic) {
        return { authenticated: true }
      }

      // Check Token
      const authHeader = request.headers.get('authorization')
      const token =
        authHeader?.startsWith('Bearer ')
          ? authHeader.substring(7)
          : new URL(request.url).searchParams.get('token')

      if (token && authService.validateToken(token)) {
        return { authenticated: true }
      }

      // Deny-by-Default
      set.status = 401
      throw new Error('Unauthorized')
    })
  )
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

      // SECURITY: resolveLibraryPath now uses securePathJoin internally
      const fullPath = resolveLibraryPath(relativePath)

      if (!fullPath || !fs.existsSync(fullPath)) {
        // Try looking in images fallback if primary path fails
        const securedImagesPath = resolveLibraryPath(path.join('images', relativePath))
        if (securedImagesPath && fs.existsSync(securedImagesPath)) {
          return Bun.file(securedImagesPath)
        }

        set.status = 404
        return 'Not found'
      }

      return Bun.file(fullPath)
    } catch (e) {
      set.status = 500
      return 'Error'
    }
  })
  // API Routes
  .group('/api', (app) =>
    app
      .get('/check-auth', async ({ request }) => {
        const authHeader = request.headers.get('authorization')
        const token = authHeader?.startsWith('Bearer ')
          ? authHeader.substring(7)
          : new URL(request.url).searchParams.get('token')

        const isValid = token ? authService.validateToken(token) : false
        const state = await authService.getAuthState()

        return {
          ...state,
          authenticated: state.allowUnauthenticated || isValid
        }
      })
      .post('/login', async ({ body, set, request }) => {
        const ip = (request as any).ip || '0.0.0.0'
        const rateLimit = checkRateLimit(ip)
        if (!rateLimit.allowed) {
          set.status = 429
          return { success: false, message: `Too many attempts. Please wait ${rateLimit.waitTime} minutes.` }
        }

        const { password } = body as any
        if (!password) {
          set.status = 400
          return { success: false, message: 'Password required' }
        }
        const token = await authService.login(password)
        if (token) {
          resetRateLimit(ip)
          return { success: true, token }
        } else {
          recordFailedAttempt(ip)
          set.status = 401
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
      .get('/item-details/:id', ({ params }) => libraryService.getItemDetails(params.id))
      .get('/item-by-id/:id', ({ params }) => libraryService.getItemById(params.id))
      .get('/children/:id', ({ params }) => libraryService.getChildren(params.id))
      .get('/hidden-children/:id', ({ params }) => libraryService.getHiddenChildren(params.id))
      .get('/parent/:id', ({ params }) => libraryService.getParent(params.id))
      .group('/autocomplete', (group) =>
        group
          .get('/suggestions', () => libraryService.getAutocompleteSuggestions())
          .get('/values/:key', ({ params, query }) =>
            libraryService.getAutocompleteValues(
              params.key,
              (query.q as string) || '',
              query.limit ? parseInt(query.limit as string, 10) : 20
            )
          )
      )
      .get('/group-by-keys', () => libraryService.getGroupByKeys())
      .post('/user-update-item', async ({ body }: { body: any }) => {
        await libraryService.updateItem(body, true)
        return { success: true }
      })
      .post('/apply-initial-folder-settings', async ({ body }: { body: any }) => {
        await libraryService.applyInitialFolderSettings(body.settings)
        return { success: true }
      })
      .post('/perform-initial-scan', async ({ body, set }: { body: any; set: any }) => {
        const { path } = body
        if (!path || typeof path !== 'string') {
          set.status = 400
          return { error: 'Path is required' }
        }
        return libraryService.performInitialScan(path)
      })
      .post('/perform-full-rescan', ({ body }: { body: any }) =>
        libraryService.performFullRescan(body.path)
      )
      .post('/refresh-library', () => libraryService.refreshLibrary())
      .post('/play-file', ({ body }: { body: any }) =>
        libraryService.playFile(body.file, (opt) => console.log(opt))
      )
      .post('/play-file-with', ({ body }: { body: any }) =>
        libraryService.playFileWith(body.file, body.command, (opt) => console.log(opt))
      )
      .post('/record-playback', async ({ body }: { body: any }) => {
        await libraryService.recordPlayback(body.itemId)
        return { success: true }
      })
      .post('/assign-seasons-and-episodes', async ({ body, set }: { body: any; set: any }) => {
        const { showId, seasonStrategy, episodeStrategy, fetchMetadata } = body
        try {
          await libraryService.assignSeasonsAndEpisodes(
            showId,
            seasonStrategy,
            episodeStrategy,
            fetchMetadata
          )
          return { success: true }
        } catch (error: any) {
          set.status = 500
          return { error: error.message }
        }
      })
      .post('/clear-item-metadata', ({ body }: { body: any }) =>
        libraryService.clearItemMetadata(body.itemId, body.childrenOnly)
      )
      .post('/clear-virtual-folder-metadata', ({ body }: { body: any }) =>
        libraryService.clearVirtualFolderMetadata(body.itemIds)
      )
      .post('/fetch-credits', async ({ body }: { body: any }) => {
        await libraryService.fetchCredits(body.itemId)
        return { success: true }
      })
      .post('/manual-search', async ({ body }: { body: any }) => {
        const settings = await settingsService.readSettings()
        return libraryService.manualSearch(
          body.query,
          body.type,
          settings.tmdbApiKey,
          body.year,
          body.tmdbId
        )
      })
      .post('/get-tmdb-images', async ({ body }: { body: any }) => {
        const settings = await settingsService.readSettings()
        return libraryService.getTmdbImages(
          body.tmdbId,
          body.mediaType,
          settings.tmdbApiKey,
          body.language
        )
      })
      .post('/user-apply-tmdb-result', async ({ body }: { body: any }) => {
        await libraryService.applyManualMatch(body.itemId, body.result, body.mediaType)
        return { success: true }
      })
      .post('/user-set-image', async ({ body }: { body: any }) => {
        await libraryService.setImage(body.itemId, body.imageType, body.source)
        return { success: true }
      })
      .post('/remove-image', async ({ body }: { body: any }) => {
        await libraryService.removeImage(body.itemId, body.imageType)
        return { success: true }
      })
      .post('/upload-image', async ({ body, set }: { body: any; set: any }) => {
        try {
          const { itemId, imageType, file } = body as {
            itemId: string
            imageType: string
            file: File
          }
          if (!file) throw new Error('No file uploaded')

          // Use libraryService to handle the logic of where to save and how to update the DB
          await libraryService.uploadImage(itemId, imageType as any, file)
          return { success: true }
        } catch (error: any) {
          set.status = 500
          return { error: error.message }
        }
      })
      .post('/mark-watched', async ({ body }: { body: any }) => {
        await libraryService.markAsWatched(body.itemId)
        return { success: true }
      })
      .post('/mark-unwatched', async ({ body }: { body: any }) => {
        await libraryService.markAsUnwatched(body.itemId)
        return { success: true }
      })
      .get('/folder-watched-state/:id', async ({ params }) => {
        const state = await libraryService.getFolderWatchedState(params.id)
        return { state }
      })
      .get('/continue-watching-items', () => libraryService.getContinueWatchingItems())
      .get('/continue-watching-for-show/:id', ({ params }) =>
        libraryService.getContinueWatchingForShow(params.id)
      )
      .post('/dismiss-continue-watching', async ({ body }: { body: any }) => {
        await libraryService.setContinueWatchingDismissed(body.itemId)
        return { success: true }
      })
      .post('/dismiss-next-up', async ({ body }: { body: any }) => {
        await libraryService.setNextUpDismissed(body.itemId)
        return { success: true }
      })
      .post('/reveal-in-explorer', async ({ body }: { body: any }) => {
        await libraryService.revealInExplorer(body.path)
        return { success: true }
      })
      .post('/trash-item', ({ body }: { body: any }) => libraryService.trashItem(body.path))
      .post('/delete-item-from-db', ({ body }: { body: any }) =>
        libraryService.deleteItemFromDb(body.itemId)
      )
      .post('/rename-item', ({ body }: { body: any }) =>
        libraryService.renameItem(body.oldPath, body.newName)
      )
      .get('/item-properties/*', async ({ params }) => {
        const itemPath = decodeURIComponent(params['*'])
        return libraryService.getItemProperties(itemPath)
      })
      // Streaming
      .get('/stream/:id', async ({ params, query, set }) => {
        const item = (await libraryService.getItemById(params.id)) as any
        if (!item || !item.path) {
          set.status = 404
          return 'File not found'
        }
        const filePath = await libraryService.getAbsolutePath(item.path)
        if (!filePath) {
          set.status = 404
          return 'File not found'
        }

        // Mark as watched/continue watching when stream starts
        // Fire and forget to not delay the stream
        if (query.watch === '1' || query.watch === 'true') {
          recordPlaybackDebounced(params.id)
        }

        if (filePath.startsWith('http')) {
          return Response.redirect(filePath)
        }
        return Bun.file(filePath)
      })
      .get('/download/:id', async ({ params, set }: { params: any; set: any }) => {
        const item = (await libraryService.getItemById(params.id)) as any
        if (!item || !item.path) {
          set.status = 404
          return 'File not found'
        }
        const filePath = await libraryService.getAbsolutePath(item.path)
        if (!filePath || !fs.existsSync(filePath)) {
          set.status = 404
          return 'File not found'
        }
        const fileName = path.basename(filePath)
        // Explicitly construct Response to ensure headers are handled correctly for file downloads in Elysia/Bun
        return new Response(Bun.file(filePath), {
          headers: {
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Type': 'application/octet-stream'
          }
        })
      })
      .get('/stream/:id/:filename', async ({ params, query, set }) => {
        const item = (await libraryService.getItemById(params.id)) as any
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

        // Mark as watched/continue watching when stream starts
        if (query.watch === '1' || query.watch === 'true') {
          recordPlaybackDebounced(params.id)
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
            const params = new URLSearchParams()
            if (token) params.set('token', token)
            params.set('watch', '1')

            const fullUrl = `${streamUrl}?${params.toString()}`
            m3uContent += `${fullUrl}\n`
          }

          set.headers['Content-Type'] = 'audio/x-mpegurl'
          return m3uContent
        } catch (e: any) {
          set.status = 500
          return { error: e.message || 'Error' }
        }
      })
      .post('/resolve-media-source-path', async ({ body }: { body: any }) => ({
        path: await settingsService.resolveMediaSourcePath(
          body.path,
          body.isRelative,
          body.libraryLocation
        )
      }))
      .post('/execute-custom-action', async ({ body }: { body: any }) => {
        await libraryService.executeCustomAction(body.itemId, body.commandId, (opt) =>
          console.log(opt)
        )
        return { success: true }
      })
      .get('/settings', async () => {
        const settings = await settingsService.readSettings()
        const sanitized = { ...settings }
        delete (sanitized as any).adminPasswordHash
        // Strip player commands for web clients to prevent launching on server
        sanitized.playerCommands = []
        return sanitized
      })
      .post('/save-settings', async ({ body }: { body: any }) => {
        const oldSettings = await settingsService.readSettings()
        await settingsService.saveSettingsChanges(body)

        // If library location changed, re-initialize the server's data source
        // but only if it's a local path (remote settings handles its own data).
        if (body.libraryLocation && body.libraryLocation !== oldSettings.libraryLocation) {
          await libraryService.switchToLibrary(body.libraryLocation)
        }

        const newSettings = await settingsService.readSettings()
        const sanitized = { ...newSettings }
        delete (sanitized as any).adminPasswordHash
        webTransport.notifySettingsUpdated(sanitized as any)
        return sanitized
      })
      .get('/library-root', ({ query }) => libraryService.getLibraryRoot(query.path as string))
      .use(v2Routes)
  )

// ... (imports and middleware setup remain the same) ...

// 3. Static Files & Frontend Serving
if (process.env.NODE_ENV === 'production') {
  // --- PRODUCTION PATH DETECTION STRATEGY ---
  // Strategy 1: Look next to the executable (Production / Single Binary)
  // process.execPath is the path to the running binary
  const exeDir = path.dirname(process.execPath)
  const pathSibling = path.join(exeDir, 'out', 'renderer')

  // Strategy 2: Look relative to source (Development / bun run with NODE_ENV=production)
  // import.meta.dir is src/main
  const sourceDir = (import.meta as any).dir
  const pathDev = path.resolve(sourceDir, '../../out/renderer')

  let distPath = ''

  if (fs.existsSync(pathSibling)) {
    console.log(`[Server] Detected production layout. Serving from: ${pathSibling}`)
    distPath = pathSibling
  } else if (fs.existsSync(pathDev)) {
    console.log(`[Server] Detected development layout. Serving from: ${pathDev}`)
    distPath = pathDev
  } else {
    console.error('[Server] CRITICAL: Could not locate frontend assets.')
    // Default to sibling to allow the app to boot, though UI will 404
    distPath = pathSibling
  }

  // Serve static assets (js, css, images)
  app.use(
    staticPlugin({
      assets: distPath,
      prefix: '/'
    })
  )

  // SPA Fallback & Root Handler for Production
  // This wildcard handles '/' and any client-side routes (e.g. /settings)
  app.get('*', () => {
    const indexPath = path.join(distPath, 'index.html')
    if (!fs.existsSync(indexPath)) {
      return new Response(
        "Frontend not found. Please ensure 'out/renderer' exists next to the executable.",
        { status: 404 }
      )
    }
    return Bun.file(indexPath)
  })
} else {
  // --- DEVELOPMENT MODE ---
  // Only define this specific '/' handler in development.
  // In production, the '*' handler above covers it.
  app.get('/', () => {
    return `
      <html>
        <head><title>Media Browser Backend</title></head>
        <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #121212; color: #fff;">
          <h1>🦊 Media Browser Backend is running</h1>
          <p>This is the API server. To view the app, open <a href="http://localhost:3000" style="color: #4facfe;">http://localhost:3000</a> (Vite Dev Server).</p>
        </body>
      </html>
    `
  })
}

async function start() {
  console.log('[Server] Loading database into memory...')
  await libraryService.loadDbIntoMemory()
  console.log('[Server] Database loaded.')

  const settings = await settingsService.readSettings()

  // In production, respect the user's settings.
  // In development, respect the PORT env var (3001) to let Vite own port 3000.
  const finalPort =
    process.env.NODE_ENV === 'production' ? settings.serverPort || 3000 : process.env.PORT || 3001

  app.listen(finalPort, (server) => {
    webTransport.initialize(server)
    console.log(`🦊 Elysia is running at http://${server?.hostname}:${server?.port}`)
  })
}

start().catch((err) => {
  console.error('[Server] Failed to start:', err)
  process.exit(1)
})
