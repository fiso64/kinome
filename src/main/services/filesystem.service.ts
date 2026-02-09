import path from 'path'
import fs from 'fs/promises'
import { type Dirent } from 'fs'
import * as repositoryService from './repository.service'
import * as pathsService from './paths.service'
import type { MediaFolder } from '@shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Filesystem Service] ${message}`)
}


/**
 * Phase 1: Filesystem Sync (Disk -> DB)
 * Refactored to use Recursive DFS for "Seal the Gate" mtime logic.
 */
async function walk(
  currentPath: string,
  parentId: string | null,
  mediaSourcePath: string,
  db: any,
  visitedIds: Set<string>,
  statements: {
    selectFolderMtime: any
    upsertItem: any
    sealFolder: any
  }
): Promise<void> {
  const relativePath = path.relative(mediaSourcePath, currentPath).replace(/\\/g, '/') || '.'
  const id = repositoryService.generateId(relativePath)
  visitedIds.add(id)

  let stats: any
  try {
    stats = await fs.stat(currentPath)
  } catch (e) {
    log(`Failed to stat: ${currentPath}`)
    return
  }

  const isDirectory = stats.isDirectory()
  const dbMtime = statements.selectFolderMtime.get(id)?.mtime ?? 0
  const diskMtime = Math.floor(stats.mtimeMs)

  // 1. Initial Gate Check (Folders only)
  if (isDirectory && id !== repositoryService.generateId('.') && dbMtime === diskMtime) {
    // O(1) Skip: Mark all known descendants as visited to prevent they logic from marking them missing
    const descendantIds = repositoryService.getAllDescendantIdsFast(id)
    descendantIds.forEach((dId) => visitedIds.add(dId))
    return
  }

  // 2. Process CURRENT Level (Files and Folders)
  // We read the directory entries.
  let entries: Dirent[]
  try {
    entries = isDirectory ? await fs.readdir(currentPath, { withFileTypes: true }) : []
  } catch (e) {
    log(`Failed to readdir: ${currentPath}`)
    return
  }

  // Filter and process entries
  const childrenToProcess: { fullPath: string; name: string; isDir: boolean }[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.ignore') continue
    const isDir = entry.isDirectory()
    const isVideoFile = !isDir && /\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(entry.name)
    if (!isDir && !isVideoFile) continue

    const fullPath = path.join(currentPath, entry.name)
    const childRelPath = path.relative(mediaSourcePath, fullPath).replace(/\\/g, '/')
    const childId = repositoryService.generateId(childRelPath)

    let childStats = { size: 0, mtime: 0, birthtime: 0 }
    try {
      const s = await fs.stat(fullPath)
      childStats = {
        size: s.size,
        mtime: Math.floor(s.mtimeMs),
        birthtime: Math.floor(s.birthtimeMs)
      }
    } catch { }

    // Upsert entry (Fingerprint sync)
    // For folders, we do NOT set mtime here.
    statements.upsertItem.run({
      '@id': childId,
      '@parentId': id,
      '@path': childRelPath,
      '@name': entry.name,
      '@type': isDir ? 'folder' : 'file',
      '@size': childStats.size,
      '@mtime': isDir ? null : childStats.mtime,
      '@birthtime': childStats.birthtime
    })

    visitedIds.add(childId)
    if (isDir) {
      childrenToProcess.push({ fullPath, name: entry.name, isDir: true })
    }
  }

  // 3. Descend RECURSIVELY
  for (const child of childrenToProcess) {
    await walk(child.fullPath, id, mediaSourcePath, db, visitedIds, statements)
  }

  // 4. Seal the Gate
  // Update the DB mtime ONLY after all children are successfully processed.
  if (isDirectory) {
    statements.sealFolder.run({
      '@id': id,
      '@mtime': diskMtime
    })
  }
}

async function syncDiskToDatabase(
  rootAbsPath: string,
  mediaSourcePath: string,
  db: any
): Promise<Set<string>> {
  const visitedIds = new Set<string>()

  const statements = {
    selectFolderMtime: db.prepare('SELECT mtime FROM items WHERE id = ?'),
    upsertItem: db.prepare(`
      INSERT INTO items (id, parent_id, path, name, type, size, mtime, birthtime, is_missing)
      VALUES (@id, @parentId, @path, @name, @type, @size, @mtime, @birthtime, 0)
      ON CONFLICT(id) DO UPDATE SET
        is_missing = 0,
        parent_id = excluded.parent_id,
        size = excluded.size,
        mtime = COALESCE(excluded.mtime, items.mtime)
    `),
    sealFolder: db.prepare('UPDATE items SET mtime = @mtime WHERE id = @id')
  }

  // Ensure root exists
  const rootRelPath = path.relative(mediaSourcePath, rootAbsPath).replace(/\\/g, '/') || '.'
  const rootId = repositoryService.generateId(rootRelPath)
  const rootName = path.basename(rootAbsPath) || 'Library'

  db.prepare(`
    INSERT INTO items (id, parent_id, path, name, type, is_missing)
    VALUES (?, NULL, ?, ?, 'folder', 0)
    ON CONFLICT(id) DO UPDATE SET is_missing = 0, name = excluded.name
  `).run(rootId, rootRelPath, rootName)

  await walk(rootAbsPath, null, mediaSourcePath, db, visitedIds, statements)

  // #1 Conditional Cleanup (Ghost Items vs Deletion)
  const scopePath = rootRelPath === '.' ? '' : rootRelPath
  const itemsInScope = repositoryService.getItemsForCleanup(scopePath)

  repositoryService.runTransaction(() => {
    for (const item of itemsInScope) {
      if (!visitedIds.has(item.id)) {
        if (item.hasLocks) {
          repositoryService.markAsMissing(item.id)
        } else {
          repositoryService.deleteItem(item.id)
        }
      }
    }
  })

  return visitedIds
}


export async function scanDirectory(
  mediaSourcePath: string,
  options: {
    skipMetadata?: boolean,
    initialFolderSettings?: Record<string, any>
  } = {}
): Promise<MediaFolder | null> {
  const db = repositoryService.getDb()
  log(
    `Starting Phase 1 (Filesystem Sync) for: ${mediaSourcePath}`
  )

  repositoryService.ensureRootExists(mediaSourcePath)

  // Handle initial folder settings if provided (e.g. for the root)
  // This ensures Gate A/B are established before Phase 2 starts.
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

  // Check all images in one pass
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

/**
 * Explicitly initializes the root folder in the database.
 * This allows the API to return success immediately while the background scan continues.
 */
export function initializeRoot(
  mediaSourcePath: string,
  initialFolderSettings?: Record<string, any>
): void {
  const db = repositoryService.getDb()
  const rootId = repositoryService.generateId('.')
  const rootName = path.basename(mediaSourcePath)

  // Upsert Root
  db.prepare(
    `
      INSERT INTO items (id, parent_id, path, name, type, is_missing)
      VALUES (?, NULL, '.', ?, 'folder', 0)
      ON CONFLICT(id) DO UPDATE SET is_missing = 0, name = excluded.name
    `
  ).run(rootId, rootName)

  // Apply Root Settings
  if (initialFolderSettings && initialFolderSettings['.']) {
    const rootSettings = initialFolderSettings['.']
    const hasHint = rootSettings.retrieve_children_metadata && rootSettings.children_type_hint

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
