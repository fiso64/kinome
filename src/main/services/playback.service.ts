import type { PlaybackQuality } from '@shared/playback-quality'
import path from 'path'
import * as repositoryService from './repository.service'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import * as itemsRepo from '../database/repositories/filesystem.repo'
import type { LibraryItem, MediaFile } from '@shared/types'

// --- Playback Tracking ---

const VERBOSE_VALUES = new Set(['1', 'true', 'yes', 'on', 'debug', 'trace', 'verbose'])

function isVerbosePlaybackLoggingEnabled(): boolean {
  return (
    VERBOSE_VALUES.has((process.env.KINOME_VERBOSE || '').toLowerCase()) ||
    VERBOSE_VALUES.has((process.env.KINOME_LOG_LEVEL || '').toLowerCase()) ||
    process.argv.includes('--verbose')
  )
}

function logVerbose(message: string, details?: Record<string, unknown>): void {
  if (!isVerbosePlaybackLoggingEnabled()) return

  const prefix = `[${new Date().toISOString()}] [Playback] [verbose] ${message}`
  if (details) {
    console.log(prefix, details)
  } else {
    console.log(prefix)
  }
}

function getItemLogInfo(itemId: string): Record<string, unknown> {
  if (!isVerbosePlaybackLoggingEnabled()) return { itemId }

  const item = repositoryService.getItemById(itemId) as any

  return {
    itemId,
    itemName: item?.name,
    itemTitle: item?.title,
    itemPath: item?.path
  }
}

function redactSensitiveUrl(url: string): string {
  try {
    const parsed = new URL(url)
    for (const key of ['token', 'auth', 'access_token']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '[redacted]')
    }
    return parsed.toString()
  } catch {
    return url.replace(/([?&](?:token|auth|access_token)=)[^&]*/gi, '$1[redacted]')
  }
}

function getSafeLogContext(context?: StreamRequestLogContext): StreamRequestLogContext | undefined {
  if (!context) return undefined
  return {
    ...context,
    url: context.url ? redactSensitiveUrl(context.url) : context.url
  }
}

// Stream playback debounce to prevent DB spam on range requests
const playbackDebounce = new Map<string, number>()
const PLAYBACK_DEBOUNCE_WINDOW = 1 * 10 * 1000 // 10 seconds

export function recordPlaybackDebounced(
  itemId: string,
  userId: string,
  recordPlaybackFn: (itemId: string) => Promise<void>
) {
  const now = Date.now()
  const key = `${userId}:${itemId}`
  const last = playbackDebounce.get(key) || 0
  const elapsedMs = last ? now - last : null
  if (now - last > PLAYBACK_DEBOUNCE_WINDOW) {
    playbackDebounce.set(key, now)
    logVerbose('Recording playback after stream request.', {
      ...getItemLogInfo(itemId),
      userId,
      elapsedMs,
      debounceWindowMs: PLAYBACK_DEBOUNCE_WINDOW
    })
    recordPlaybackFn(itemId).catch(console.error)
  } else {
    logVerbose('Skipped playback recording inside debounce window.', {
      ...getItemLogInfo(itemId),
      userId,
      elapsedMs,
      debounceWindowMs: PLAYBACK_DEBOUNCE_WINDOW
    })
  }
}

export async function resolveStreamPath(itemId: string, userId?: string | null): Promise<string | null> {
  const location = itemsRepo.getPresentItemLocation(itemId, 'file', userId)
  if (!location) return null
  const absSourcePath = await settingsService.getAbsoluteSourcePath(location.sourceId)
  if (!absSourcePath) return null
  return pathsService.securePathJoin(absSourcePath, location.relativePath)
}

// --- Stream Path Cache ---
// LRU cache for item paths to avoid DB lookups on every chunk request
const STREAM_CACHE_MAX_SIZE = 100
const STREAM_CACHE_TTL = 60 * 60 * 1000 // 1 hour

interface StreamCacheEntry {
  absolutePath: string
  contentType: string
  cachedAt: number
}

const streamCache = new Map<string, StreamCacheEntry>()

function getStreamCacheKey(itemId: string, userId?: string | null): string {
  return `${userId ?? 'anonymous'}:${itemId}`
}

function getStreamCacheEntry(cacheKey: string): StreamCacheEntry | null {
  const entry = streamCache.get(cacheKey)
  if (!entry) return null

  // Check TTL
  if (Date.now() - entry.cachedAt > STREAM_CACHE_TTL) {
    streamCache.delete(cacheKey)
    return null
  }

  return entry
}

function setStreamCacheEntry(cacheKey: string, entry: Omit<StreamCacheEntry, 'cachedAt'>): void {
  // Simple LRU: if at max size, delete oldest entry
  if (streamCache.size >= STREAM_CACHE_MAX_SIZE) {
    const firstKey = streamCache.keys().next().value
    if (firstKey) streamCache.delete(firstKey)
  }

  streamCache.set(cacheKey, { ...entry, cachedAt: Date.now() })
}

/**
 * Clears all streaming caches. Call this when library is re-scanned or paths change.
 */
export function clearStreamCache(): void {
  streamCache.clear()
}

// --- MIME Type Lookup (pre-computed for speed) ---
const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv'
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

// --- Streaming ---

interface StreamRequestLogContext {
  itemId?: string
  method?: string
  url?: string
  userAgent?: string | null
  watchRequested?: boolean
  userId?: string
  cacheHit?: boolean
}

function parseByteRange(header: string | null, fileSize: number): { start: number; end: number } | 'unsatisfiable' | null {
  // Ignore unsupported range units, malformed values, and multipart requests.
  const match = header && /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return null

  const size = BigInt(fileSize)
  if (!match[1]) {
    const suffix = BigInt(match[2])
    if (suffix === 0n || size === 0n) return 'unsatisfiable'
    return { start: suffix >= size ? 0 : Number(size - suffix), end: fileSize - 1 }
  }

  const start = BigInt(match[1])
  const end = match[2] ? BigInt(match[2]) : undefined
  if (end !== undefined && end < start) return null
  if (start >= size) return 'unsatisfiable'
  return { start: Number(start), end: end === undefined || end >= size ? fileSize - 1 : Number(end) }
}

/** Serves the requested bytes from a file-backed Blob. */
export function handleFileStreamFast(
  file: { slice(start: number, end: number): Blob },
  fileSize: number,
  contentType: string,
  rangeHeader: string | null,
  logContext?: StreamRequestLogContext
): Response {
  const head = logContext?.method === 'HEAD'
  const range = head ? null : parseByteRange(rangeHeader, fileSize)
  const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Content-Type': contentType })
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${fileSize}`)
    return new Response(null, { status: 416, headers })
  }

  const start = range?.start ?? 0
  const end = range ? range.end + 1 : fileSize
  const status = range ? 206 : 200
  if (range) headers.set('Content-Range', `bytes ${start}-${end - 1}/${fileSize}`)
  headers.set('Content-Length', String(end - start))
  if (isVerbosePlaybackLoggingEnabled()) {
    logVerbose('Serving file stream.', {
      ...getSafeLogContext(logContext), requestRange: rangeHeader, status,
      contentRange: headers.get('Content-Range')
    })
  }

  return new Response(head ? null : file.slice(start, end), { status, headers })
}

/**
 * High-performance streaming endpoint that uses caching.
 * Call this from the route handler for maximum speed.
 *
 * @param itemId The library item ID
 * @param rangeHeader HTTP Range header value
 * @returns Response object or null if item not found
 */
export async function handleCachedStream(
  itemId: string,
  rangeHeader: string | null,
  logContext: Omit<StreamRequestLogContext, 'itemId' | 'cacheHit'> = {}
): Promise<Response | null> {
  const safeLogContext = getSafeLogContext(logContext)
  const cacheKey = getStreamCacheKey(itemId, logContext.userId)

  // Check cache first
  let cacheEntry = getStreamCacheEntry(cacheKey)
  const cacheHit = !!cacheEntry

  if (!cacheEntry) {
    // Cache miss - do the expensive lookups
    const absolutePath = await resolveStreamPath(itemId, logContext.userId)
    if (!absolutePath) {
      logVerbose('Stream request failed because absolute path could not be resolved.', {
        ...safeLogContext,
        ...getItemLogInfo(itemId),
        requestRange: rangeHeader,
        cacheHit: false
      })
      return null
    }

    const contentType = getMimeType(absolutePath)
    const newEntry = { absolutePath, contentType }
    setStreamCacheEntry(cacheKey, newEntry)
    cacheEntry = { ...newEntry, cachedAt: Date.now() }
  }

  // Get LIVE file size for every request to support growing files (e.g. active torrents)
  const file = Bun.file(cacheEntry.absolutePath)
  const fileSize = file.size
  if (fileSize === 0 && !await file.exists()) {
    // Clear stale locations while allowing empty files to return their actual length.
    streamCache.delete(cacheKey)
    logVerbose('Stream request failed because the file is unavailable.', {
      ...safeLogContext,
      ...getItemLogInfo(itemId),
      absolutePath: cacheEntry.absolutePath,
      requestRange: rangeHeader,
      cacheHit
    })
    return null
  }

  return handleFileStreamFast(
    file,
    fileSize,
    cacheEntry.contentType,
    rangeHeader,
    {
      ...safeLogContext,
      ...getItemLogInfo(itemId),
      cacheHit
    }
  )
}

// --- Playlist Generation ---

/**
 * Starts at the selected item. Identified episodes continue through their show.
 * Other files continue through their immediate folder.
 */
export async function generatePlaylist(itemId: string): Promise<LibraryItem[]> {
  const [item] = repositoryService.find({
    where: { id: itemId },
    includeHidden: true,
    includeIgnored: true
  })
  if (!item) return []
  if (!item.parentId) return [item]

  const show = item.mediaType === 'episode'
    ? repositoryService.getAncestors(itemId).find((ancestor) => ancestor.type === 'folder' && ancestor.mediaType === 'tv')
    : undefined
  const candidates = show
    ? repositoryService.find({
        where: { type: 'file', mediaType: 'episode', isMissing: 0 },
        compiledConditions: {
          sql: `i.id IN (${itemsRepo.DESCENDANT_IDS_SQL} SELECT id FROM tree)`,
          params: [show.id],
          tables: new Set()
        }
      })
    : repositoryService.getChildren(item.parentId)
  const files = candidates.filter((candidate): candidate is MediaFile =>
    candidate.type === 'file' && !candidate.isHidden && !candidate.isMissing
  )

  files.sort((a, b) => {
    const { seasonNumber: aS, episodeNumber: aE } = a
    const { seasonNumber: bS, episodeNumber: bE } = b

    // Sort by Season
    if (aS != null && bS != null && aS !== bS) return aS - bS
    if (aS != null && bS == null) return -1
    if (aS == null && bS != null) return 1

    // Sort by Episode
    if (aE != null && bE != null && aE !== bE) return aE - bE
    if (aE != null && bE == null) return -1
    if (aE == null && bE != null) return 1

    // Fallback to Name
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })

  const index = files.findIndex((file) => file.id === itemId)
  return index === -1 ? [item] : files.slice(index)
}

/**
 * Generates an M3U playlist file content for streaming
 * @param itemId ID of the starting item
 * @param host Host from the request (e.g., "localhost:3001")
 * @param protocol Protocol from the request (e.g., "http:")
 * @param token Optional authentication token
 * @returns M3U playlist content as a string
 */
export async function generateM3UPlaylist(
  itemId: string,
  host: string,
  protocol: string,
  token?: string,
  quality: PlaybackQuality = 'original',
  clientId?: string
): Promise<string | null> {
  // Remove .m3u extension if present
  const id = itemId.endsWith('.m3u') ? itemId.slice(0, -4) : itemId
  const playlist = await generatePlaylist(id)

  if (!playlist || playlist.length === 0) {
    return null
  }

  let m3uContent = '#EXTM3U\n'

  for (const item of playlist) {
    let title = item.title || item.name
    const f = item as any

    // Format TV show episodes with S01E01 prefix
    if (typeof f.seasonNumber === 'number' && typeof f.episodeNumber === 'number') {
      const s = f.seasonNumber.toString().padStart(2, '0')
      const e = f.episodeNumber.toString().padStart(2, '0')
      title = `S${s}E${e} - ${title}`
    }

    m3uContent += `#EXTINF:-1,${title.replace(/[\r\n]/g, ' ')}\n`

    // Build stream URL
    const filename = encodeURIComponent(item.name)
    const streamUrl = quality === 'original'
      ? `${protocol}//${host}/api/stream/${item.id}/${filename}`
      : `${protocol}//${host}/api/hls/${item.id}/${quality}/master.m3u8`
    const params = new URLSearchParams()
    if (token) params.set('token', token)
    if (quality === 'original') params.set('watch', '1')
    else if (clientId) params.set('clientId', clientId)

    const fullUrl = `${streamUrl}?${params.toString()}`
    m3uContent += `${fullUrl}\n`
  }

  return m3uContent
}
