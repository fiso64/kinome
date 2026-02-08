import fs from 'fs'
import path from 'path'
import * as repositoryService from './repository.service'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import type { LibraryItem } from '@shared/types'

// --- Playback Tracking ---

// Stream playback debounce to prevent DB spam on range requests
const playbackDebounce = new Map<string, number>()
const PLAYBACK_DEBOUNCE_WINDOW = 1 * 60 * 1000 // 1 minute

export function recordPlaybackDebounced(
    itemId: string,
    recordPlaybackFn: (itemId: string) => Promise<void>
) {
    const now = Date.now()
    const last = playbackDebounce.get(itemId) || 0
    if (now - last > PLAYBACK_DEBOUNCE_WINDOW) {
        playbackDebounce.set(itemId, now)
        recordPlaybackFn(itemId).catch(console.error)
    }
}

async function resolveStreamPath(relativePath: string): Promise<string | null> {
    const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
    if (!mediaSourcePath) return null
    return pathsService.securePathJoin(mediaSourcePath, relativePath)
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

function getStreamCacheEntry(itemId: string): StreamCacheEntry | null {
    const entry = streamCache.get(itemId)
    if (!entry) return null

    // Check TTL
    if (Date.now() - entry.cachedAt > STREAM_CACHE_TTL) {
        streamCache.delete(itemId)
        return null
    }

    return entry
}

function setStreamCacheEntry(itemId: string, entry: Omit<StreamCacheEntry, 'cachedAt'>): void {
    // Simple LRU: if at max size, delete oldest entry
    if (streamCache.size >= STREAM_CACHE_MAX_SIZE) {
        const firstKey = streamCache.keys().next().value
        if (firstKey) streamCache.delete(firstKey)
    }

    streamCache.set(itemId, { ...entry, cachedAt: Date.now() })
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

/**
 * Maximum chunk size for open-ended range requests.
 * Reduce to improve random seek performance at the cost of more requests/stability.
 */
const MAX_CHUNK_SIZE = 30 * 1024 * 1024 // 30MB should be safe for high bitrate 4K video?

/**
 * Handles file streaming with HTTP range request support for large video files.
 * This is the core streaming function - it takes a pre-resolved file path.
 * 
 * @param filePath Absolute path to the file
 * @param fileSize File size in bytes (pass if known to avoid stat call)
 * @param contentType MIME type (pass if known to avoid lookup)
 * @param rangeHeader HTTP Range header value (e.g., "bytes=0-1023")
 * @returns Response object with appropriate headers and file slice
 */
export function handleFileStreamFast(
    filePath: string,
    fileSize: number,
    contentType: string,
    rangeHeader: string | null
): Response {
    if (rangeHeader) {
        // Parse range header (e.g., "bytes=0-1023" or "bytes=0-")
        const parts = rangeHeader.replace(/bytes=/, '').split('-')
        const start = parseInt(parts[0], 10)

        let end: number
        if (parts[1] && parts[1].trim() !== '') {
            // Explicit end specified
            end = parseInt(parts[1], 10)
        } else {
            // Open-ended range: limit to MAX_CHUNK_SIZE
            end = Math.min(start + MAX_CHUNK_SIZE - 1, fileSize - 1)
        }

        const chunkSize = end - start + 1
        const file = Bun.file(filePath)
        const slice = file.slice(start, end + 1)

        return new Response(slice, {
            status: 206,
            headers: {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize.toString(),
                'Content-Type': contentType
            }
        })
    }

    // No range request: Send a small initial chunk to prompt the client to use range requests
    const INITIAL_CHUNK_SIZE = 1024 * 1024 // 1MB
    const initialSize = Math.min(INITIAL_CHUNK_SIZE, fileSize)

    const file = Bun.file(filePath)
    const slice = file.slice(0, initialSize)

    return new Response(slice, {
        status: 206,
        headers: {
            'Content-Range': `bytes 0-${initialSize - 1}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': initialSize.toString(),
            'Content-Type': contentType
        }
    })
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
    rangeHeader: string | null
): Promise<Response | null> {
    // Check cache first
    let cacheEntry = getStreamCacheEntry(itemId)

    if (!cacheEntry) {
        // Cache miss - do the expensive lookups
        const itemPath = repositoryService.getItemPath(itemId)
        if (!itemPath) return null

        const absolutePath = await resolveStreamPath(itemPath)
        if (!absolutePath) return null

        const contentType = getMimeType(absolutePath)
        const newEntry = { absolutePath, contentType }
        setStreamCacheEntry(itemId, newEntry)
        cacheEntry = { ...newEntry, cachedAt: Date.now() }
    }

    // Get LIVE file size for every request to support growing files (e.g. active torrents)
    const file = Bun.file(cacheEntry.absolutePath)
    const fileSize = file.size
    if (fileSize === 0) {
        // Handle file potentially deleted or inaccessible
        streamCache.delete(itemId)
        return null
    }

    return handleFileStreamFast(
        cacheEntry.absolutePath,
        fileSize,
        cacheEntry.contentType,
        rangeHeader
    )
}

// --- Playlist Generation ---

/**
 * Generates a playlist for an item (e.g., for continuous playback)
 * Returns the item and all subsequent siblings (sorted by season/episode or name)
 * @param itemId ID of the starting item
 * @returns Array of library items in playback order
 */
export async function generatePlaylist(itemId: string): Promise<LibraryItem[]> {
    const item = repositoryService.getItemById(itemId)
    if (!item) return []

    const parent = repositoryService.findParent(itemId)
    // If no parent (root item?) or item is orphan, just return the item itself
    if (!parent) return [item]

    // Get all siblings including the item itself
    const siblings = repositoryService
        .getChildren(parent.id)
        .filter((c) => c.type === 'file' && !c.isHidden && !c.isMissing)

    // Sort siblings:
    // 1. Season/Episode (if available)
    // 2. Name (Alphabetical)
    siblings.sort((a, b) => {
        // Cast to any to access optional properties safely
        const aS = (a as any).seasonNumber
        const bS = (b as any).seasonNumber
        const aE = (a as any).episodeNumber
        const bE = (b as any).episodeNumber

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

    // Find the index of the requested item
    const index = siblings.findIndex((s) => s.id === itemId)
    if (index === -1) return [item]

    // Return the item and all subsequent items (Next episodes)
    return siblings.slice(index)
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
    token?: string
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

        m3uContent += `#EXTINF:-1,${title}\n`

        // Build stream URL
        const filename = encodeURIComponent(item.name)
        const streamUrl = `${protocol}//${host}/api/stream/${item.id}/${filename}`
        const params = new URLSearchParams()
        if (token) params.set('token', token)
        params.set('watch', '1')

        const fullUrl = `${streamUrl}?${params.toString()}`
        m3uContent += `${fullUrl}\n`
    }

    return m3uContent
}
