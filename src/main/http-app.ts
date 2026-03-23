/**
 * Elysia HTTP app factory.
 *
 * Separated from server.ts so tests can import `buildApp` without triggering
 * the startup/listen side-effects in server.ts.
 */
import { Elysia, t } from 'elysia'
import { cors } from '@elysiajs/cors'
import path from 'path'
import fs from 'fs'

import * as libraryService from './services/library.service'
import * as settingsService from './services/settings.service'
import { resolveLibraryPath } from './services/paths.service'
import * as authService from './services/auth.service'
import * as listDirectoryService from './services/list-directory.service'
import * as repositoryService from './services/repository.service'
import * as navigationService from './services/navigation.service'
import * as groupingService from './services/grouping.service'
import * as virtualFoldersService from './services/virtualFolders.service'
import * as playbackService from './services/playback.service'
import * as handlerService from './services/handler.service'
import * as accountRepo from './database/repositories/account.repo'
import { getTransport } from './transport.registry'

// --- Security Middleware & Constants ---

export const PUBLIC_PATHS = ['/api/login', '/api/check-auth', '/api/setup-admin', '/api/handler-test', '/api/users']

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
      if (value === 'null') {
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

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}

/** Throws if the session lacks the given capability. Results in 403. */
function requireCap(session: any, cap: string) {
  if (!session?.capabilities?.has(cap)) throw new ForbiddenError()
}

export function buildApp() {
  return new Elysia()
    .use(cors())
    // Logger Middleware
    .onBeforeHandle(({ request }) => {
      const url = new URL(request.url).pathname
      const range = request.headers.get('range')

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

      // 401 — not authenticated (no valid token)
      if (error instanceof UnauthorizedError) {
        console.log(`[API] [AUTH] ${request.method} ${url} - Unauthenticated (401)`)
        set.status = 401
        return { error: 'Unauthorized' }
      }

      // 403 — authenticated but lacks the required capability
      if (error instanceof ForbiddenError) {
        console.log(`[API] [AUTH] ${request.method} ${url} - Forbidden (403)`)
        set.status = 403
        return { error: 'Forbidden' }
      }

      console.error(`[API] [ERROR] ${request.method} ${url} - Code: ${code}`)
      console.error(error)
      set.status = 500
      return { error: (error as any).message || 'Internal Server Error' }
    })
    // Auth Plugin (Deny-by-Default)
    .use((app) =>
      app.derive(({ request, set }) => {
        const url = new URL(request.url).pathname

        // Skip non-API/WS routes (frontend assets)
        if (!url.startsWith('/api') && !url.startsWith('/ws')) return { session: null as any }

        // Check Whitelist
        const isPublic = PUBLIC_PATHS.some((p) => url.startsWith(p))
        if (isPublic) return { session: null as any }

        // Check Token
        const authHeader = request.headers.get('authorization')
        const token = authHeader?.startsWith('Bearer ')
          ? authHeader.substring(7)
          : new URL(request.url).searchParams.get('token')

        if (token) {
          const session = authService.validateToken(token)
          if (session) return { session }
        }

        // Deny-by-Default
        set.status = 401
        throw new UnauthorizedError()
      })
    )
    // Assets (High-performance streaming)
    .get('/api/assets/*', async ({ params, set }) => {
      try {
        let relativePath = decodeURIComponent(params['*'])
        if (relativePath.includes('?')) {
          relativePath = relativePath.split('?')[0]
        }

        const fullPath = resolveLibraryPath(relativePath)

        if (!fullPath || !fs.existsSync(fullPath)) {
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
        .get('/users', () =>
          accountRepo.getAllAccounts().map((a) => ({ id: a.id, username: a.username }))
        )
        .get('/check-auth', async ({ request }) => {
          const authHeader = request.headers.get('authorization')
          const token = authHeader?.startsWith('Bearer ')
            ? authHeader.substring(7)
            : new URL(request.url).searchParams.get('token')
          return authService.getAuthState(token || undefined)
        })
        .post('/login', async ({ body, set, request }: { body: any; set: any; request: Request }) => {
          const ip = (request as any).ip || '0.0.0.0'
          const rateLimit = checkRateLimit(ip)
          if (!rateLimit.allowed) {
            set.status = 429
            return {
              authenticated: false,
              needsSetup: false,
              message: `Too many attempts. Please wait ${rateLimit.waitTime} minutes.`
            }
          }

          const { username, password } = body
          if (!username || !password) {
            set.status = 400
            return { authenticated: false, needsSetup: false, message: 'Username and password required' }
          }
          const result = await authService.login(username, password)
          if (result) {
            resetRateLimit(ip)
            const session = authService.validateToken(result.token)
            return {
              authenticated: true,
              needsSetup: false,
              token: result.token,
              account: { ...result.account, capabilities: session ? [...session.capabilities] : [] }
            }
          } else {
            recordFailedAttempt(ip)
            set.status = 401
            return { authenticated: false, needsSetup: false, message: 'Invalid username or password' }
          }
        })
        .post('/setup-admin', async ({ body }: { body: any }) => {
          try {
            const { setupToken, username, password } = body
            const result = await authService.setupFirstAdmin(setupToken, username, password)
            const session = authService.validateToken(result.token)
            return {
              authenticated: true,
              needsSetup: false,
              token: result.token,
              account: { ...result.account, capabilities: session ? [...session.capabilities] : [] }
            }
          } catch (error: any) {
            return { authenticated: false, needsSetup: false, message: error.message }
          }
        })
        .post('/change-password', async ({ body, session }: { body: any; session: any }) => {
          const { password } = body
          if (!password || !session?.accountId) {
            return { success: false, message: 'Password required' }
          }
          await authService.updatePassword(session.accountId, password)
          return { success: true }
        })
        .get('/accounts', ({ session }: { session: any }) => {
          requireCap(session, 'manageAccounts')
          return authService.getAllAccounts()
        })
        .post('/accounts', async ({ body, session, set }: { body: any; session: any; set: any }) => {
          requireCap(session, 'manageAccounts')
          const { username, password, role } = body
          if (!username || !password || !role) {
            set.status = 400
            return { error: 'username, password, and role are required' }
          }
          try {
            return await authService.createAccount(username, password, role)
          } catch (err: any) {
            set.status = 409
            return { error: err.message }
          }
        })
        .put('/accounts/:id/role', ({ params, body, session, set }: { params: any; body: any; session: any; set: any }) => {
          requireCap(session, 'manageAccounts')
          const { role } = body as any
          if (!role) {
            set.status = 400
            return { error: 'role is required' }
          }
          authService.updateAccountRole(params.id, role)
          return { success: true }
        })
        .post('/accounts/:id/password', async ({ params, body, session, set }: { params: any; body: any; session: any; set: any }) => {
          const isSelf = session?.accountId === params.id
          const isAdmin = session?.capabilities?.has('manageAccounts')
          if (!isSelf && !isAdmin) {
            throw new ForbiddenError()
          }
          const { password } = body as any
          if (!password) {
            set.status = 400
            return { error: 'password is required' }
          }
          await authService.updatePassword(params.id, password)
          return { success: true }
        })
        .delete('/accounts/:id', ({ params, session, set }: { params: any; session: any; set: any }) => {
          requireCap(session, 'manageAccounts')
          if (params.id === session.accountId) {
            set.status = 400
            return { error: 'Cannot delete your own account' }
          }
          authService.deleteAccount(params.id)
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

          getTransport().notifyHandlerTestSuccess(sessionId)
          return { success: true }
        })
        /**
         * --- TODO: Unified Items API Architectural Cleanup ---
         * 1. Routes should be thin entry points — several still contain inline business logic.
         * 2. Root/home alias resolution is duplicated across /items/:id and /items/:id/ancestors;
         *    it should live in the service/navigation layer.
         * 3. Schema validation (TypeBox) is missing on most endpoints, leading to `any` usage.
         */
        // --- Unified Items API ---
        .get('/items', ({ query, session }: { query: any; session: any }) => {
          const options = parseFindOptions(query)
          options.userId = session?.accountId
          return repositoryService.find(options)
        })
        .get('/items/:id', async ({ params: { id: rawId }, query, set, session }: { params: { id: string }; query: any; set: any; session: any }) => {
          let id = rawId
          if (id === 'home') {
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

          options.userId = session?.accountId
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
          async ({ params: { id }, query, set, session }: { params: { id: string }; query: any; set: any; session: any }) => {
            const options = parseFindOptions(query)
            options.userId = session?.accountId
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
        .get('/items/:id/ancestors', async ({ params: { id: rawId } }) => {
          let id = rawId
          if (id === 'home') {
            id = repositoryService.getHomeFolderId()
          }

          const ancestors = repositoryService.getAncestors(id)
          return ancestors.filter((a) => a.id !== id)
        })
        .get('/items/:id/credits', ({ params }) => libraryService.getItemCredits(params.id))
        .post('/items/:id/grouping', ({ params: { id }, body, session }: { params: { id: string }; body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          const { groupByKey } = body as { groupByKey: string | null }
          if (groupByKey) {
            groupingService.applyGrouping(id, groupByKey)
          } else {
            groupingService.removeGrouping(id)
          }
          return { success: true }
        })
        .post('/items/:id/virtual-folders', ({ params: { id: parentId }, body, session }: { params: { id: string }; body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          const { name, filter } = body as { name: string; filter?: any }
          const newId = virtualFoldersService.createUserVirtualFolder(parentId, name, filter)
          return { id: newId }
        })
        .patch('/items', async ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
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
        .post('/apply-initial-folder-settings', async ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'triggerLibraryScan')
          await libraryService.applyInitialFolderSettings(body.settings)
          return { success: true }
        })
        .get('/list-directory', async ({ query, set, session }: { query: any; set: any; session: any }) => {
          requireCap(session, 'editSettings')
          const { path } = query
          if (!path || typeof path !== 'string') {
            set.status = 400
            return { error: 'Path is required' }
          }
          return listDirectoryService.listDirectory(path)
        })
        .post('/save-source', ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editSettings')
          return libraryService.saveSource(body.source)
        })
        .post('/perform-scan', ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'triggerLibraryScan')
          return libraryService.performScan(body.sourceFolderSettings)
        })
        .post('/play-file', ({ body }: { body: any }) =>
          libraryService.playFile(body.file, (opt) => console.log(opt))
        )
        .post('/play-file-with', ({ body }: { body: any }) =>
          libraryService.playFileWith(body.file, body.command, (opt) => console.log(opt))
        )
        .post('/record-playback', async ({ body, session }: { body: any; session: any }) => {
          await libraryService.recordPlayback(body.itemId, session.accountId)
          return { success: true }
        })
        .post('/assign-seasons-and-episodes', async ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          const { showId, seasonStrategy, episodeStrategy, fetchMetadata } = body
          await libraryService.assignSeasonsAndEpisodes(showId, seasonStrategy, episodeStrategy, fetchMetadata)
          return { success: true }
        })
        .post('/clear-item-metadata', ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          return libraryService.clearItemMetadata(body.itemId, body.childrenOnly)
        })
        .post('/clear-virtual-folder-metadata', ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          return libraryService.clearVirtualFolderMetadata(body.itemIds)
        })
        .post('/fetch-credits', async ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          await libraryService.fetchCredits(body.itemId)
          return { success: true }
        })
        .post('/manual-search', ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          return libraryService.manualSearch(body.query, body.type, body.year, body.tmdbId)
        })
        .post('/get-tmdb-images', ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          return libraryService.getTmdbImages(body.tmdbId, body.mediaType, body.language)
        })
        .post('/user-apply-tmdb-result', async ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          await libraryService.applyManualMatch(body.itemId, body.result, body.mediaType)
          return { success: true }
        })
        .post('/user-set-image', async ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          await libraryService.setImage(body.itemId, body.imageType, body.source)
          return { success: true }
        })
        .post('/remove-image', async ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          await libraryService.removeImage(body.itemId, body.imageType)
          return { success: true }
        })
        .post('/upload-image', async ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          const { itemId, imageType, file } = body as { itemId: string; imageType: string; file: File }
          if (!file) throw new Error('No file uploaded')
          await libraryService.uploadImage(itemId, imageType as any, file)
          return { success: true }
        })
        .post('/mark-watched', async ({ body, session }: { body: any; session: any }) => {
          await libraryService.markAsWatched(body.itemId, session.accountId)
          return { success: true }
        })
        .post('/mark-unwatched', async ({ body, session }: { body: any; session: any }) => {
          await libraryService.markAsUnwatched(body.itemId, session.accountId)
          return { success: true }
        })
        .get('/folder-watched-state/:id', async ({ params, session }: { params: any; session: any }) => {
          const state = await libraryService.getFolderWatchedState(params.id, session.accountId)
          return { state }
        })
        .get('/continue-watching-items', ({ session }: { session: any }) =>
          libraryService.getContinueWatchingItems(session.accountId)
        )
        .get('/continue-watching-for-show/:id', ({ params, session }: { params: any; session: any }) =>
          libraryService.getContinueWatchingForShow(params.id, session.accountId)
        )
        .post('/dismiss-continue-watching', async ({ body, session }: { body: any; session: any }) => {
          await libraryService.setContinueWatchingDismissed(body.itemId, session.accountId)
          return { success: true }
        })
        .post('/dismiss-next-up', async ({ body, session }: { body: any; session: any }) => {
          await libraryService.setNextUpDismissed(body.itemId, session.accountId)
          return { success: true }
        })
        .post('/reveal-in-explorer', async ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editSettings')
          await libraryService.revealInExplorer(body.path)
          return { success: true }
        })
        .post('/trash-item', ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          return libraryService.trashItem(body.itemId)
        })
        .post('/delete-item-from-db', ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          return libraryService.deleteItemFromDb(body.itemId)
        })
        .post('/rename-item', ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          return libraryService.renameItem(body.itemId, body.newName)
        })
        .get('/item-properties/:itemId', async ({ params }) => {
          return libraryService.getItemProperties(params.itemId)
        })
        // Streaming
        .get('/stream/:id', async ({ params, query, set, request, session }: any) => {
          if ((query.watch === '1' || query.watch === 'true') && session?.accountId) {
            const userId = session.accountId
            playbackService.recordPlaybackDebounced(params.id, (id: string) => libraryService.recordPlayback(id, userId))
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
          const filePath = await libraryService.getAbsolutePathForItem(params.id)
          if (!filePath || !fs.existsSync(filePath)) {
            set.status = 404
            return 'File not found'
          }
          const fileName = path.basename(filePath)
          return new Response(Bun.file(filePath), {
            headers: {
              'Content-Disposition': `attachment; filename="${fileName}"`,
              'Content-Type': 'application/octet-stream'
            }
          })
        })
        .get('/stream/:id/:filename', async ({ params, query, set, request, session }: any) => {
          if ((query.watch === '1' || query.watch === 'true') && session?.accountId) {
            const userId = session.accountId
            playbackService.recordPlaybackDebounced(params.id, (id: string) => libraryService.recordPlayback(id, userId))
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
        })
        .post('/resolve-media-source-path', async ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editSettings')
          return await settingsService.resolveMediaSourcePath(
            body.path,
            body.isRelative,
            body.libraryLocation
          )
        })
        .post('/execute-custom-action', async ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editMetadata')
          await libraryService.executeCustomAction(body.itemId, body.commandId, (opt) =>
            console.log(opt)
          )
          return { success: true }
        })
        .get('/settings', async () => settingsService.sanitizeForClient(await settingsService.readSettings()))
        .post('/save-settings', async ({ body, session }: { body: any; session: any }) => {
          requireCap(session, 'editSettings')
          const oldSettings = await settingsService.readSettings()
          await settingsService.saveSettingsChanges(body)

          playbackService.clearStreamCache()

          if (body.virtualTags) {
            libraryService.reapplyVirtualTagsAfterSettingsChange().catch(console.error)
          }

          if (body.libraryLocation && body.libraryLocation !== oldSettings.libraryLocation) {
            await libraryService.switchToLibrary(body.libraryLocation)
            getTransport().forceRendererReload()
          }

          const sanitized = settingsService.sanitizeForClient(await settingsService.readSettings())
          getTransport().notifySettingsUpdated(sanitized as any)
          return sanitized
        })
        .get('/library-status', ({ query }) => navigationService.getLibraryStatus(query.path as string))
    )
}
