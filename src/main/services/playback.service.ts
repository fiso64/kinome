import fs from 'fs'
import path from 'path'
import * as repositoryService from './repository.service'
import type { LibraryItem } from '@shared/types'

// --- Playback Tracking ---

// Stream playback debounce to prevent DB spam on range requests
const playbackDebounce = new Map<string, number>()
const PLAYBACK_DEBOUNCE_WINDOW = 5 * 60 * 1000 // 5 mins

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

// --- Streaming ---

/**
 * Handles file streaming with HTTP range request support for large video files
 * @param filePath Absolute path to the file
 * @param rangeHeader HTTP Range header value (e.g., "bytes=0-1023")
 * @param enableLogging Whether to log detailed streaming information
 * @returns Response object with appropriate headers and file slice
 */
export async function handleFileStream(
    filePath: string,
    rangeHeader: string | null,
    enableLogging: boolean = false
): Promise<Response> {
    // Get file size using fs.statSync to avoid memory issues with Bun.file on large files
    const stats = fs.statSync(filePath)
    const fileSize = stats.size

    if (enableLogging) {
        console.log(
            `[STREAM] File size: ${fileSize} bytes (${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB)`
        )
        console.log(`[STREAM] Range header: ${rangeHeader || 'none'}`)
    }

    // Determine MIME type
    const ext = path.extname(filePath).toLowerCase()
    let contentType = 'application/octet-stream'
    if (ext === '.mp4') contentType = 'video/mp4'
    else if (ext === '.mkv') contentType = 'video/x-matroska'
    else if (ext === '.webm') contentType = 'video/webm'
    else if (ext === '.avi') contentType = 'video/x-msvideo'
    else if (ext === '.mov') contentType = 'video/quicktime'

    if (enableLogging) {
        console.log(`[STREAM] Content type: ${contentType}`)
    }

    if (rangeHeader) {
        if (enableLogging) {
            console.log(`[STREAM] Processing range request...`)
        }

        // Parse range header (e.g., "bytes=0-1023" or "bytes=0-")
        const parts = rangeHeader.replace(/bytes=/, '').split('-')
        const start = parseInt(parts[0], 10)

        // Handle open-ended range requests (e.g., "bytes=0-") by limiting chunk size
        // 100MB is a good balance - large enough to reduce request overhead, 
        // small enough to allow seeking without huge re-downloads
        const MAX_CHUNK_SIZE = 100 * 1024 * 1024 // 100MB max chunk
        let end: number

        if (parts[1] && parts[1].trim() !== '') {
            // Explicit end specified
            end = parseInt(parts[1], 10)
        } else {
            // Open-ended range: limit to MAX_CHUNK_SIZE
            end = Math.min(start + MAX_CHUNK_SIZE - 1, fileSize - 1)
            if (enableLogging) {
                console.log(`[STREAM] Open-ended range detected, limiting to ${MAX_CHUNK_SIZE} bytes`)
            }
        }

        const chunkSize = end - start + 1
        if (enableLogging) {
            console.log(`[STREAM] Range: ${start}-${end}, chunk size: ${chunkSize} bytes`)
            console.log(`[STREAM] Creating file slice...`)
        }

        const file = Bun.file(filePath)
        const slice = file.slice(start, end + 1)

        if (enableLogging) {
            console.log(`[STREAM] Slice created, returning 206 response`)
        }

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

    // No range request: Send a small initial chunk to prompt browser to use range requests
    // This prevents trying to load the entire file into memory
    if (enableLogging) {
        console.log(`[STREAM] No range header, sending initial chunk...`)
    }

    const INITIAL_CHUNK_SIZE = 1024 * 1024 // 1MB
    const initialSize = Math.min(INITIAL_CHUNK_SIZE, fileSize)

    if (enableLogging) {
        console.log(`[STREAM] Initial chunk size: ${initialSize} bytes`)
        console.log(`[STREAM] Creating Bun.file...`)
    }

    const file = Bun.file(filePath)
    const slice = file.slice(0, initialSize)

    if (enableLogging) {
        console.log(`[STREAM] Slice created, returning 206 response`)
    }

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
