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
import * as accountFilterRepo from './database/repositories/account-filter.repo'
import * as accountFilterService from './services/account-filter.service'
import { setCurrentAccountId } from './request-context'
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

/** Returns a guard config that enforces a single capability on a route group. */
function guardCap(cap: string) {
  return {
    beforeHandle: (ctx: any) => {
      if (!ctx.session?.capabilities?.has(cap)) throw new ForbiddenError()
    }
  }
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
          if (session) {
            setCurrentAccountId(session.accountId)
            return { session }
          }
        }

        // Deny-by-Default
        set.status = 401
        throw new UnauthorizedError()
      })
    )
    // Assets (High-performance streaming)
    .get('/api/assets/*', async ({ params, set }) => {
      try {
        const cacheControl = (params['*'] ?? '').includes('?v=')
          ? 'private, max-age=31536000, immutable'
          : 'private, max-age=3600'
        set.headers['Cache-Control'] = cacheControl

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
        // ── Public / no capability required ────────────────────────────────────
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
        // Business-rule auth: self OR admin — not a simple capability guard
        .post('/accounts/:id/password', async ({ params, body, session, set }: { params: any; body: any; session: any; set: any }) => {
          const isSelf = session?.accountId === params.id
          const isAdmin = session?.capabilities?.has('manageAccounts')
          if (!isSelf && !isAdmin) throw new ForbiddenError()
          const { password } = body as any
          if (!password) {
            set.status = 400
            return { error: 'password is required' }
          }
          await authService.updatePassword(params.id, password)
          return { success: true }
        })
        .post('/start-handler-test', ({ body }: { body: any }) => {
          const { sessionId } = body
          if (!sessionId) return { error: 'sessionId required' }
          handlerService.startHandlerTest(sessionId)
          return { success: true }
        })
        .get('/handler-test/:sessionId', ({ params, set }) => {
          if (!handlerService.confirmHandlerTest(params.sessionId)) {
            set.status = 404
            return { error: 'Session not found or expired' }
          }
          getTransport().notifyHandlerTestSuccess(params.sessionId)
          return { success: true }
        })
        /**
         * --- TODO: Unified Items API Architectural Cleanup ---
         * 1. Routes should be thin entry points — several still contain inline business logic.
         * 2. Root/home alias resolution is duplicated across /items/:id and /items/:id/ancestors;
         *    it should live in the service/navigation layer.
         * 3. Schema validation (TypeBox) is missing on most endpoints, leading to `any` usage.
         */
        // --- Unified Items API (read) ---
        .get('/items', ({ query }: { query: any }) => {
          return repositoryService.find(parseFindOptions(query))
        })
        .get('/items/:id', async ({ params: { id: rawId }, query, set }: { params: { id: string }; query: any; set: any }) => {
          const id = rawId === 'home' ? repositoryService.getHomeFolderId() : rawId

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
          if (!query.fields) {
            options.fields = [
              ...repositoryService.CORE_FIELDS,
              'overview',
              'backdropPath',
              'logoPath',
              'tmdbRuntime',
              'releaseDate',
              'genres',
              'tags',
              'virtualTags',
              'viewSettings',
              'filter'
            ]
          }

          const items = repositoryService.find(options)
          if (items.length === 0) {
            set.status = 404
            return { error: 'Item not found' }
          }

          const item = items[0]
          const include = query.include ? (query.include as string).split(',') : []
          if (include.includes('viewHierarchy')) {
            const hierarchy = await navigationService.resolveViewHierarchy(item.id)
            if (hierarchy) item.viewHierarchy = hierarchy
          }
          return item
        })
        .get(
          '/items/:id/children',
          async ({ params: { id }, query, set }: { params: { id: string }; query: any; set: any }) => {
            const result = await navigationService.getChildren(id, parseFindOptions(query))
            if ('error' in result) set.status = 404
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
        .get('/items/:id/ancestors', ({ params: { id: rawId } }: { params: { id: string } }) => {
          const id = rawId === 'home' ? repositoryService.getHomeFolderId() : rawId
          return repositoryService.getAncestors(id).filter((a) => a.id !== id)
        })
        .get('/items/:id/credits', ({ params }) => libraryService.getItemCredits(params.id))
        // --- End Items API (read) ---
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
        .get('/item-properties/:itemId', ({ params }) => libraryService.getItemProperties(params.itemId))
        // Streaming
        .get('/stream/:id', async ({ params, query, set, request, session }: any) => {
          const watchRequested = query.watch === '1' || query.watch === 'true'
          if (watchRequested && session?.accountId) {
            const userId = session.accountId
            playbackService.recordPlaybackDebounced(params.id, userId, (id: string) => libraryService.recordPlayback(id, userId))
          }
          const response = await playbackService.handleCachedStream(params.id, request.headers.get('range'), {
            method: request.method,
            url: request.url,
            userAgent: request.headers.get('user-agent'),
            watchRequested,
            userId: session?.accountId
          })
          if (!response) { set.status = 404; return 'File not found' }
          return response
        })
        .get('/stream/:id/:filename', async ({ params, query, set, request, session }: any) => {
          const watchRequested = query.watch === '1' || query.watch === 'true'
          if (watchRequested && session?.accountId) {
            const userId = session.accountId
            playbackService.recordPlaybackDebounced(params.id, userId, (id: string) => libraryService.recordPlayback(id, userId))
          }
          const response = await playbackService.handleCachedStream(params.id, request.headers.get('range'), {
            method: request.method,
            url: request.url,
            userAgent: request.headers.get('user-agent'),
            watchRequested,
            userId: session?.accountId
          })
          if (!response) { set.status = 404; return 'File not found' }
          return response
        })
        .get('/download/:id', async ({ params, set, session }: { params: any; set: any; session: any }) => {
          const item = (await libraryService.getItemById(params.id)) as any
          if (!item?.path) { set.status = 404; return 'File not found' }
          const filePath = await libraryService.getAbsolutePathForItem(params.id, session?.accountId)
          if (!filePath || !fs.existsSync(filePath)) { set.status = 404; return 'File not found' }
          return new Response(Bun.file(filePath), {
            headers: {
              'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
              'Content-Type': 'application/octet-stream'
            }
          })
        })
        .get('/playlist/:id', async ({ params, query, request, set }) => {
          const url = new URL(request.url)
          const m3uContent = await playbackService.generateM3UPlaylist(
            params.id, url.host, url.protocol, query.token as string | undefined
          )
          if (!m3uContent) { set.status = 404; return 'Item not found' }
          set.headers['Content-Type'] = 'audio/x-mpegurl'
          return m3uContent
        })
        .get('/settings', async () => settingsService.sanitizeForClient(await settingsService.readSettings()))
        .get('/library-status', ({ query }) => navigationService.getLibraryStatus(query.path as string))

        // ── manageAccounts ──────────────────────────────────────────────────────
        .guard(guardCap('manageAccounts'), (app) =>
          app
            .get('/accounts', () => authService.getAllAccounts())
            .post('/accounts', async ({ body, set }: { body: any; set: any }) => {
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
            .put('/accounts/:id/role', ({ params, body, set }: { params: any; body: any; set: any }) => {
              const { role } = body as any
              if (!role) { set.status = 400; return { error: 'role is required' } }
              authService.updateAccountRole(params.id, role)
              // Admins cannot be filtered — remove any existing filter rule on promotion
              if (role === 'admin') {
                accountFilterRepo.deleteFilterRule(params.id)
                accountFilterRepo.replaceVisibleItems(params.id, [])
              }
              return { success: true }
            })
            .delete('/accounts/:id', ({ params, session, set }: { params: any; session: any; set: any }) => {
              if (params.id === session.accountId) {
                set.status = 400
                return { error: 'Cannot delete your own account' }
              }
              authService.deleteAccount(params.id)
              return { success: true }
            })
            .get('/accounts/:id/filter', ({ params }: { params: any }) => ({
              rule: accountFilterRepo.getFilterRule(params.id)
            }))
            .put('/accounts/:id/filter', ({ params, body, set }: { params: any; body: any; set: any }) => {
              const target = accountRepo.getAccountById(params.id)
              if (!target) { set.status = 404; return { error: 'Account not found' } }
              if (target.role === 'admin') { set.status = 400; return { error: 'Cannot apply a filter to an admin account' } }
              const { mode, filter } = body as any
              if (mode !== 'allow' && mode !== 'deny') { set.status = 400; return { error: 'mode must be "allow" or "deny"' } }
              if (!filter) { set.status = 400; return { error: 'filter is required' } }
              accountFilterRepo.setFilterRule(params.id, mode, filter)
              accountFilterService.rebuildForAccount(params.id)
              return { success: true }
            })
            .delete('/accounts/:id/filter', ({ params }: { params: any }) => {
              accountFilterRepo.deleteFilterRule(params.id)
              accountFilterRepo.replaceVisibleItems(params.id, [])
              return { success: true }
            })
            .post('/accounts/:id/filter/rebuild', ({ params }: { params: any }) => {
              accountFilterService.rebuildForAccount(params.id)
              return { success: true }
            })
        )

        // ── editMetadata ────────────────────────────────────────────────────────
        .guard(guardCap('editMetadata'), (app) =>
          app
            .post('/items/:id/grouping', ({ params: { id }, body }: { params: { id: string }; body: any }) => {
              const { groupByKey } = body as { groupByKey: string | null }
              if (groupByKey) groupingService.applyGrouping(id, groupByKey)
              else groupingService.removeGrouping(id)
              return { success: true }
            })
            .post('/items/:id/virtual-folders', ({ params: { id: parentId }, body }: { params: { id: string }; body: any }) => {
              const { name, filter } = body as { name: string; filter?: any }
              return { id: virtualFoldersService.createUserVirtualFolder(parentId, name, filter) }
            })
            .patch('/items', async ({ body }: { body: any }) => {
              if (body.id === 'home') body.id = repositoryService.getHomeFolderId()
              await libraryService.updateItem(body, true)
              return { success: true }
            })
            .post('/assign-seasons-and-episodes', async ({ body }: { body: any }) => {
              const { showId, seasonStrategy, episodeStrategy, fetchMetadata } = body
              await libraryService.assignSeasonsAndEpisodes(showId, seasonStrategy, episodeStrategy, fetchMetadata)
              return { success: true }
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
            .post('/manual-search', ({ body }: { body: any }) =>
              libraryService.manualSearch(body.query, body.type, body.year, body.tmdbId)
            )
            .post('/get-tmdb-images', ({ body }: { body: any }) =>
              libraryService.getTmdbImages(body.tmdbId, body.mediaType, body.language)
            )
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
            .post('/upload-image', async ({ body }: { body: any }) => {
              const { itemId, imageType, file } = body as { itemId: string; imageType: string; file: File }
              if (!file) throw new Error('No file uploaded')
              await libraryService.uploadImage(itemId, imageType as any, file)
              return { success: true }
            })
            .post('/trash-item', ({ body }: { body: any }) => libraryService.trashItem(body.itemId))
            .post('/delete-item-from-db', ({ body }: { body: any }) => libraryService.deleteItemFromDb(body.itemId))
            .post('/rename-item', ({ body, session }: { body: any; session: any }) =>
              libraryService.renameItem(body.itemId, body.newName, session?.accountId)
            )
            .post('/execute-custom-action', async ({ body, session }: { body: any; session: any }) => {
              await libraryService.executeCustomAction(body.itemId, body.commandId, (opt) => console.log(opt), session?.accountId)
              return { success: true }
            })
        )

        // ── editSettings ────────────────────────────────────────────────────────
        .guard(guardCap('editSettings'), (app) =>
          app
            .get('/list-directory', async ({ query, set }: { query: any; set: any }) => {
              const { path } = query
              if (!path || typeof path !== 'string') { set.status = 400; return { error: 'Path is required' } }
              return listDirectoryService.listDirectory(path)
            })
            .post('/save-source', ({ body }: { body: any }) => libraryService.saveSource(body.source))
            .post('/reveal-in-explorer', async ({ body }: { body: any }) => {
              await libraryService.revealInExplorer(body.path)
              return { success: true }
            })
            .post('/resolve-media-source-path', async ({ body }: { body: any }) =>
              settingsService.resolveMediaSourcePath(body.path, body.isRelative, body.libraryLocation)
            )
            .post('/save-settings', async ({ body }: { body: any }) => {
              const oldSettings = await settingsService.readSettings()
              await settingsService.saveSettingsChanges(body)
              playbackService.clearStreamCache()
              if (body.virtualTags) libraryService.reapplyVirtualTagsAfterSettingsChange().catch(console.error)
              if (body.libraryLocation && body.libraryLocation !== oldSettings.libraryLocation) {
                await libraryService.switchToLibrary(body.libraryLocation)
                getTransport().forceRendererReload()
              }
              const sanitized = settingsService.sanitizeForClient(await settingsService.readSettings())
              getTransport().notifySettingsUpdated(sanitized as any)
              return sanitized
            })
        )

        // ── triggerLibraryScan ──────────────────────────────────────────────────
        .guard(guardCap('triggerLibraryScan'), (app) =>
          app
            .post('/apply-initial-folder-settings', async ({ body }: { body: any }) => {
              await libraryService.applyInitialFolderSettings(body.settings)
              return { success: true }
            })
            .post('/perform-scan', ({ body }: { body: any }) =>
              libraryService.performScan(body.sourceFolderSettings)
            )
        )
    )
}
