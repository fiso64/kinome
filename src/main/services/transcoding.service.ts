import { createHash } from 'node:crypto'
import path from 'node:path'
import { availablePlaybackQualities, isVideoQuality, type PlaybackQuality, type PlaybackWorkerStatus } from '@shared/playback-quality'
import * as accountFilters from './account-filter.service'
import { readSettings } from './settings.service'
import { resolveStreamPath } from './playback.service'

const workerUrl = process.env.KINOME_GOCODER_URL
function readMediaRoots(): string[] | undefined {
  const value = process.env.KINOME_GOCODER_ROOTS
  if (!value) return
  try {
    const roots: unknown = JSON.parse(value)
    if (Array.isArray(roots) && roots.every((root) => typeof root === 'string' && path.isAbsolute(root))) {
      return roots.map((root) => path.resolve(root))
    }
  } catch {}
  console.error('[Playback] KINOME_GOCODER_ROOTS must be a JSON array of absolute paths')
  return []
}

const mediaRoots = readMediaRoots()
const audioQualities = new Set(['original', '128k', '192k', '256k', '320k', '512k'])
const hlsType = 'application/vnd.apple.mpegurl'

export async function getWorkerStatus(): Promise<PlaybackWorkerStatus> {
  if (!workerUrl) return 'unconfigured'
  try {
    const response = await fetch(new URL('/video/ready', workerUrl), {
      signal: AbortSignal.timeout(2_000), redirect: 'error'
    })
    await response.body?.cancel()
    return response.ok ? 'ready' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

function allowsResource(resource: string, quality: PlaybackQuality): boolean {
  if (resource === 'master.m3u8') return true
  const match = /^(audio\/)?\d+\/([a-z0-9]+)\/(index\.m3u8|init\.mp4|segment-\d+\.mp4)$/.exec(resource)
  if (!match) return false
  return match[1]
    ? audioQualities.has(match[2])
    : match[2] === 'original' || (isVideoQuality(quality) && match[2] === quality)
}

function renditionQuality(uri: string): string | undefined {
  return /^\d+\/([^/]+)\/index\.m3u8(?:\?|$)/.exec(uri)?.[1]
}

function attribute(line: string, key: string): string | undefined {
  return new RegExp(`[:,]${key}="([^"]+)"`).exec(line)?.[1]
}

function selectRenditions(lines: string[], quality: PlaybackQuality): string[] {
  const hasRequested = lines.some((line) => renditionQuality(line) === quality)
  const selected = hasRequested ? quality : 'original'
  const variants: string[] = []
  const groups = new Set<string>()
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:') || renditionQuality(lines[i + 1]) !== selected) continue
    variants.push(lines[i], lines[i + 1])
    for (const kind of ['AUDIO', 'VIDEO']) {
      const id = attribute(lines[i], kind)
      if (id) groups.add(id)
    }
  }
  if (!variants.length) throw new Error('No compatible gocoder rendition')
  const tracks = lines.filter((line) => {
    const group = line.startsWith('#EXT-X-MEDIA:') && attribute(line, 'GROUP-ID')
    return group && groups.has(group)
  })
  return ['#EXTM3U', '#EXT-X-VERSION:7', ...tracks, ...variants]
}

export function prepareHlsPlaylist(text: string, resource: string, quality: PlaybackQuality, query: URLSearchParams): string {
  let lines = text.trim().split(/\r?\n/)
  if (lines[0] !== '#EXTM3U') throw new Error('Invalid gocoder playlist')
  if (resource === 'master.m3u8') lines = selectRenditions(lines, quality)

  const base = resource.slice(0, resource.lastIndexOf('/') + 1)
  const rewrite = (uri: string) => {
    const target = uri.split('?', 1)[0]
    if (!allowsResource(base + target, quality)) throw new Error('Unexpected gocoder playlist resource')
    return `${target}?${query}`
  }
  return lines.map((line) => {
    if (line.startsWith('#')) return line.replace(/\bURI="([^"]+)"/g, (_, uri) => `URI="${rewrite(uri)}"`)
    return line ? rewrite(line) : line
  }).join('\n') + '\n'
}

export async function serveHls(
  request: Request,
  itemId: string,
  quality: PlaybackQuality,
  resource: string,
  accountId: string
): Promise<Response> {
  if (!workerUrl) return new Response('Playback conversion worker is unavailable', { status: 503 })
  const settings = await readSettings()
  if (quality === 'original' || !availablePlaybackQualities(settings).includes(quality) || !allowsResource(resource, quality)) {
    return new Response('Playback quality or resource is unavailable', { status: 404 })
  }

  accountFilters.ensureUpToDate(accountId)
  const source = await resolveStreamPath(itemId, accountId)
  if (!source) return new Response('File not found', { status: 404 })
  if (mediaRoots && !mediaRoots.some((root) => source.startsWith(root + path.sep))) {
    return new Response('File is outside the worker media mounts', { status: 503 })
  }

  const params = new URL(request.url).searchParams
  const publicQuery = new URLSearchParams()
  const auth = params.get('token')
  const client = params.get('clientId') ?? 'default'
  if (auth) publicQuery.set('token', auth)
  if (client !== 'default') publicQuery.set('clientId', client)
  const clientId = createHash('sha256').update(JSON.stringify([accountId, itemId, client])).digest('hex')
  const workerPath = '/video' + source
  const headers = new Headers({ 'Accept-Encoding': 'identity' })
  const range = request.headers.get('range')
  if (range && !resource.endsWith('.m3u8')) headers.set('Range', range)

  try {
    const upstream = new URL(`/video/${Buffer.from(workerPath).toString('base64url')}/${resource}`, workerUrl)
    upstream.searchParams.set('clientId', clientId)
    const response = await fetch(upstream, {
      headers, redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)])
    })
    if (!response.ok) {
      await response.body?.cancel()
      const status = response.status === 404 || response.status === 416 ? response.status : 502
      return new Response('Worker could not serve this resource', { status })
    }
    if (resource.endsWith('.m3u8')) {
      const playlist = prepareHlsPlaylist(await response.text(), resource, quality, publicQuery)
      return new Response(request.method === 'HEAD' ? null : playlist, {
        headers: { 'Content-Type': hlsType, 'Cache-Control': 'private, no-store' }
      })
    }
    const outputHeaders = new Headers({ 'Cache-Control': 'private, no-store' })
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = response.headers.get(key)
      if (value) outputHeaders.set(key, value)
    }
    if (request.method === 'HEAD') await response.body?.cancel()
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: outputHeaders })
  } catch {
    return new Response('Playback conversion worker could not return a valid stream', { status: 502 })
  }
}
