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
import * as listDirectoryService from './services/list-directory.service'
import * as pathsService from './services/paths.service'
import * as repositoryService from './services/repository.service'
import * as navigationService from './services/navigation.service'
import * as groupingService from './services/grouping.service'
import * as virtualFoldersService from './services/virtualFolders.service'
import * as playbackService from './services/playback.service'
import * as handlerService from './services/handler.service'

// --- Security Middleware & Constants ---

const PUBLIC_PATHS = ['/api/login', '/api/check-auth', '/api/setup-admin', '/api/handler-test']

// Simple in-memory rate limiter for login
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>()
const RATE_LIMIT_WINDOW = 15 * 60 * 1000 // 15 mins
const MAX_ATTEMPTS = 10

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
 * 1. Environment Variable (KINOME_DATA) - Best for Docker/Systemd
 * 2. "./data" folder relative to CWD - Best for Portable/Dev use
 * 3. OS Default (AppData/.config) - Best for standard Desktop install
 */
function resolveUserDataPath(): string {
  const appName = 'kinome'

  // 1. Environment Variable
  if (process.env.KINOME_DATA) {
    console.log(`[Startup] Using data path from env: ${process.env.KINOME_DATA}`)
    return process.env.KINOME_DATA
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
    console.error(`Please check permissions or set KINOME_DATA environment variable.`)
    process.exit(1)
  }
}

initializeStartup(userDataPath)
authService.ensureSetupToken()

const webTransport = new WebTransport()
setTransport(webTransport)

// 2. Setup Elysia App
const app = new Elysia()
  .use(cors())
  // Logger Middleware
  .onBeforeHandle(({ request }) => {
    const url = new URL(request.url).pathname
    const range = request.headers.get('range')

    // We only want to filter out high-frequency "noise"
    // Log everything except static assets and subsequent stream chunks (we still log the start of a stream)
    const isStatic = url.startsWith('/api/assets')
    const isStreamChunk = url.startsWith('/api/stream') && range && !range.startsWith('bytes=0-')
    const isInstaller = url.startsWith('/install-kinome-handler')

    if ((url.startsWith('/api/') || isInstaller) && !isStatic && !isStreamChunk) {
      ;(request as any)._startTime = Date.now()
      console.log(`[API] [REQUEST] ${request.method} ${url}`)
    }
  })
  .onAfterHandle(({ request, set }) => {
    const url = new URL(request.url).pathname
    const range = request.headers.get('range')
    const isStatic = url.startsWith('/api/assets')
    const isStreamChunk = url.startsWith('/api/stream') && range && !range.startsWith('bytes=0-')

    if (url.startsWith('/api/') && !isStatic && !isStreamChunk) {
      const start = (request as any)._startTime
      const duration = start ? Date.now() - start : 0
      console.log(
        `[API] [RESPONSE] ${request.method} ${url} - Status: ${set.status || 200} (${duration}ms)`
      )
    }
  })
  .onError(({ code, error, request, set }) => {
    const url = new URL(request.url).pathname

    // Handle "Unauthorized" as a quiet/expected error
    if ((error as any).message === 'Unauthorized') {
      console.log(`[API] [AUTH] ${request.method} ${url} - Access Denied (401)`)
      set.status = 401
      return { error: 'Unauthorized' }
    }

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
      const token = authHeader?.startsWith('Bearer ')
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

      // Immediately send current scan status so the client doesn't start with a blank state
      ws.send(
        JSON.stringify({ type: 'scan-status-changed', data: webTransport.getCurrentStatus() })
      )
    },
    close(ws) {
      console.log(`[WebTransport] Client disconnected: ${ws.id}`)
    }
  })
  // Installer scripts and handler (served as text/plain)
  .get('/install-kinome-handler.ps1', async ({ query, request, set }) => {
    const url = new URL(request.url)
    const secret = (query.secret as string) || url.searchParams.get('secret') || undefined

    let baseUrl = url.origin
    const forwardedProto = request.headers.get('x-forwarded-proto')
    if (forwardedProto === 'https' && baseUrl.startsWith('http://')) {
      baseUrl = baseUrl.replace('http://', 'https://')
    }

    set.headers['Content-Type'] = 'text/plain; charset=utf-8'
    set.headers['Cache-Control'] = 'no-store'

    return handlerService.generateWindowsInstaller(secret, baseUrl)
  })
  .get('/install-kinome-handler.sh', async ({ query, request, set }) => {
    const url = new URL(request.url)
    const secret = (query.secret as string) || url.searchParams.get('secret') || undefined

    let baseUrl = url.origin
    const forwardedProto = request.headers.get('x-forwarded-proto')
    if (forwardedProto === 'https' && baseUrl.startsWith('http://')) {
      baseUrl = baseUrl.replace('http://', 'https://')
    }

    set.headers['Content-Type'] = 'text/plain; charset=utf-8'
    set.headers['Cache-Control'] = 'no-store'

    return handlerService.generateLinuxInstaller(secret, baseUrl)
  })

  .get('/bin/*', ({ params, set }) => {
    // Determine possible paths for binaries
    const exeDir = path.dirname(process.execPath)
    const sourceDir = (import.meta as any).dir

    const possiblePaths = [
      // Production: Sibling of executable
      path.join(exeDir, 'public', 'bin', params['*']),
      // Legacy/Alternative Production Layout
      path.join(exeDir, 'out', 'renderer', 'bin', params['*']),
      // Development: Relative to source
      path.resolve(sourceDir, '../../out/renderer/bin', params['*']),
      // Development: Relative to CWD
      path.join(process.cwd(), 'public', 'bin', params['*'])
    ]

    let binPath = ''
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        binPath = p
        break
      }
    }

    if (!binPath) {
      console.error(`[Server] Binary not found: ${params['*']}`)
      console.error(`[Server] Searched in:`, possiblePaths)
      set.status = 404
      return 'File not found'
    }

    // Set appropriate content type for binaries
    if (binPath.endsWith('.exe')) {
      set.headers['Content-Type'] = 'application/x-msdownload'
    } else {
      set.headers['Content-Type'] = 'application/octet-stream'
    }
    return Bun.file(binPath)
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
          return {
            success: false,
            message: `Too many attempts. Please wait ${rateLimit.waitTime} minutes.`
          }
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
          const { password, unauthenticated, setupToken } = body
          return await authService.setupAdmin(password, unauthenticated, setupToken)
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
      .post('/start-handler-test', ({ body }: { body: any }) => {
        const { sessionId } = body
        if (!sessionId) {
          return { error: 'sessionId required' }
        }
        handlerService.startHandlerTest(sessionId)
        return { success: true }
      })
      .get('/handler-test/:sessionId', ({ params, set }) => {
        const { sessionId } = params

        if (!handlerService.confirmHandlerTest(sessionId)) {
          set.status = 404
          return { error: 'Session not found or expired' }
        }

        webTransport.notifyHandlerTestSuccess(sessionId)
        return { success: true }
      })
      /**
       * --- TODO: Unified Items API Architectural Cleanup ---
       * This entire section is currently a "God Router" that handles excessive business logic.
       * 1. Routes should be thin entry points that delegate to services (e.g., LibraryService).
       * 2. Manual ID normalization (root alias logic) should live in the service layer.
       * 3. Schema validation (TypeBox) is missing on several endpoints, leading to `any` usage.
       * 4. Error handling is inconsistent (manual try-catch + set.status vs global error mapping).
       */
      // --- Unified Items API ---
      .get('/items', ({ query }) => {
        const options = parseFindOptions(query)
        return repositoryService.find(options)
      })
      .get('/items/:id', async ({ params: { id: rawId }, query, set }) => {
        let id = rawId
        if (id === 'root') {
          const status = await navigationService.getLibraryRoot()
          if (status.status !== 'ready') {
            set.status = 404
            return {
              error: 'root_missing',
              message: `Library not ready: ${status.status}`,
              ...status
            }
          }
          id = status.root!.id
        } else if (id === 'home') {
          id = repositoryService.getHomeFolderId()
        }

        const options = parseFindOptions(query)
        options.where = { ...options.where, id }
        options.limit = 1

        /**
         * TODO: [RETARDED_DEFAULT_FIELDS_FALLBACK]
         * This default field list is conceptually broken. The backend should not have an "opinion"
         * on what fields a "detail view" needs—that is strictly a frontend/UI concern.
         *
         * UNFORTUNATELY, the frontend currently depends on this fallback for several views.
         * To fix this, the frontend MUST be updated to explicitly request the fields it needs
         * (via `view-requirements.ts`) before this fallback can be safely removed.
         */
        // Default field fallback
        if (!query.fields) {
          options.fields = [
            ...repositoryService.CORE_FIELDS,
            'overview',
            'backdropPath',
            'logoPath',
            'runtime',
            'releaseDate',
            'genres',
            'tags',
            'virtualTags',
            'viewSettings'
          ]
        }

        const items = repositoryService.find(options)
        if (items.length === 0) {
          set.status = 404
          return { error: 'Item not found' }
        } else {
          const item = items[0]

          // Handle side-channel view hierarchy request
          const include = query.include ? (query.include as string).split(',') : []
          if (include.includes('viewHierarchy')) {
            const hierarchy = await navigationService.resolveViewHierarchy(item.id)
            if (hierarchy) {
              item.viewHierarchy = hierarchy
            }
          }

          return item
        }
      })
      .get(
        '/items/:id/children',
        async ({ params: { id }, query, set }) => {
          const options = parseFindOptions(query)
          const result = await navigationService.getChildren(id, options)

          if ('error' in result) {
            set.status = 404
          }

          return result
        },
        {
          query: t.Object({
            fields: t.Optional(t.String()),
            include: t.Optional(t.String()),
            limit: t.Optional(t.Numeric()),
            offset: t.Optional(t.Numeric()),
            orderBy: t.Optional(t.String()),
            sort: t.Optional(t.String()),
            order: t.Optional(t.String()),
            includeHidden: t.Optional(t.String()),
            includeIgnored: t.Optional(t.String())
          })
        }
      )
      .get('/items/:id/ancestors', async ({ params: { id: rawId }, set }) => {
        let id = rawId
        if (id === 'root') {
          const status = await navigationService.getLibraryRoot()
          if (status.status !== 'ready') {
            set.status = 404
            return {
              error: 'root_missing',
              message: `Library not ready: ${status.status}`,
              ...status
            }
          }
          id = status.root!.id
        } else if (id === 'home') {
          id = repositoryService.getHomeFolderId()
        }

        const ancestors = repositoryService.getAncestors(id)
        return ancestors.filter((a) => a.id !== id)
      })
      .get('/items/:id/credits', ({ params }) => libraryService.getItemCredits(params.id))
      .post('/items/:id/grouping', ({ params: { id }, body }: { params: { id: string }; body: any }) => {
        const { groupByKey } = body as { groupByKey: string | null }
        if (groupByKey) {
          groupingService.applyGrouping(id, groupByKey)
        } else {
          groupingService.removeGrouping(id)
        }
        return { success: true }
      })
      .post('/items/:id/virtual-folders', ({ params: { id: parentId }, body }: { params: { id: string }; body: any }) => {
        const { name, filter } = body as { name: string; filter?: any }
        const newId = virtualFoldersService.createUserVirtualFolder(parentId, name, filter)
        return { id: newId }
      })
      .patch('/items', async ({ body }: { body: any }) => {
        if (body.id === 'home') {
          body.id = repositoryService.getHomeFolderId()
        }
        await libraryService.updateItem(body, true)
        return { success: true }
      })
      // --- End Items API ---
      // Library Endpoints
      .post('/perform-search', ({ body }: { body: any }) => libraryService.performSearch(body))
      .get('/hidden-children/:id', ({ params }) => libraryService.getHiddenChildren(params.id))
      .get('/parent/:id', ({ params }) => libraryService.getParent(params.id))
      .group('/autocomplete', (group) =>
        group
          .get('/suggestions', ({ query }) =>
            libraryService.getAutocompleteSuggestions({
              excludeHidden: query.excludeHidden === 'true'
            })
          )
          .get('/values/:key', ({ params, query }) =>
            libraryService.getAutocompleteValues(
              params.key,
              (query.q as string) || '',
              query.limit ? parseInt(query.limit as string, 10) : 20
            )
          )
      )
      .get('/group-by-keys', () => libraryService.getGroupByKeys())
      .post('/apply-initial-folder-settings', async ({ body }: { body: any }) => {
        await libraryService.applyInitialFolderSettings(body.settings)
        return { success: true }
      })
      .get('/list-directory', async ({ query, set }: { query: any; set: any }) => {
        const { path } = query
        if (!path || typeof path !== 'string') {
          set.status = 400
          return { error: 'Path is required' }
        }

        // Security Check removed: Authenticated users are Admins and need to browse the filesystem to configure the library.
        // The previous check prevented listing folders when changing the media source path.

        return listDirectoryService.listDirectory(path)
      })
      .post('/perform-scan', ({ body }: { body: any }) => libraryService.performScan(body))
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
      .get('/stream/:id', async ({ params, query, set, request }) => {
        // Mark as watched/continue watching when stream starts (fire and forget)
        if (query.watch === '1' || query.watch === 'true') {
          playbackService.recordPlaybackDebounced(params.id, libraryService.recordPlayback)
        }

        const rangeHeader = request.headers.get('range')
        const response = await playbackService.handleCachedStream(params.id, rangeHeader)

        if (!response) {
          set.status = 404
          return 'File not found'
        }

        return response
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
        // Explicitly construct Response to ensure headers are handled correctly for file downloads in Elysia/Bun.
        return new Response(Bun.file(filePath), {
          headers: {
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Type': 'application/octet-stream'
          }
        })
      })
      .get('/stream/:id/:filename', async ({ params, query, set, request }) => {
        // Mark as watched/continue watching when stream starts (fire and forget)
        if (query.watch === '1' || query.watch === 'true') {
          playbackService.recordPlaybackDebounced(params.id, libraryService.recordPlayback)
        }

        const rangeHeader = request.headers.get('range')
        const response = await playbackService.handleCachedStream(params.id, rangeHeader)

        if (!response) {
          set.status = 404
          return 'File not found'
        }

        return response
      })
      .get('/playlist/:id', async ({ params, query, request, set }) => {
        try {
          const url = new URL(request.url)
          const m3uContent = await playbackService.generateM3UPlaylist(
            params.id,
            url.host,
            url.protocol,
            query.token as string | undefined
          )

          if (!m3uContent) {
            set.status = 404
            return 'Item not found'
          }

          set.headers['Content-Type'] = 'audio/x-mpegurl'
          return m3uContent
        } catch (e: any) {
          set.status = 500
          return { error: e.message || 'Error' }
        }
      })
      .post('/resolve-media-source-path', async ({ body }: { body: any }) => {
        return await settingsService.resolveMediaSourcePath(
          body.path,
          body.isRelative,
          body.libraryLocation
        )
      })
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
        return sanitized
      })
      .post('/save-settings', async ({ body }: { body: any }) => {
        const oldSettings = await settingsService.readSettings()
        await settingsService.saveSettingsChanges(body)

        // Clear streaming cache as settings (like media source path) might have changed
        playbackService.clearStreamCache()

        if (body.virtualTags) {
          libraryService.reapplyVirtualTagsAfterSettingsChange().catch(console.error)
        }

        // If library location changed, re-initialize the server's data source
        // but only if it's a local path (remote settings handles its own data).
        if (body.libraryLocation && body.libraryLocation !== oldSettings.libraryLocation) {
          await libraryService.switchToLibrary(body.libraryLocation)
          webTransport.forceRendererReload()
        }

        const newSettings = await settingsService.readSettings()
        const sanitized = { ...newSettings }
        delete (sanitized as any).adminPasswordHash
        webTransport.notifySettingsUpdated(sanitized as any)
        return sanitized
      })
      .get('/library-root', ({ query }) => navigationService.getLibraryRoot(query.path as string))
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

  // Resolve Public Directory (Installers + Binaries)
  const publicSibling = path.join(exeDir, 'public')
  const publicDev = path.resolve(sourceDir, '../../public')
  const publicPath = fs.existsSync(publicSibling) ? publicSibling : publicDev

  if (fs.existsSync(publicPath)) {
    console.log(`[Server] Serving public assets from: ${publicPath}`)
    app.use(
      staticPlugin({
        assets: publicPath,
        prefix: '/'
      })
    )
  }

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

  // Serve static assets (js, css, images) from Frontend build
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
        <head><title>Kinome Backend</title></head>
        <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #121212; color: #fff;">
          <h1>🎬 Kinome Backend is running</h1>
          <p>This is the API server. To view the app, open <a href="http://localhost:3000" style="color: #4facfe;">http://localhost:3000</a> (Vite Dev Server).</p>
        </body>
      </html>
    `
  })
}

/**
 * Helper to parse FindOptions from query
 */
function parseFindOptions(query: any): repositoryService.FindOptions {
  const options: repositoryService.FindOptions = { where: {} }

  if (query.fields) {
    options.fields = (query.fields as string).split(',')
  } else if (query.include) {
    const extraFields = (query.include as string).split(',')
    const uniqueFields = new Set([...repositoryService.CORE_FIELDS, ...extraFields])
    options.fields = Array.from(uniqueFields)
  }

  if (query.limit) {
    options.limit = parseInt(query.limit as string)
  }

  if (query.offset) {
    options.offset = parseInt(query.offset as string)
  }

  if (query.orderBy) {
    const [field, direction] = (query.orderBy as string).split(':')
    options.orderBy = {
      field,
      direction: direction?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
    }
  }

  const reserved = [
    'fields',
    'include',
    'limit',
    'offset',
    'orderBy',
    'sort',
    'order',
    'includeHidden',
    'includeIgnored'
  ]

  for (const [key, value] of Object.entries(query)) {
    if (!reserved.includes(key)) {
      if (value === 'null' || value === 'root') {
        options.where![key] = null
      } else {
        options.where![key] = value
      }
    }
  }

  if (query.sort && !options.orderBy) {
    options.orderBy = {
      field: query.sort as string,
      direction: (query.order as string)?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
    }
  }

  if (query.includeHidden === 'true') {
    options.includeHidden = true
  } else if (query.includeHidden === 'false') {
    options.includeHidden = false
  }

  if (query.includeIgnored === 'true') {
    options.includeIgnored = true
  } else if (query.includeIgnored === 'false') {
    options.includeIgnored = false
  }

  return options
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
  const host = settings.serverHost || '0.0.0.0'

  app.listen({ port: finalPort, hostname: host }, (server) => {
    webTransport.initialize(server)
    console.log(`🦊 Elysia is running at http://${server?.hostname}:${server?.port}`)
  })
}

start().catch((err) => {
  console.error('[Server] Failed to start:', err)
  process.exit(1)
})
