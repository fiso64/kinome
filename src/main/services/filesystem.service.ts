import path from 'path'
import fs from 'fs/promises'
import { type Dirent } from 'fs'
import * as itemsRepo from '../database/repositories/filesystem.repo'
import * as settingsRepo from '../database/repositories/settings.repo'
import * as metadataRepo from '../database/repositories/metadata.repo'
import * as searchRepo from '../database/repositories/search.repo'
import { runTransaction } from '../database/client'
import * as pathsService from './paths.service'
import { GlobalTaskQueue } from '../utils/concurrency'
import type { MediaFolder, MediaSource } from '@shared/types'
import { getTransport } from '../transport.registry'
import * as repositoryService from './repository.service'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Filesystem Service] ${message}`)
}

/**
 * Buffered writer for fingerprints to maximize SQLite throughput.
 */
class FingerprintBuffer {
  private buffer: any[] = []
  private timeout: any = null

  add(item: any) {
    this.buffer.push(item)
    if (this.buffer.length >= 500) {
      this.flush()
    } else if (!this.timeout) {
      this.timeout = setTimeout(() => this.flush(), 1000)
    }
  }

  flush() {
    if (this.buffer.length === 0) return
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }

    runTransaction(() => {
      itemsRepo.upsertLibraryItems(this.buffer)
    })
    this.buffer = []
  }
}

/**
 * Throttled progress broadcaster for the UI.
 */
class ProgressBroadcaster {
  private lastBroadcast = 0
  private lastPath = ''
  private foundCount = 0

  update(currentPath: string) {
    this.foundCount++
    this.lastPath = currentPath

    const now = Date.now()
    if (now - this.lastBroadcast > 100) {
      this.broadcast()
      this.lastBroadcast = now
    }
  }

  broadcast() {
    getTransport().broadcast('SCANNER_PROGRESS', {
      path: this.lastPath,
      count: this.foundCount
    })
  }
}

async function syncDiskToDatabase(
  rootAbsPath: string,
  source: { id: string; absolutePath: string },
  higherPriorityPaths?: Set<string>,
  shadowMinDepth: number = 1
): Promise<Set<string>> {
  const foundPaths = new Set<string>()
  const newItemsMap = new Map<string, any>()
  const fingerprintBuffer = new FingerprintBuffer()
  const progress = new ProgressBroadcaster()

  const rootRelPath = path.relative(source.absolutePath, rootAbsPath).replace(/\\/g, '/') || '.'
  const rootId = itemsRepo.generateId(source.id, rootRelPath)
  const sourceRootId = itemsRepo.generateId(source.id, '.')

  const queue = new GlobalTaskQueue<string>(1, async (currentPath) => {
    const currentRelPath = path.relative(source.absolutePath, currentPath).replace(/\\/g, '/') || '.'
    const currentId = itemsRepo.generateId(source.id, currentRelPath)

    // 1. Get all entries (Files and Folders)
    let entries: Dirent[]
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true })
    } catch (e) {
      log(`Failed to readdir: ${currentPath}`)
      return
    }

    // 2. Authoritative State Update
    const hasIgnoreFile = entries.some((e) => e.name === '.ignore')
    const isUserHidden = itemsRepo.isItemHidden(currentId)

    try {
      const s = await fs.stat(currentPath)
      const parentRelPath = path.dirname(currentRelPath).replace(/\\/g, '/') || '.'
      const parentId = currentRelPath === '.' ? itemsRepo.LIBRARY_ROOT_ID : itemsRepo.generateId(source.id, parentRelPath)

      fingerprintBuffer.add({
        '@id': currentId,
        '@parentId': parentId,
        '@path': currentRelPath,
        '@name': path.basename(currentPath) || 'Library',
        '@type': 'folder',
        '@sourceId': source.id,
        '@size': s.size,
        '@mtime': Math.floor(s.mtimeMs),
        '@birthtime': Math.floor(s.birthtimeMs),
        '@inode': s.ino,
        '@deviceId': s.dev,
        '@isIgnored': hasIgnoreFile ? 1 : 0,
        '@isHidden': isUserHidden ? 1 : 0
      })
      foundPaths.add(currentId)
    } catch (e) {
      log(`[Phase 1] Failed to stat folder: ${currentPath}`)
      return
    }

    if (hasIgnoreFile || isUserHidden) {
      log(
        `[Phase 1] Branch suppressed: ${currentRelPath} (${hasIgnoreFile ? '.ignore' : ''}${hasIgnoreFile && isUserHidden ? '+' : ''}${isUserHidden ? 'user-hidden' : ''})`
      )
      return
    }

    log(`[Phase 1] Processing branch: ${currentRelPath} (${entries.length} entries)`)

    // 3. PROCESS CHILDREN (Files and Subfolders)
    const CHILDREN_BATCH_SIZE = 50
    for (let i = 0; i < entries.length; i += CHILDREN_BATCH_SIZE) {
      const batch = entries.slice(i, i + CHILDREN_BATCH_SIZE)

      await Promise.all(
        batch.map(async (entry) => {
          const fullPath = path.join(currentPath, entry.name)
          const relPath = path.relative(source.absolutePath, fullPath).replace(/\\/g, '/')
          const id = itemsRepo.generateId(source.id, relPath)
          const isDir = entry.isDirectory()

          const isVideoFile = !isDir && /\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(entry.name)
          if (!isDir && !isVideoFile) return

          // Shadow: skip folders that exist in a higher-priority source at or beyond min depth
          if (isDir && higherPriorityPaths) {
            const depth = relPath.split('/').length
            if (depth >= shadowMinDepth && higherPriorityPaths.has(relPath)) {
              log(`[Phase 1] Shadow skip (depth ${depth}): ${relPath}`)
              return
            }
          }

          try {
            const s = await fs.stat(fullPath)
            const itemData = {
              '@id': id,
              '@parentId': currentId,
              '@path': relPath,
              '@name': entry.name,
              '@type': isDir ? 'folder' : 'file',
              '@sourceId': source.id,
              '@size': s.size,
              '@mtime': Math.floor(s.mtimeMs),
              '@birthtime': Math.floor(s.birthtimeMs),
              '@inode': s.ino,
              '@deviceId': s.dev,
              '@isIgnored': isDir ? null : 0, // Parent doesn't know folder ignore state yet
              '@isHidden': isDir ? null : itemsRepo.isItemHidden(id) ? 1 : 0
            }

            if (itemsRepo.existsById(id)) {
              if (isDir) log(`[Phase 1] Discovered EXISTING folder: ${relPath} (${id})`)
              fingerprintBuffer.add(itemData)
              foundPaths.add(id)
            } else {
              if (isDir) log(`[Phase 1] Discovered NEW folder: ${relPath} (${id})`)
              const key = `${itemData['@deviceId']}_${itemData['@inode']}`
              newItemsMap.set(key, itemData)
            }

            if (isDir) {
              queue.push(fullPath)
            }

            progress.update(relPath)
          } catch (e) {
            log(`Failed to stat: ${fullPath}`)
          }
        })
      )
    }
  })

  // Start the crawl
  queue.push(rootAbsPath)

  // Ensure the source root itself is tracked
  try {
    const s = await fs.stat(rootAbsPath)
    const isUserHidden = itemsRepo.isItemHidden(rootId)
    fingerprintBuffer.add({
      '@id': rootId,
      '@parentId': rootId === sourceRootId ? itemsRepo.LIBRARY_ROOT_ID : itemsRepo.generateId(source.id, path.dirname(rootRelPath).replace(/\\/g, '/') || '.'),
      '@path': rootRelPath,
      '@name': path.basename(rootAbsPath) || 'Library',
      '@type': 'folder',
      '@sourceId': source.id,
      '@size': s.size,
      '@mtime': Math.floor(s.mtimeMs),
      '@birthtime': Math.floor(s.birthtimeMs),
      '@inode': s.ino,
      '@deviceId': s.dev,
      '@isIgnored': 0,
      '@isHidden': isUserHidden ? 1 : 0
    })
    foundPaths.add(rootId)
  } catch { }

  await queue.waitForIdle()
  fingerprintBuffer.flush()
  progress.broadcast()

  // --- RECONCILIATION PHASE ---

  const scopePath = rootRelPath === '.' ? '' : rootRelPath
  const missingItems = itemsRepo.getItemsForCleanup(source.id, scopePath).filter((item) => !foundPaths.has(item.id))

  log(
    `[Phase 1] Crawl complete. Found ${foundPaths.size} existing items, ${newItemsMap.size} potentially new items.`
  )

  // #2 Identity-Based Rename Rescue (O(N))
  for (const item of missingItems) {
    const key = `${item.deviceId}_${item.inode}`
    const match = newItemsMap.get(key)

    if (match) {
      log(`[Phase 1] Detected rename: "${item.path}" -> "${match['@path']}"`)
      itemsRepo.migrateRecord(item.id, match)
      foundPaths.add(match['@id'])
      newItemsMap.delete(key)
    }
  }

  // #3 Final Sync (Insert remaining new items)
  if (newItemsMap.size > 0) {
    log(`[Phase 1] Inserting ${newItemsMap.size} new items.`)
    itemsRepo.upsertLibraryItems(Array.from(newItemsMap.values()))
    for (const item of newItemsMap.values()) {
      foundPaths.add(item['@id'])
    }
  }

  // #4 Conditional Cleanup
  log(
    `[Phase 1] Reconciliation: Checking ${missingItems.length} missing items for cleanup in scope: "${scopePath}"`
  )
  runTransaction(() => {
    for (const item of missingItems) {
      // Optimization: Check if this was rescued (it should be in foundPaths now)
      if (foundPaths.has(item.id)) continue

      if (item.hasLocks) {
        log(`[Phase 1] Marking AS MISSING (has locks): ${item.path}`)
        itemsRepo.markAsMissing(item.id)
      } else {
        log(`[Phase 1] DELETING (no locks): ${item.path}`)
        itemsRepo.deleteItem(item.id)
      }
    }
  })

  log(`[Phase 1] Filesystem sync complete. Result: ${foundPaths.size} active items.`)
  return foundPaths
}

export async function scanDirectory(
  source: MediaSource,
  resolvedAbsPath: string,
  options: {
    skipMetadata?: boolean
    initialFolderSettings?: Record<string, any>
    higherPriorityPaths?: Set<string>
    shadowMinDepth?: number
  } = {}
): Promise<MediaFolder | null> {
  log(`Starting Phase 1 (Filesystem Sync) for source ${source.id}: ${resolvedAbsPath}`)

  repositoryService.ensureSourceRoot(source, resolvedAbsPath)

  if (options.initialFolderSettings) {
    for (const [relPath, settings] of Object.entries(options.initialFolderSettings)) {
      const id = itemsRepo.generateId(source.id, relPath)
      settingsRepo.mergeSettings(id, { folderSettings: {
        retrieveChildrenMetadata: !!settings.retrieve_children_metadata,
        childrenTypeHint: settings.children_type_hint ?? null,
        processTvChildren: settings.process_tv_children !== false,
      } })
    }
  }

  await syncDiskToDatabase(
    resolvedAbsPath,
    { id: source.id, absolutePath: resolvedAbsPath },
    options.higherPriorityPaths,
    options.shadowMinDepth
  )

  return repositoryService.getRoot()
}

export async function syncWithDisk(node: MediaFolder, source: { id: string; absolutePath: string }): Promise<void> {
  if (!node.path) {
    log(`Cannot sync subtree with undefined path: ${node.name}`)
    return
  }
  const rootAbsPath = path.join(source.absolutePath, node.path)

  log(`Syncing subtree: ${node.path}`)

  await syncDiskToDatabase(rootAbsPath, source)
}

export function getFolderPathsForSource(sourceId: string): Set<string> {
  return itemsRepo.getAllFolderPathsInSource(sourceId)
}

export async function verifyImagePaths(imagesDir: string): Promise<void> {
  const rows = searchRepo.executeSearchSql(
    `SELECT i.id AS item_id, e.poster_path, e.backdrop_path, e.logo_path
     FROM items i
     JOIN media_entities e ON i.entity_id = e.id
     WHERE e.poster_path IS NOT NULL OR e.backdrop_path IS NOT NULL OR e.logo_path IS NOT NULL`,
    []
  ) as { item_id: string; poster_path: string | null; backdrop_path: string | null; logo_path: string | null }[]

  for (const row of rows) {
    const images = {
      poster: row.poster_path,
      backdrop: row.backdrop_path,
      logo: row.logo_path
    }
    let changed = false

    if (images.poster) {
      try {
        await fs.access(path.join(imagesDir, images.poster))
      } catch {
        images.poster = null
        changed = true
      }
    }
    if (images.backdrop) {
      try {
        await fs.access(path.join(imagesDir, images.backdrop))
      } catch {
        images.backdrop = null
        changed = true
      }
    }
    if (images.logo) {
      try {
        await fs.access(path.join(imagesDir, images.logo))
      } catch {
        images.logo = null
        changed = true
      }
    }

    if (changed) {
      metadataRepo.updateMetadataImages(row.item_id, images)
    }
  }
}

export function initializeRoot(
  source: MediaSource,
  resolvedAbsPath: string,
  initialFolderSettings?: Record<string, any>
): void {
  const rootId = itemsRepo.generateId(source.id, '.')
  const rootName = path.basename(resolvedAbsPath) || 'Library'
  const rootSettings = initialFolderSettings ? initialFolderSettings['.'] : undefined

  runTransaction(() => {
    itemsRepo.ensureLibraryVirtualRoot()
    itemsRepo.upsertRootItem(rootId, rootName, source.id)
    if (rootSettings) {
      settingsRepo.mergeSettings(rootId, { folderSettings: {
        retrieveChildrenMetadata: !!rootSettings.retrieve_children_metadata,
        childrenTypeHint: rootSettings.children_type_hint ?? null,
        processTvChildren: rootSettings.process_tv_children !== false,
      } })
    }
  })
}
