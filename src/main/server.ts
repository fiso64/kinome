import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import path from 'path'
import fs from 'fs'
import compression from 'compression'

import { initializeStartup } from './services/startup.service'
import * as libraryService from './services/library.service'
import * as settingsService from './services/settings.service'
import { resolveLibraryPath } from './services/paths.service'
import { loadDbIntoMemory } from './services/library.service'
import { WebTransport } from './transport/web.transport'
import { setTransport } from './transport.registry'
import { createServer as createViteServer } from 'vite'
import type { MediaFile } from '../shared/types'

const app = express()
const server = createServer(app)
const port = process.env.PORT || 3000

// 1. Initialize Services
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

import v2Router from './routes/v2'

// 2. Middleware
app.use(cors())
app.use(compression())
app.use(express.json({ limit: '50mb' }))
app.use('/api/v2', v2Router)

// 3. Asset Protocol Replacement
// FIX: Use a Regex Literal object. Strings like '/api/assets/(.*)' fail in Express 5.
// Matches /api/assets/ followed by anything. Capture group is in req.params[0].
app.get(/^\/api\/assets\/(.*)/, (req, res) => {
  try {
    const pathParam = req.params[0] as string
    let relativePath = Array.isArray(pathParam) ? pathParam.join('/') : pathParam

    // Express regex params might be encoded or decoded depending on context, 
    // safe decode here to ensure filesystem compatibility.
    relativePath = decodeURIComponent(relativePath)

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
      res.sendFile(fullPath, { dotfiles: 'allow' })
    } else {
      res.status(404).send('Not found')
    }
  } catch (_e) {
    res.status(500).send('Error')
  }
})

// 4. API Endpoints
app.post('/api/perform-search', async (req, res) => {
  const result = await libraryService.performSearch(req.body)
  res.json(result)
})

app.get('/api/library-root', async (_req, res) => {
  const root = await libraryService.getLibraryRoot()
  res.json(root)
})

app.get('/api/item-details/:id', async (req, res) => {
  const details = await libraryService.getItemDetails(req.params.id)
  res.json(details)
})

app.get('/api/item-by-id/:id', async (req, res) => {
  const item = await libraryService.getItemById(req.params.id)
  res.json(item)
})

app.get('/api/children/:id', async (req, res) => {
  const children = await libraryService.getChildren(req.params.id)
  res.json(children)
})

app.get('/api/hidden-children/:id', async (req, res) => {
  const children = await libraryService.getHiddenChildren(req.params.id)
  res.json(children)
})

app.get('/api/parent/:id', async (req, res) => {
  const parent = await libraryService.getParent(req.params.id)
  res.json(parent)
})

app.get('/api/autocomplete-suggestions', async (_req, res) => {
  const suggestions = await libraryService.getAutocompleteSuggestions()
  res.json(suggestions)
})

app.post('/api/user-update-item', async (req, res) => {
  await libraryService.updateItem(req.body, true)
  res.sendStatus(200)
})

app.post('/api/apply-initial-folder-settings', async (req, res) => {
  await libraryService.applyInitialFolderSettings(req.body.settings)
  res.sendStatus(200)
})

// --- Control Operations ---

app.post('/api/perform-initial-scan', async (req, res) => {
  const { path } = req.body
  if (!path || typeof path !== 'string') {
    console.error('[API] /perform-initial-scan: No valid path provided.')
    res.status(400).send('Path is required')
    return
  }
  const root = await libraryService.performInitialScan(path)
  res.json(root)
})

app.post('/api/perform-full-rescan', async (req, res) => {
  const root = await libraryService.performFullRescan(req.body.path)
  res.json(root)
})

app.post('/api/refresh-library', async (_req, res) => {
  const root = await libraryService.refreshLibrary()
  res.json(root)
})

// --- Playback ---

app.post('/api/play-file', async (req, res) => {
  const success = await libraryService.playFile(req.body.file, (opt) => console.log(opt))
  res.json({ success })
})

app.post('/api/play-file-with', async (req, res) => {
  const success = await libraryService.playFileWith(req.body.file, req.body.command, (opt) =>
    console.log(opt)
  )
  res.json({ success })
})

app.post('/api/record-playback', async (req, res) => {
  await libraryService.recordPlayback(req.body.itemId)
  res.sendStatus(204)
})

// --- Metadata & Images ---

app.post('/api/assign-seasons-and-episodes', async (req, res) => {
  const { showId, seasonStrategy, episodeStrategy, fetchMetadata } = req.body
  try {
    await libraryService.assignSeasonsAndEpisodes(
      showId,
      seasonStrategy,
      episodeStrategy,
      fetchMetadata
    )
    res.json({ success: true })
  } catch (error: any) {
    console.error('[API] Failed to assign seasons:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/clear-item-metadata', async (req, res) => {
  const success = await libraryService.clearItemMetadata(req.body.itemId, req.body.childrenOnly)
  res.json({ success })
})

app.post('/api/clear-virtual-folder-metadata', async (req, res) => {
  const success = await libraryService.clearVirtualFolderMetadata(req.body.itemIds)
  res.json({ success })
})

app.post('/api/fetch-credits', async (req, res) => {
  await libraryService.fetchCredits(req.body.itemId)
  res.sendStatus(200)
})

app.post('/api/manual-search', async (req, res) => {
  const settings = await settingsService.readSettings()
  const results = await libraryService.manualSearch(
    req.body.query,
    req.body.type,
    settings.tmdbApiKey,
    req.body.year,
    req.body.tmdbId
  )
  res.json(results)
})

app.post('/api/get-tmdb-images', async (req, res) => {
  const settings = await settingsService.readSettings()
  const results = await libraryService.getTmdbImages(
    req.body.tmdbId,
    req.body.mediaType,
    settings.tmdbApiKey,
    req.body.language
  )
  res.json(results)
})

app.post('/api/user-apply-tmdb-result', async (req, res) => {
  await libraryService.applyManualMatch(req.body.itemId, req.body.result, req.body.mediaType)
  res.sendStatus(200)
})

app.post('/api/user-set-image', async (req, res) => {
  await libraryService.setImage(req.body.itemId, req.body.imageType, req.body.source)
  res.sendStatus(200)
})

app.post('/api/remove-image', async (req, res) => {
  await libraryService.removeImage(req.body.itemId, req.body.imageType)
  res.sendStatus(200)
})

// --- Watched State ---

app.post('/api/mark-watched', async (req, res) => {
  await libraryService.markAsWatched(req.body.itemId)
  res.sendStatus(200)
})

app.post('/api/mark-unwatched', async (req, res) => {
  await libraryService.markAsUnwatched(req.body.itemId)
  res.sendStatus(200)
})

app.get('/api/folder-watched-state/:id', async (req, res) => {
  const state = await libraryService.getFolderWatchedState(req.params.id)
  res.json({ state })
})

// --- Continue Watching ---

app.get('/api/continue-watching-items', async (_req, res) => {
  const items = await libraryService.getContinueWatchingItems()
  res.json(items)
})

app.get('/api/continue-watching-for-show/:id', async (req, res) => {
  const item = await libraryService.getContinueWatchingForShow(req.params.id)
  res.json(item)
})

app.post('/api/dismiss-continue-watching', async (req, res) => {
  await libraryService.setContinueWatchingDismissed(req.body.itemId)
  res.sendStatus(200)
})

app.post('/api/dismiss-next-up', async (req, res) => {
  await libraryService.setNextUpDismissed(req.body.itemId)
  res.sendStatus(200)
})

// --- Filesystem Actions ---

app.post('/api/reveal-in-explorer', async (req, res) => {
  await libraryService.revealInExplorer(req.body.path)
  res.sendStatus(200)
})

app.post('/api/trash-item', async (req, res) => {
  const success = await libraryService.trashItem(req.body.path)
  res.json({ success })
})

app.post('/api/delete-item-from-db', async (req, res) => {
  const success = await libraryService.deleteItemFromDb(req.body.itemId)
  res.json({ success })
})

app.post('/api/rename-item', async (req, res) => {
  const success = await libraryService.renameItem(req.body.oldPath, req.body.newName)
  res.json({ success })
})

// FIX: Replaced string wildcard with Regex. Matches /api/item-properties/ followed by anything.
app.get(/^\/api\/item-properties\/(.*)/, async (req, res) => {
  const pathParam = req.params[0]
  const itemPath = (Array.isArray(pathParam) ? pathParam.join('/') : pathParam) as string
  const props = await libraryService.getItemProperties(itemPath)
  res.json(props)
})

// --- Settings ---

const streamHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const id = req.params.id as string
    const item = (await libraryService.getItemById(id)) as MediaFile | null
    if (!item || !item.path) {
      res.status(404).send('File not found')
      return
    }

    const filePath = await libraryService.getAbsolutePath(item.path)
    if (!filePath) {
      res.status(404).send('File not found')
      return
    }

    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      const lastWatched = item.lastWatched || 0
      if (Date.now() - lastWatched > 60000) {
        libraryService.recordPlayback(id).catch((err) => {
          console.error(`[Server] Failed to record playback for remote item ${id}:`, err)
        })
      }
      res.redirect(filePath)
      return
    }

    res.sendFile(filePath, (err) => {
      if (!err && res.statusCode < 400) {
        libraryService.getItemById(id).then((freshItem) => {
          const lastWatched = freshItem?.lastWatched || 0
          if (Date.now() - lastWatched > 60000) {
            libraryService.recordPlayback(id).catch((recordErr) => {
              console.error(`[Server] Failed to record playback for item ${id}:`, recordErr)
            })
          }
        })
      } else if (err) {
        if (!res.headersSent) {
          console.error(`[Server] Error starting stream for item ${id}:`, err)
        }
      }
    })
  } catch (e) {
    console.error('Error serving stream:', e)
    res.sendStatus(500)
  }
}

app.get(['/api/stream/:id', '/api/stream/:id/:filename'], streamHandler)

app.get('/api/playlist/:id.m3u', async (req, res) => {
  try {
    const playlist = await libraryService.generatePlaylist(req.params.id)
    if (!playlist || playlist.length === 0) {
      res.status(404).send('Item not found')
      return
    }

    const host = req.get('host')
    const protocol = req.protocol

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
      m3uContent += `${protocol}://${host}/api/stream/${item.id}/${filename}\n`
    }

    const firstItem = playlist[0] as any
    let playlistFilename = 'playlist.m3u'
    if (
      firstItem &&
      firstItem.mediaType === 'episode' &&
      typeof firstItem.seasonNumber === 'number' &&
      typeof firstItem.episodeNumber === 'number'
    ) {
      const s = firstItem.seasonNumber.toString().padStart(2, '0')
      const e = firstItem.episodeNumber.toString().padStart(2, '0')
      playlistFilename = `S${s}E${e}.m3u`
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl')
    res.setHeader('Content-Disposition', `attachment; filename="${playlistFilename}"`)
    res.send(m3uContent)
  } catch (e) {
    console.error('Error generating playlist:', e)
    res.sendStatus(500)
  }
})

app.get('/api/library-media-source-path', async (_req, res) => {
  const path = await settingsService.getAbsoluteMediaSourcePath()
  res.json(path)
})

app.post('/api/resolve-media-source-path', async (req, res) => {
  const resolved = await settingsService.resolveMediaSourcePath(req.body.path, req.body.isRelative)
  res.json(resolved)
})

app.post('/api/execute-custom-action', async (req, res) => {
  await libraryService.executeCustomAction(req.body.itemId, req.body.commandId, (opt) =>
    console.log(opt)
  )
  res.sendStatus(200)
})

app.get('/api/settings', async (_req, res) => {
  const settings = await settingsService.readSettings()
  res.json(settings)
})

app.post('/api/save-settings', async (req, res) => {
  await settingsService.saveSettingsChanges(req.body)
  const newSettings = await settingsService.readSettings()
  webTransport.notifySettingsUpdated(newSettings)
  res.json(newSettings)
})

// 5. Initialize Server
async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
      configFile: path.resolve(__dirname, '../../vite.config.mts')
    })
    app.use(vite.middlewares)
  }
  // PRODUCTION: Serve the built static files
  else {
    const distPath = path.resolve(__dirname, '../../out/renderer')
    app.use(express.static(distPath))

    // FIX: Match-All Regex for SPA fallback
    // The previous string '*' is invalid in Express 5.
    // Regex matches anything, ensuring index.html handles the route.
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'))
    })
  }

  console.log('[Server] Loading database into memory...')
  await loadDbIntoMemory()

  webTransport.initialize(server)

  server.listen(port, () => {
    console.log(`[Server] Media Browser Server running at http://localhost:${port}`)
  })
}

start().catch((err) => {
  console.error('[Server] Failed to start:', err)
  process.exit(1)
})