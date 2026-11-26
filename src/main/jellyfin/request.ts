/**
 * Request and response plumbing for the Jellyfin-compatible API.
 * Jellyfin routes, query names and JSON body keys are case-insensitive.
 */
import type { Settings } from '@shared/types'
import type { SessionData } from '../services/auth.service'
import type { AuthTokenDevice } from '../database/repositories/auth-token.repo'

/** Where the Jellyfin-compatible API is served. */
export const JELLYFIN_BASE = '/jellyfin'

/** The name apps show for this server. */
export function serverName(settings: Settings): string {
  return settings.jellyfinServerName?.trim() || 'Kinome'
}

export class JellyfinError extends Error {
  constructor(readonly status: number, message = '') {
    super(message)
  }
}

export const notFound = () => new JellyfinError(404, 'Not found')
export const forbidden = () => new JellyfinError(403, 'Forbidden')
export const badRequest = (message: string) => new JellyfinError(400, message)

export class Query {
  private readonly values = new Map<string, string[]>()

  constructor(search: URLSearchParams) {
    for (const [key, value] of search) {
      const name = key.toLowerCase()
      const list = this.values.get(name)
      if (list) list.push(value)
      else this.values.set(name, [value])
    }
  }

  get(name: string): string | undefined {
    const value = this.values.get(name.toLowerCase())?.[0]
    return value === '' ? undefined : value
  }

  /** Repeated parameters and comma-separated values both form a list. */
  list(name: string, separator: string | RegExp = ','): string[] {
    return (this.values.get(name.toLowerCase()) ?? [])
      .flatMap((value) => value.split(separator)).map((value) => value.trim()).filter(Boolean)
  }

  bool(name: string): boolean | undefined {
    const value = this.get(name)?.toLowerCase()
    return value === 'true' ? true : value === 'false' ? false : undefined
  }

  int(name: string): number | undefined {
    const value = Number(this.get(name))
    return this.get(name) !== undefined && Number.isSafeInteger(value) ? value : undefined
  }
}

/** Reads a JSON body field regardless of the client's key casing. */
export function field<T = unknown>(body: Record<string, unknown> | undefined, name: string): T | undefined {
  if (!body) return undefined
  if (name in body) return body[name] as T
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(body)) if (key.toLowerCase() === lower) return value as T
  return undefined
}

export interface JellyfinRequest {
  request: Request
  url: URL
  /** The public address of the API, including its base path. */
  baseUrl: string
  params: Record<string, string>
  query: Query
  session: SessionData | null
  token?: string
  /** The client's network address. */
  address: string
  device: AuthTokenDevice
  camelCase: boolean
  settings: Settings
  body: () => Promise<Record<string, unknown> | undefined>
}

export type Handler = (request: JellyfinRequest) => unknown

export interface Route {
  method: string
  /** The operation in the pinned OpenAPI document that describes the response. */
  operation: string
  pattern: RegExp
  keys: string[]
  handler: Handler
  public: boolean
  /** Media a client may fetch without credentials after it asked for playback info. See grantedSession. */
  media: boolean
}

/**
 * Declares a route. The path uses the OpenAPI form, such as /Items/{itemId}.
 * An alias path serves the same operation under an older or alternative path.
 */
export function route(method: string, path: string, handler: Handler, options: { public?: boolean; media?: boolean; alias?: string } = {}): Route {
  const keys: string[] = []
  const source = (options.alias ?? path).split(/(\{\w+\})/).map((part) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1]
    if (!key) return part.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
    keys.push(key)
    return '([^/]+)'
  }).join('')
  return { method, operation: `${method} ${path}`, pattern: new RegExp(`^${source}/?$`, 'i'), keys, handler, public: options.public ?? false, media: options.media ?? false }
}

function decode(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

/** Reads the token and client description from the forms Jellyfin clients use. */
export function readAuthorization(request: Request, query: Query): { token?: string; device: AuthTokenDevice } {
  const header = request.headers.get('authorization') ?? request.headers.get('x-emby-authorization') ?? ''
  const fields: Record<string, string> = {}
  if (/^(MediaBrowser|Emby)\s/i.test(header)) {
    for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) fields[match[1].toLowerCase()] = decode(match[2])
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1]
  const token = fields.token || request.headers.get('x-emby-token') || request.headers.get('x-mediabrowser-token') ||
    query.get('api_key') || query.get('apikey') || query.get('token') || bearer || undefined
  return {
    token,
    device: { client: fields.client, deviceId: fields.deviceid, deviceName: fields.device, version: fields.version }
  }
}

/**
 * Jellyfin answers with the first JSON form the Accept header lists, which is
 * PascalCase unless that form names the CamelCase profile. Without an Accept
 * header it answers in PascalCase, which clients such as Moonfin rely on.
 */
export function wantsCamelCase(request: Request): boolean {
  const accept = request.headers.get('accept')
  if (accept === null) return false
  const first = accept.split(',').map((range) => range.trim().toLowerCase())
    .find((range) => range.startsWith('application/json') || range.startsWith('*/*'))
  return !!first && /profile="?camelcase/.test(first)
}

// Dictionary values keep their keys, as in Jellyfin.
const DICTIONARIES = new Set(['ProviderIds', 'ImageTags', 'ImageBlurHashes', 'CustomPrefs', 'RequiredHttpHeaders'])

function camelCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelCase)
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    result[key.charAt(0).toLowerCase() + key.slice(1)] = DICTIONARIES.has(key) ? entry : camelCase(entry)
  }
  return result
}

export function json(request: JellyfinRequest, value: unknown, status = 200): Response {
  return new Response(JSON.stringify(request.camelCase ? camelCase(value) : value), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }
  })
}
