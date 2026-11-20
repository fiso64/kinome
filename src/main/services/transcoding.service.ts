import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { availablePlaybackQualities, isVideoQuality, type PlaybackQuality, type PlaybackWorkerHealth } from '@shared/playback-quality'
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

const workerUnavailable = 'Kinome could not reach the conversion worker. Check that the worker and its PostgreSQL service are running.'

export async function getWorkerStatus(): Promise<PlaybackWorkerHealth> {
  if (!workerUrl) {
    return { status: 'unconfigured', detail: 'This server has no playback conversion worker configured.' }
  }
  const signal = AbortSignal.timeout(2_000)
  try {
    const response = await fetch(new URL('/video/ready', workerUrl), {
      signal, redirect: 'error'
    })
    const health = await response.json().catch(() => null) as { status?: unknown; database?: unknown } | null
    if (signal.aborted) return { status: 'unreachable', detail: 'The worker’s health check timed out.' }
    if (response.ok && health?.status === 'healthy' && health.database === 'healthy') {
      return { status: 'ready', detail: 'The worker and its PostgreSQL database are responding.' }
    }
    if (health?.status === 'unhealthy' && typeof health.database === 'string') {
      return { status: 'unready', detail: 'The worker is running but could not reach its PostgreSQL database.' }
    }
    const detail = response.ok
      ? 'The worker returned an unexpected health response.'
      : `The worker’s health check returned HTTP ${response.status}.`
    return { status: 'unready', detail }
  } catch {
    return {
      status: 'unreachable',
      detail: signal.aborted ? 'The worker’s health check timed out.' : workerUnavailable
    }
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

function eventOpening(lines: string[]): string[] {
  // Start the audio and video near the same timestamp even in players that ignore
  // EXT-X-START and independently choose the end of each growing playlist.
  const targetDuration = Number(lines.find((line) => line.startsWith('#EXT-X-TARGETDURATION:'))?.split(':')[1])
  if (!(targetDuration > 0)) return lines
  let duration = 0
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('#EXTINF:')) continue
    if (duration >= targetDuration) return lines.slice(0, i)
    duration += Number(line.slice(8).split(',', 1)[0])
  }
  return lines
}

function isGrowingEvent(text: string): boolean {
  return text.includes('#EXT-X-PLAYLIST-TYPE:EVENT') && !text.includes('#EXT-X-ENDLIST')
}

export function prepareHlsPlaylist(
  text: string, resource: string, quality: PlaybackQuality, query: URLSearchParams, opening = false
): string {
  let lines = text.trim().split(/\r?\n/)
  if (lines[0] !== '#EXTM3U') throw new Error('Invalid gocoder playlist')
  if (resource === 'master.m3u8') lines = selectRenditions(lines, quality)
  else if (opening && isGrowingEvent(text)) lines = eventOpening(lines)

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

// Keep the opening response consistent per rendition. Later EVENT responses can only grow.
const eventViewers = new Map<string, number>()
const eventViewerLifetime = 60 * 60_000
const maxEventViewers = 4096

function rememberEventViewer(id: string, now: number): void {
  eventViewers.delete(id)
  eventViewers.set(id, now + eventViewerLifetime)
  for (const [viewer, expires] of eventViewers) {
    if (expires > now && eventViewers.size <= maxEventViewers) break
    eventViewers.delete(viewer)
  }
}

function playlistResponse(request: Request, playlist: string): Response {
  const headers = new Headers({
    'Content-Type': hlsType,
    'Cache-Control': 'private, no-store',
    Vary: 'Accept-Encoding'
  })
  const acceptsGzip = request.headers.get('accept-encoding')?.split(',').some((entry) => {
    const [encoding, quality] = entry.trim().toLowerCase().split(/\s*;\s*/, 2)
    return encoding === 'gzip' && (quality === undefined || Number(quality.slice(2)) > 0)
  })
  const gzip = playlist.length > 2048 && acceptsGzip
  if (gzip) headers.set('Content-Encoding', 'gzip')
  return new Response(request.method === 'HEAD' ? null : gzip ? Bun.gzipSync(playlist, { level: 1 }) : playlist, { headers })
}

let lastWorkerWarning: number | undefined

function hlsError(status: number, detail: string): Response {
  return new Response(detail, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

export async function serveHls(
  request: Request,
  itemId: string,
  quality: PlaybackQuality,
  resource: string,
  accountId: string
): Promise<Response> {
  if (!workerUrl) return hlsError(503, 'This server has no playback conversion worker configured.')
  const settings = await readSettings()
  if (quality === 'original' || !availablePlaybackQualities(settings).includes(quality) || !allowsResource(resource, quality)) {
    return hlsError(404, 'This playback quality or resource is unavailable.')
  }

  accountFilters.ensureUpToDate(accountId)
  const source = await resolveStreamPath(itemId, accountId)
  if (!source) return hlsError(404, 'File not found.')
  if (mediaRoots && !mediaRoots.some((root) => source.startsWith(root + path.sep))) {
    return hlsError(503, 'The file is outside the conversion worker’s media mounts.')
  }

  const params = new URL(request.url).searchParams
  const publicQuery = new URLSearchParams()
  const auth = params.get('token')
  const client = params.get('clientId') ?? 'default'
  if (auth) publicQuery.set('token', auth)
  // Opening a saved master URL again creates a fresh viewer for its media playlists.
  if (resource === 'master.m3u8') publicQuery.set('clientId', randomUUID())
  else if (client !== 'default') publicQuery.set('clientId', client)
  // Gocoder tracks one audio and one video rendition per client and stops the previous
  // encoder when it sees a switch. HLS players can probe several renditions at once.
  const rendition = resource.slice(0, resource.lastIndexOf('/'))
  const clientId = createHash('sha256').update(JSON.stringify([accountId, itemId, client, rendition])).digest('hex')
  const workerPath = '/video' + source
  const headers = new Headers({ 'Accept-Encoding': 'identity' })
  const range = request.headers.get('range')
  if (range && !resource.endsWith('.m3u8')) headers.set('Range', range)

  function workerFailure(status: number, detail: string, reason: string): Response {
    const now = Date.now()
    if (!request.signal.aborted && (lastWorkerWarning === undefined || now - lastWorkerWarning >= 30_000)) {
      lastWorkerWarning = now
      console.warn('[Playback] Conversion request failed', { itemId, quality, resource, reason })
    }
    return hlsError(status, detail)
  }

  const timeout = AbortSignal.timeout(90_000)
  let response: Response
  try {
    const upstream = new URL(`/video/${Buffer.from(workerPath).toString('base64url')}/${resource}`, workerUrl)
    upstream.searchParams.set('clientId', clientId)
    response = await fetch(upstream, {
      headers, redirect: 'error', signal: AbortSignal.any([request.signal, timeout])
    })
  } catch {
    return timeout.aborted
      ? workerFailure(504, 'The conversion worker took too long to respond.', 'timeout')
      : workerFailure(503, workerUnavailable, 'connection failed')
  }
  if (!response.ok) {
    await response.body?.cancel()
    const status = response.status === 404 || response.status === 416 ? response.status : 502
    const detail = response.status === 404 && resource === 'master.m3u8'
      ? 'The conversion worker could not find or open this media file.'
      : `The conversion worker could not serve this stream (HTTP ${response.status}).`
    return workerFailure(status, detail, `upstream HTTP ${response.status}`)
  }
  if (resource.endsWith('.m3u8')) {
    try {
      const text = await response.text()
      const now = Date.now()
      const growingEvent = resource !== 'master.m3u8' && isGrowingEvent(text)
      const opening = growingEvent && (eventViewers.get(clientId) ?? 0) <= now
      const playlist = prepareHlsPlaylist(text, resource, quality, publicQuery, opening)
      if (growingEvent && request.method === 'GET') rememberEventViewer(clientId, now)
      else if (!growingEvent) eventViewers.delete(clientId)
      return playlistResponse(request, playlist)
    } catch {
      return timeout.aborted
        ? workerFailure(504, 'The conversion worker took too long to respond.', 'timeout')
        : workerFailure(502, 'The conversion worker returned an invalid playlist.', 'invalid playlist')
    }
  }
  const outputHeaders = new Headers({ 'Cache-Control': 'private, no-store' })
  for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = response.headers.get(key)
    if (value) outputHeaders.set(key, value)
  }
  if (request.method === 'HEAD') await response.body?.cancel()
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: outputHeaders })
}
