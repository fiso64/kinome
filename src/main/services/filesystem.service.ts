import path from 'path'
import fs from 'fs/promises'
import { type Dirent } from 'fs'
import * as repositoryService from './repository.service'
import * as pathsService from './paths.service'
import { GlobalTaskQueue } from '../utils/concurrency'
import type { LibraryItem, MediaFolder } from '@shared/types'
import { getTransport } from '../transport.registry'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Filesystem Service] ${message}`)
}

/**
 * Buffered writer for fingerprints to maximize SQLite throughput.
 */
class FingerprintBuffer {
  private buffer: any[] = []
  private timeout: any = null
  private upsertStmt: any

  constructor(db: any) {
    this.upsertStmt = db.prepare(`
      INSERT INTO items (id, parent_id, path, name, type, size, mtime, birthtime, inode, device_id, is_missing, is_ignored, is_hidden)
      VALUES (@id, @parentId, @path, @name, @type, @size, @mtime, @birthtime, @inode, @deviceId, 0, @isIgnored, @isHidden)
      ON CONFLICT(id) DO UPDATE SET
        is_missing = 0,
        parent_id = excluded.parent_id,
        size = excluded.size,
        mtime = excluded.mtime,
        birthtime = excluded.birthtime,
        inode = excluded.inode,
        device_id = excluded.device_id,
        is_ignored = COALESCE(excluded.is_ignored, is_ignored),
        is_hidden = COALESCE(excluded.is_hidden, is_hidden)
    `)
  }

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

    repositoryService.runTransaction(() => {
      for (const item of this.buffer) {
        this.upsertStmt.run(item)
      }
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
  mediaSourcePath: string,
  db: any
): Promise<Set<string>> {
  const foundPaths = new Set<string>()
  const newItemsMap = new Map<string, any>()
  const fingerprintBuffer = new FingerprintBuffer(db)
  const progress = new ProgressBroadcaster()

  const rootRelPath = path.relative(mediaSourcePath, rootAbsPath).replace(/\\/g, '/') || '.'
  const rootId = repositoryService.generateId(rootRelPath)

  const queue = new GlobalTaskQueue<string>(1, async (currentPath) => {
    const currentRelPath = path.relative(mediaSourcePath, currentPath).replace(/\\/g, '/') || '.'
    const currentId = repositoryService.generateId(currentRelPath)

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
    const isUserHidden = repositoryService.isItemHidden(currentId)

    try {
      const s = await fs.stat(currentPath)
      const parentRelPath = path.dirname(currentRelPath).replace(/\\/g, '/') || '.'
      const parentId = currentRelPath === '.' ? null : repositoryService.generateId(parentRelPath)

      fingerprintBuffer.add({
        '@id': currentId,
        '@parentId': parentId,
        '@path': currentRelPath,
        '@name': path.basename(currentPath) || 'Library',
        '@type': 'folder',
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
          const relPath = path.relative(mediaSourcePath, fullPath).replace(/\\/g, '/')
          const id = repositoryService.generateId(relPath)
          const isDir = entry.isDirectory()

          const isVideoFile = !isDir && /\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(entry.name)
          if (!isDir && !isVideoFile) return

          try {
            const s = await fs.stat(fullPath)
            const itemData = {
              '@id': id,
              '@parentId': currentId,
              '@path': relPath,
              '@name': entry.name,
              '@type': isDir ? 'folder' : 'file',
              '@size': s.size,
              '@mtime': Math.floor(s.mtimeMs),
              '@birthtime': Math.floor(s.birthtimeMs),
              '@inode': s.ino,
              '@deviceId': s.dev,
              '@isIgnored': isDir ? null : 0, // Parent doesn't know folder ignore state yet
              '@isHidden': isDir ? null : (repositoryService.isItemHidden(id) ? 1 : 0)
            }

            if (repositoryService.existsById(id)) {
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

  // Ensure the root itself is tracked (especially if it's the start of the scan)
  try {
    const s = await fs.stat(rootAbsPath)
    const isUserHidden = repositoryService.isItemHidden(rootId)
    // We don't check for .ignore here because the queue worker for the root will do it.
    // However, if the root itself is user-hidden, we should set it.
    fingerprintBuffer.add({
      '@id': rootId,
      '@parentId': null,
      '@path': rootRelPath,
      '@name': path.basename(rootAbsPath) || 'Library',
      '@type': 'folder',
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
  const missingItems = repositoryService.getItemsForCleanup(scopePath).filter(item => !foundPaths.has(item.id))

  log(`[Phase 1] Crawl complete. Found ${foundPaths.size} existing items, ${newItemsMap.size} potentially new items.`)

  // #2 Identity-Based Rename Rescue (O(N))
  for (const item of missingItems) {
    const key = `${item.deviceId}_${item.inode}`
    const match = newItemsMap.get(key)

    if (match) {
      log(`[Phase 1] Detected rename: "${item.path}" -> "${match['@path']}"`)
      repositoryService.migrateRecord(item.id, match['@id'], match['@path'])
      foundPaths.add(match['@id'])
      newItemsMap.delete(key)
      // Note: We don't remove from missingItems because it's a fixed array, we just mark it found.
    }
  }

  // #3 Final Sync (Insert remaining new items)
  if (newItemsMap.size > 0) {
    log(`[Phase 1] Inserting ${newItemsMap.size} new items.`)
    repositoryService.runTransaction(() => {
      // Re-use the existing writer logic
      for (const itemData of newItemsMap.values()) {
        fingerprintBuffer.add(itemData)
        foundPaths.add(itemData['@id'])
      }
      fingerprintBuffer.flush()
    })
  }

  // #4 Conditional Cleanup
  log(`[Phase 1] Reconciliation: Checking ${missingItems.length} missing items for cleanup in scope: "${scopePath}"`)
  repositoryService.runTransaction(() => {
    for (const item of missingItems) {
      // Optimization: Check if this was rescued (it should be in foundPaths now)
      if (foundPaths.has(item.id)) continue

      if (item.hasLocks) {
        log(`[Phase 1] Marking AS MISSING (has locks): ${item.path}`)
        repositoryService.markAsMissing(item.id)
      } else {
        log(`[Phase 1] DELETING (no locks): ${item.path}`)
        repositoryService.deleteItem(item.id)
      }
    }
  })

  log(`[Phase 1] Filesystem sync complete. Result: ${foundPaths.size} active items.`)
  return foundPaths
}

export async function scanDirectory(
  mediaSourcePath: string,
  options: {
    skipMetadata?: boolean,
    initialFolderSettings?: Record<string, any>
  } = {}
): Promise<MediaFolder | null> {
  const db = repositoryService.getDb()
  log(`Starting Phase 1 (Filesystem Sync) for: ${mediaSourcePath}`)

  repositoryService.ensureRootExists(mediaSourcePath)

  if (options.initialFolderSettings) {
    for (const [relPath, settings] of Object.entries(options.initialFolderSettings)) {
      const id = repositoryService.generateId(relPath)
      db.prepare(`
        INSERT INTO folder_settings (item_id, scraper_settings_json)
        VALUES (?, ?)
        ON CONFLICT(item_id) DO UPDATE SET scraper_settings_json = excluded.scraper_settings_json
      `).run(id, JSON.stringify(settings))
    }
  }

  await syncDiskToDatabase(mediaSourcePath, mediaSourcePath, db)

  return repositoryService.getRoot()
}

export async function syncWithDisk(node: MediaFolder, mediaSourcePath: string): Promise<void> {
  const db = repositoryService.getDb()
  if (!node.path) {
    log(`Cannot sync subtree with undefined path: ${node.name}`)
    return
  }
  const rootAbsPath = path.join(mediaSourcePath, node.path)

  log(`Syncing subtree: ${node.path}`)

  await syncDiskToDatabase(rootAbsPath, mediaSourcePath, db)
}

export async function verifyImagePaths(imagesDir: string): Promise<void> {
  const db = repositoryService.getDb()
  const rows = db
    .prepare('SELECT item_id, images_json FROM metadata WHERE images_json IS NOT NULL')
    .all() as { item_id: string; images_json: string }[]

  for (const row of rows) {
    const images = JSON.parse(row.images_json || '{}')
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
      db.prepare('UPDATE metadata SET images_json = ? WHERE item_id = ?').run(
        JSON.stringify(images),
        row.item_id
      )
    }
  }
}

export function initializeRoot(
  mediaSourcePath: string,
  initialFolderSettings?: Record<string, any>
): void {
  const db = repositoryService.getDb()
  const rootId = repositoryService.generateId('.')
  const rootName = path.basename(mediaSourcePath)

  db.prepare(
    `
      INSERT INTO items (id, parent_id, path, name, type, is_missing)
      VALUES (?, NULL, '.', ?, 'folder', 0)
      ON CONFLICT(id) DO UPDATE SET is_missing = 0, name = excluded.name
    `
  ).run(rootId, rootName)

  if (initialFolderSettings && initialFolderSettings['.']) {
    const rootSettings = initialFolderSettings['.']
    db.prepare(
      `
      INSERT INTO folder_settings (item_id, scraper_settings_json)
      VALUES (@id, @settingsJson)
      ON CONFLICT(item_id) DO UPDATE SET
        scraper_settings_json = excluded.scraper_settings_json
    `
    ).run({
      '@id': rootId,
      '@settingsJson': JSON.stringify(rootSettings)
    })
  }
}
