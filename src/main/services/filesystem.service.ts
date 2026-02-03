import path from 'path'
import fs from 'fs/promises'
import { type Dirent } from 'fs'
import * as repositoryService from './repository.service'
import type { MediaFolder } from '../../shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Filesystem Service] ${message}`)
}

/**
 * Common walker function used by both Full and Partial scans.
 * It recursively reads the FS and upserts items into the DB.
 * It returns a Set of all IDs encountered during the walk.
 */
async function walkAndUpsert(
  startPath: string,
  mediaSourcePath: string,
  db: any
): Promise<Set<string>> {
  const visitedIds = new Set<string>()
  const queue: { currentPath: string; parentId: string | null }[] = []

  // Initialize queue
  if (startPath === mediaSourcePath) {
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

    visitedIds.add(rootId)
    queue.push({ currentPath: startPath, parentId: rootId })
  } else {
    // Partial Scan start logic
    const relativePath = path.relative(mediaSourcePath, startPath).replace(/\\/g, '/')
    const id = repositoryService.generateId(relativePath)

    queue.push({ currentPath: startPath, parentId: id })
  }

  // Hoist prepared statements for performance
  const selectFolderSettingsStmt = db.prepare(
    'SELECT scraper_settings_json, items.name FROM items LEFT JOIN folder_settings ON items.id = folder_settings.item_id WHERE items.id = ?'
  )

  const upsertItemStmt = db.prepare(
    `
      INSERT INTO items (id, parent_id, path, name, type, size, mtime, birthtime, is_missing)
      VALUES (@id, @parentId, @path, @name, @type, @size, @mtime, @birthtime, 0)
      ON CONFLICT(id) DO UPDATE SET
        is_missing = 0,
        parent_id = excluded.parent_id,
        size = excluded.size,
        mtime = excluded.mtime
    `
  )

  const upsertMetadataStmt = db.prepare(
    `
      INSERT INTO metadata (item_id, media_type, season_number, episode_number)
      VALUES (@id, @mediaType, @seasonNumber, @episodeNumber)
      ON CONFLICT(item_id) DO UPDATE SET
        media_type = COALESCE(media_type, excluded.media_type),
        season_number = COALESCE(season_number, excluded.season_number),
        episode_number = COALESCE(episode_number, excluded.episode_number)
    `
  )

  while (queue.length > 0) {
    const { currentPath, parentId } = queue.shift()!
    if (!parentId) continue

    let entries: Dirent[]
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true })
    } catch (e) {
      log(`Failed to read directory: ${currentPath}`)
      continue
    }

    // ---------------------------------------------------------
    // Phase 1: Context Retrieval
    // ---------------------------------------------------------
    const currentFolderRow = selectFolderSettingsStmt.get(parentId)
    const scraperSettings = repositoryService.parseJsonSafe<any>(
      currentFolderRow?.scraper_settings_json,
      {}
    )

    const retrieveChildrenMetadata =
      scraperSettings.retrieve_children_metadata !== false


    const operations: (() => void)[] = []

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.ignore') continue

      const isDirectory = entry.isDirectory()
      const isVideoFile = entry.isFile() && /\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(entry.name)

      if (!isDirectory && !isVideoFile) continue

      const fullPath = path.join(currentPath, entry.name)
      const relativePath = path.relative(mediaSourcePath, fullPath).replace(/\\/g, '/')
      const id = repositoryService.generateId(relativePath)
      const type = isDirectory ? 'folder' : 'file'

      // Stats retrieval
      let stats = { size: 0, mtime: 0, birthtime: 0 }
      try {
        const s = await fs.stat(fullPath)
        stats = { size: s.size, mtime: Math.floor(s.mtimeMs), birthtime: Math.floor(s.birthtimeMs) }
      } catch { }

      // ---------------------------------------------------------
      // Phase 3: Invariant Enforcement & Write Guard
      // ---------------------------------------------------------
      let parsedMediaType: string | null = null

      if (retrieveChildrenMetadata) {
        if (isDirectory && scraperSettings.children_type_hint) {
          parsedMediaType = scraperSettings.children_type_hint
        }
      }

      visitedIds.add(id)

      operations.push(() => {
        upsertItemStmt.run({
          '@id': id,
          '@parentId': parentId,
          '@path': relativePath,
          '@name': entry.name,
          '@type': type,
          '@size': stats.size,
          '@mtime': stats.mtime,
          '@birthtime': stats.birthtime
        })

        if (parsedMediaType) {
          upsertMetadataStmt.run({
            '@id': id,
            '@mediaType': parsedMediaType,
            '@seasonNumber': null,
            '@episodeNumber': null
          })
        }
      })

      if (isDirectory) {
        queue.push({
          currentPath: fullPath,
          parentId: id
        })
      }
    }

    if (operations.length > 0) {
      repositoryService.runTransaction(() => {
        operations.forEach((op) => op())
      })
    }
  }

  return visitedIds
}

export async function scanDirectory(
  mediaSourcePath: string
): Promise<MediaFolder | null> {
  const db = repositoryService.getDb()
  log(`Starting full scan of ${mediaSourcePath}`)

  const visitedIds = await walkAndUpsert(mediaSourcePath, mediaSourcePath, db)

  // Full Scan cleanup:
  // Any item in the DB that was NOT visited is missing.
  // We can't do "NOT IN (...100k ids...)" safely.
  // Efficient approach:
  // 1. Get all IDs currently in DB where is_missing = 0.
  // 2. Filter in JS (Set difference).
  // 3. Batch update missing.

  const allDbIds = (db
    .prepare('SELECT id FROM items WHERE is_missing = 0')
    .all() as { id: string }[]).map((row) => row.id)
  const missingIds = allDbIds.filter((id) => !visitedIds.has(id))

  if (missingIds.length > 0) {
    log(`Marking ${missingIds.length} items as missing.`)
    repositoryService.runTransaction(() => {
      const stmt = db.prepare('UPDATE items SET is_missing = 1 WHERE id = ?')
      missingIds.forEach((id) => stmt.run(id))
    })
  }

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

  // 1. Get all KNOWN descendants of this folder from the DB.
  // This allows us to know what *should* be there.
  // We explicitly use the recursive query capability here.
  const knownDescendants = repositoryService.getAllDescendantsAsList(node)
  const knownIds = new Set(knownDescendants.map((d) => d.id))

  // 2. Walk the FS subtree.
  const visitedIds = await walkAndUpsert(rootAbsPath, mediaSourcePath, db)

  // 3. Calculate missing WITHIN this subtree.
  // Missing = Known in DB - Found on Disk
  const missingIds: string[] = []
  for (const knownId of knownIds) {
    if (!visitedIds.has(knownId)) {
      missingIds.push(knownId)
    }
  }

  // 4. Mark missing.
  if (missingIds.length > 0) {
    log(`Marking ${missingIds.length} items as missing in subtree.`)
    repositoryService.runTransaction(() => {
      const stmt = db.prepare('UPDATE items SET is_missing = 1 WHERE id = ?')
      missingIds.forEach((id) => stmt.run(id))
    })
  }
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
