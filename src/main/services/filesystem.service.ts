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
import { ITEM_READ_MODEL } from '../database/query-builder'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Filesystem Service] ${message}`)
}

interface SyncDiskResult {
  foundItemIds: Set<string>
  foundLocationPaths: Set<string>
  foundNonEmptyFolderPaths: Set<string>
  scanSucceeded: boolean
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
  shadowMinDepth: number = 1,
  cleanupMissing: boolean = true
): Promise<SyncDiskResult> {
  const foundPaths = new Set<string>()
  const foundLocationPaths = new Set<string>()
  const foundNonEmptyFolderPaths = new Set<string>()
  const newItemsByFingerprint = new Map<string, any | null>()
  const newItems: any[] = []
  const rescuedNewItems = new Set<any>()
  const discoveredItemIdsByRelPath = new Map<string, string>()
  const fingerprintBuffer = new FingerprintBuffer()
  const progress = new ProgressBroadcaster()
  let scanSucceeded = true

  const rootRelPath = itemsRepo.relativePathFromAbsolute(source.absolutePath, rootAbsPath)
  const rootId = itemsRepo.generateId(source.id, rootRelPath)
  const sourceRootId = itemsRepo.generateId(source.id, '.')
  const existingRootId = itemsRepo.getItemIdBySourcePath(source.id, rootRelPath)
  const effectiveRootId = existingRootId ?? rootId
  discoveredItemIdsByRelPath.set(rootRelPath, effectiveRootId)

  const resolveParentId = (relPath: string): string => {
    if (relPath === '.') return itemsRepo.LIBRARY_ROOT_ID
    const parentRelPath = itemsRepo.normalizeRelativePath(path.dirname(relPath))
    return (
      itemsRepo.getItemIdBySourcePath(source.id, parentRelPath) ??
      discoveredItemIdsByRelPath.get(parentRelPath) ??
      itemsRepo.generateItemId()
    )
  }

  const queue = new GlobalTaskQueue<string>(1, async (currentPath) => {
    const currentRelPath = itemsRepo.relativePathFromAbsolute(source.absolutePath, currentPath)
    const currentId =
      itemsRepo.getItemIdBySourcePath(source.id, currentRelPath) ??
      discoveredItemIdsByRelPath.get(currentRelPath) ??
      (currentRelPath === '.' ? sourceRootId : itemsRepo.generateItemId())
    discoveredItemIdsByRelPath.set(currentRelPath, currentId)

    // 1. Get all entries (Files and Folders)
    let entries: Dirent[]
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true })
    } catch (e) {
      log(`Failed to readdir: ${currentPath}`)
      scanSucceeded = false
      return
    }

    // 2. Authoritative State Update
    const hasIgnoreFile = entries.some((e) => e.name === '.ignore')
    const hasScannableChild = entries.some((e) => e.isDirectory() || /\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(e.name))
    const isUserHidden = itemsRepo.isItemHidden(currentId)

    try {
      const s = await fs.stat(currentPath)

      fingerprintBuffer.add({
        '@id': currentId,
        '@parentId': resolveParentId(currentRelPath),
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
      foundLocationPaths.add(currentRelPath)
      if (hasScannableChild) foundNonEmptyFolderPaths.add(currentRelPath)
    } catch (e) {
      log(`[Phase 1] Failed to stat folder: ${currentPath}`)
      scanSucceeded = false
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
          const relPath = itemsRepo.relativePathFromAbsolute(source.absolutePath, fullPath)
          const isDir = entry.isDirectory()

          const isVideoFile = !isDir && /\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(entry.name)
          if (!isDir && !isVideoFile) return

          try {
            const s = await fs.stat(fullPath)
            const depth = relPath.split('/').length
            const shadowedBy =
              isDir && higherPriorityPaths && depth >= shadowMinDepth && higherPriorityPaths.has(relPath)
                ? itemsRepo.findPresentLocationByRelativePath(relPath, source.id)
                : null
            const id =
              shadowedBy?.itemId ??
              itemsRepo.getItemIdBySourcePath(source.id, relPath) ??
              itemsRepo.findReusableItemIdForDiscoveredLocation({
                sourceId: source.id,
                relativePath: relPath,
                inode: s.ino,
                deviceId: s.dev
              }) ??
              itemsRepo.generateItemId()
            discoveredItemIdsByRelPath.set(relPath, id)

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
              '@isHidden': isDir ? null : itemsRepo.isItemHidden(id) ? 1 : 0,
              '@isShadowed': shadowedBy ? 1 : 0,
              '@shadowedByLocationId': shadowedBy?.locationId ?? null
            }

            if (shadowedBy) {
              log(`[Phase 1] Shadowed folder location recorded: ${relPath} (${id})`)
              fingerprintBuffer.add(itemData)
              foundPaths.add(id)
              foundLocationPaths.add(relPath)
              progress.update(relPath)
              return
            }

            if (itemsRepo.existsById(id)) {
              if (isDir) log(`[Phase 1] Discovered EXISTING folder: ${relPath} (${id})`)
              fingerprintBuffer.add(itemData)
              foundPaths.add(id)
              foundLocationPaths.add(relPath)
            } else {
              if (isDir) log(`[Phase 1] Discovered NEW folder: ${relPath} (${id})`)
              newItems.push(itemData)
              const key = locationFingerprintKey(itemData['@deviceId'], itemData['@inode'])
              if (key) {
                newItemsByFingerprint.set(key, newItemsByFingerprint.has(key) ? null : itemData)
              }
            }

            if (isDir) {
              queue.push(fullPath)
            }

            progress.update(relPath)
          } catch (e) {
            log(`Failed to stat: ${fullPath}`)
            scanSucceeded = false
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
    const isUserHidden = itemsRepo.isItemHidden(effectiveRootId)
    fingerprintBuffer.add({
      '@id': effectiveRootId,
      '@parentId': effectiveRootId === sourceRootId ? itemsRepo.LIBRARY_ROOT_ID : resolveParentId(rootRelPath),
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
    foundPaths.add(effectiveRootId)
    foundLocationPaths.add(rootRelPath)
  } catch {
    scanSucceeded = false
  }

  await queue.waitForIdle()
  fingerprintBuffer.flush()
  progress.broadcast()

  // --- RECONCILIATION PHASE ---

  const scopePath = rootRelPath === '.' ? '' : rootRelPath
  const missingItems = itemsRepo.getItemsForCleanup(source.id, scopePath).filter((item) => !foundLocationPaths.has(item.path))

  log(
    `[Phase 1] Crawl complete. Found ${foundPaths.size} existing items, ${newItems.length} potentially new items.`
  )

  // #2 Identity-Based Rename Rescue (O(N))
  for (const item of missingItems) {
    const key = locationFingerprintKey(item.deviceId, item.inode)
    const match = key ? newItemsByFingerprint.get(key) : null

    if (match) {
      log(`[Phase 1] Detected rename: "${item.path}" -> "${match['@path']}"`)
      itemsRepo.migrateRecord(item.id, match)
      foundPaths.add(item.id)
      foundLocationPaths.add(match['@path'])
      rescuedNewItems.add(match)
    }
  }

  // #3 Final Sync (Insert remaining new items)
  const remainingNewItems = newItems.filter((item) => !rescuedNewItems.has(item))
  if (remainingNewItems.length > 0) {
    log(`[Phase 1] Inserting ${remainingNewItems.length} new items.`)
    itemsRepo.upsertLibraryItems(remainingNewItems)
    for (const item of remainingNewItems) {
      foundPaths.add(item['@id'])
      foundLocationPaths.add(item['@path'])
    }
  }

  // #4 Conditional Cleanup
  if (!cleanupMissing) {
    log(`[Phase 1] Cleanup deferred for source ${source.id} in scope: "${scopePath}"`)
    log(`[Phase 1] Filesystem sync complete. Result: ${foundPaths.size} active items.`)
    return { foundItemIds: foundPaths, foundLocationPaths, foundNonEmptyFolderPaths, scanSucceeded }
  }

  cleanupMissingForSource(source.id, scopePath, foundLocationPaths, scanSucceeded)

  log(`[Phase 1] Filesystem sync complete. Result: ${foundPaths.size} active items.`)
  return { foundItemIds: foundPaths, foundLocationPaths, foundNonEmptyFolderPaths, scanSucceeded }
}

function locationFingerprintKey(deviceId: number | null | undefined, inode: number | null | undefined): string | null {
  return deviceId == null || inode == null ? null : `${deviceId}_${inode}`
}

export function cleanupMissingForSource(sourceId: string, pathPrefix: string, foundLocationPaths: Set<string>, scanSucceeded: boolean): void {
  const normalizedPrefix = itemsRepo.normalizeRelativePath(pathPrefix)
  const scopePath = normalizedPrefix === '.' ? '' : normalizedPrefix
  if (!scanSucceeded) {
    log(`[Phase 1] Cleanup skipped for source ${sourceId} in scope "${scopePath}" because the scan did not complete successfully.`)
    return
  }
  const missingItems = itemsRepo.getItemsForCleanup(sourceId, scopePath).filter((item) => !foundLocationPaths.has(item.path))

  log(
    `[Phase 1] Reconciliation: Checking ${missingItems.length} missing items for cleanup in scope: "${scopePath}"`
  )
  for (const item of missingItems) {
    // Optimization: Check if this location was rescued during the scan.
    if (foundLocationPaths.has(item.path)) continue

    if (item.hasLocks) {
      log(`[Phase 1] Marking AS MISSING (has locks): ${item.path}`)
      itemsRepo.markLocationAsMissing(item.locationId)
    } else {
      log(`[Phase 1] DELETING (no locks): ${item.path}`)
      itemsRepo.markLocationAsMissing(item.locationId)
      itemsRepo.deleteLocation(item.locationId)
      itemsRepo.deleteItemIfNoPresentLocations(item.id)
    }
  }
}

export async function scanDirectory(
  source: MediaSource,
  resolvedAbsPath: string,
  options: {
    skipMetadata?: boolean
    initialFolderSettings?: Record<string, any>
    higherPriorityPaths?: Set<string>
    shadowMinDepth?: number
    cleanupMissing?: boolean
    onFoundItems?: (foundItemIds: Set<string>) => void
    onFoundLocationPaths?: (foundLocationPaths: Set<string>) => void
    onFoundNonEmptyFolderPaths?: (foundFolderPaths: Set<string>) => void
    onScanSucceeded?: (scanSucceeded: boolean) => void
  } = {}
): Promise<MediaFolder | null> {
  log(`Starting Phase 1 (Filesystem Sync) for source ${source.id}: ${resolvedAbsPath}`)

  repositoryService.ensureSourceRoot(source, resolvedAbsPath)

  await syncDiskToDatabase(
    resolvedAbsPath,
    { id: source.id, absolutePath: resolvedAbsPath },
    options.higherPriorityPaths,
    options.shadowMinDepth,
    options.cleanupMissing ?? true
  )
    .then((result) => {
      options.onFoundItems?.(result.foundItemIds)
      options.onFoundLocationPaths?.(result.foundLocationPaths)
      options.onFoundNonEmptyFolderPaths?.(result.foundNonEmptyFolderPaths)
      options.onScanSucceeded?.(result.scanSucceeded)
    })

  if (options.initialFolderSettings) {
    for (const [relPath, settings] of Object.entries(options.initialFolderSettings)) {
      const normalizedRelPath = itemsRepo.normalizeRelativePath(relPath)
      const id = itemsRepo.getItemIdBySourcePath(source.id, normalizedRelPath)
      if (!id) continue
      settingsRepo.mergeSettings(id, { folderSettings: {
        retrieveChildrenMetadata: !!settings.retrieve_children_metadata,
        childrenTypeHint: settings.children_type_hint ?? null,
        processTvChildren: settings.process_tv_children !== false,
      } })
    }
  }

  return repositoryService.getRoot()
}

export async function syncWithDisk(node: MediaFolder, source: { id: string; absolutePath: string }, userId?: string | null): Promise<void> {
  const location = itemsRepo.getPresentFolderLocation(node.id, userId)
  if (!location) {
    log(`Cannot sync subtree without a present folder location: ${node.name}`)
    return
  }
  if (location.sourceId !== source.id) {
    log(`Cannot sync subtree from source ${source.id}; selected folder location is in source ${location.sourceId}`)
    return
  }

  const rootAbsPath = path.join(source.absolutePath, location.relativePath)

  log(`Syncing subtree: ${location.relativePath}`)

  await syncDiskToDatabase(rootAbsPath, source)
}

export function getFolderPathsForSource(sourceId: string): Set<string> {
  return itemsRepo.getAllFolderPathsInSource(sourceId)
}

export function getNonEmptyFolderPathsForSource(sourceId: string): Set<string> {
  return itemsRepo.getNonEmptyFolderPathsInSource(sourceId)
}

export async function verifyImagePaths(imagesDir: string): Promise<void> {
  const rows = searchRepo.executeSearchSql(
    `SELECT i.id AS item_id, e.poster_path, e.backdrop_path, e.logo_path
     FROM ${ITEM_READ_MODEL} i
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
