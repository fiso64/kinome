/**
 * A Jellyfin-compatible API at /jellyfin, so Jellyfin clients and integrations
 * can use Kinome. It translates to Kinome's services and owns no library data.
 * See docs/jellyfin-api-proposal.md.
 */
import * as authService from '../services/auth.service'
import { runWithAccount } from '../request-context'
import { imageRoutes } from './images'
import { itemRoutes } from './items'
import { libraryRoutes } from './library'
import { grantedSession, playbackRoutes } from './playback'
import { playlistRoutes } from './playlists'
import { serverRoutes } from './server'
import { serveWebClient } from './web'
import * as sessions from './sessions'
import { sessionRoutes, type EventSocket } from './sessions'
import { JellyfinError, Query, json, readAuthorization, wantsCamelCase, type JellyfinRequest, type Route } from './request'

export const JELLYFIN_BASE = '/jellyfin'

interface Server {
  timeout(request: Request, seconds: number): void
  requestIP(request: Request): { address: string } | null
}

let routes: Route[] | undefined
let server: Server | null = null

// Literal paths such as /Items/Latest win over parameters such as /Items/{itemId}.
function allRoutes(): Route[] {
  return routes ??= [
    ...serverRoutes((request) => server?.requestIP(request)?.address ?? '0.0.0.0'),
    ...itemRoutes, ...playbackRoutes, ...imageRoutes, ...libraryRoutes, ...playlistRoutes, ...sessionRoutes
  ].sort((a, b) => a.keys.length - b.keys.length)
}

/** The routes in the order they match, for the conformance tests. */
export function jellyfinRoutes(): readonly Route[] {
  return allRoutes()
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400'
}

function match(method: string, path: string): { route: Route; params: Record<string, string> } | 'method' | undefined {
  let other = false
  for (const route of allRoutes()) {
    const found = route.pattern.exec(path)
    if (!found) continue
    if (route.method !== method) {
      other = true
      continue
    }
    const params: Record<string, string> = {}
    route.keys.forEach((key, index) => { params[key] = decodeURIComponent(found[index + 1]) })
    return { route, params }
  }
  return other ? 'method' : undefined
}

// Unknown routes are worth knowing about, but clients probe some repeatedly.
const reportedUnknown = new Set<string>()

function withCors(response: Response): Response {
  for (const [name, value] of Object.entries(CORS)) if (!response.headers.has(name)) response.headers.set(name, value)
  return response
}

export async function handleJellyfinRequest(request: Request, current: Server | null): Promise<Response> {
  server = current
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  const url = new URL(request.url)
  if (url.protocol === 'http:' && request.headers.get('x-forwarded-proto') === 'https') url.protocol = 'https:'
  const path = url.pathname.slice(JELLYFIN_BASE.length) || '/'
  if (request.method === 'GET' || request.method === 'HEAD') {
    const page = serveWebClient(request, path, url.origin + JELLYFIN_BASE)
    if (page) return page
  }
  const started = performance.now()
  const found = match(request.method, path)
  if (!found || found === 'method') {
    const key = `${request.method} ${path.replace(/[0-9a-f]{32}/gi, '{id}')}`
    if (!reportedUnknown.has(key) && reportedUnknown.size < 500) {
      reportedUnknown.add(key)
      console.warn('[Jellyfin] Unsupported request', { request: key })
    }
    return withCors(new Response(null, { status: found === 'method' ? 405 : 404 }))
  }
  const query = new Query(url.searchParams)
  const { token, device } = readAuthorization(request, query)
  const address = server?.requestIP(request)?.address ?? '0.0.0.0'
  const session = token ? authService.validateToken(token) : found.route.media ? grantedSession(found.params, address) : null
  if (!found.route.public && !session) {
    console.debug(`[Jellyfin] ${found.route.operation} 401`, { client: device.client })
    return withCors(new Response('Unauthorized', { status: 401 }))
  }
  let body: Promise<Record<string, unknown> | undefined> | undefined
  const context: JellyfinRequest = {
    request, url, baseUrl: url.origin + JELLYFIN_BASE, params: found.params, query, session, token, device, address,
    camelCase: wantsCamelCase(request),
    body: () => body ??= request.text().then((text) => text ? JSON.parse(text) : undefined).catch(() => undefined)
  }
  // Media can be read slowly for as long as it plays.
  if (/^\/(videos|items\/[^/]+\/download)/i.test(path)) current?.timeout(request, 0)
  if (session && token) sessions.touch(session, device)
  try {
    const handle = () => found.route.handler(context)
    const result = await (session ? runWithAccount(session.accountId, handle) : handle())
    const response = result instanceof Response ? result : result === undefined ? new Response(null, { status: 204 }) : json(context, result)
    if (!/\.(ts|m4s|mp4)$/.test(path)) {
      console.debug(`[Jellyfin] ${found.route.operation} ${response.status} ${Math.round(performance.now() - started)}ms`)
    }
    return withCors(response)
  } catch (error) {
    if (error instanceof JellyfinError) return withCors(new Response(error.message || null, { status: error.status }))
    if (request.signal.aborted) return new Response(null, { status: 499 })
    console.error('[Jellyfin] Request failed', { request: `${request.method} ${found.route.operation}`, client: device.client, error })
    return withCors(new Response('Kinome could not complete the request.', { status: 500 }))
  }
}

interface Socket extends EventSocket {
  data: { query?: Record<string, string | undefined> }
  close(code?: number, reason?: string): void
}

/** Clients keep a socket open for server events. See events.ts. */
export const jellyfinSocket = {
  open(ws: Socket) {
    const query = ws.data.query ?? {}
    const token = query.api_key ?? query.ApiKey ?? query.apikey
    const session = token ? authService.validateToken(token) : null
    if (!session) {
      ws.close(4401, 'Unauthorized')
      return
    }
    sessions.connect(ws, session)
    ws.send(JSON.stringify({ MessageType: 'ForceKeepAlive', Data: 60 }))
  },
  close(ws: Socket) {
    sessions.disconnect(ws)
  },
  message(ws: Socket, message: unknown) {
    const text = typeof message === 'string' ? message : JSON.stringify(message)
    if (/"MessageType"\s*:\s*"KeepAlive"/.test(text)) ws.send(JSON.stringify({ MessageType: 'KeepAlive' }))
  }
}
