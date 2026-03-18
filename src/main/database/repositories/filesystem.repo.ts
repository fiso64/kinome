/**
 * ITEMS REPOSITORY (Physical Filesystem Anchor)
 * Owns the 'items' table. Handles identity (IDs, Paths, Inodes) and filesystem stats.
 */
import path from 'path'
import crypto from 'crypto'
import { getDb, runTransaction } from '../client'

/**
 * Generates a stable ID for a filesystem path.
 */
export function generateId(relativePath: string): string {
    return crypto.createHash('sha256').update(relativePath).digest('hex')
}

// --- Shared SQL fragments ---
// CRITICAL: We CANNOT use `e.*` because `e.id` would shadow `i.id` in bun:sqlite's
// row-to-object conversion (last column with same name wins). Instead, we explicitly
// list all media_entities columns except `id`, which is only selected as `_entity_id`.
export const ENTITY_COLUMNS_SQL = `
    e.id AS _entity_id,
    e.tmdb_id, e.media_type, e.title, e.original_title, e.overview,
    e.release_date, e.year, e.runtime,
    e.season_number, e.episode_number, e.parent_entity_id,
    e.poster_path, e.backdrop_path, e.logo_path,
    e.locked_fields_json, e.last_refreshed_at, e.version,
    (SELECT json_group_array(g.name) FROM entity_genres eg JOIN genres g ON eg.genre_id = g.id WHERE eg.entity_id = e.id) AS genres,
    (SELECT json_group_object(t.key, t.value) FROM entity_tags t WHERE t.entity_id = e.id) AS tags,
    (SELECT json_group_object(vt.key, vt.value) FROM entity_virtual_tags vt WHERE vt.entity_id = e.id) AS virtualTags,
    (SELECT json_group_array(json_object('id', p.id, 'name', p.name, 'profile_path', p.profile_path, 'credit_type', c.credit_type, 'character', c.character, 'job', c.job, 'order', c.display_order)) FROM credits c JOIN people p ON c.person_id = p.id WHERE c.entity_id = e.id) AS tmdbCredits`

const FULL_JOIN_SQL = `
    FROM items i
    LEFT JOIN media_entities e ON i.entity_id = e.id
    LEFT JOIN user_state u ON i.id = u.item_id
    LEFT JOIN folder_settings f ON i.id = f.item_id
`

const FULL_SELECT_SQL = `
    SELECT i.*, ${ENTITY_COLUMNS_SQL},
           u.watched, u.last_watched_at, u.continue_watching_dismissed, u.next_up_dismissed, u.next_up_episode_id,
           f.view_settings_json, f.scraper_settings_json
`

// --- READ OPERATIONS ---

/**
 * Fetches the root item raw data.
 */
export function fetchRoot(): any {
    const db = getDb()
    return db
        .prepare(`${FULL_SELECT_SQL} ${FULL_JOIN_SQL} WHERE i.parent_id IS NULL LIMIT 1`)
        .get()
}

/**
 * Fetches a single item by ID with all joins.
 */
export function fetchItemById(id: string): any {
    const db = getDb()
    return db
        .prepare(`${FULL_SELECT_SQL} ${FULL_JOIN_SQL} WHERE i.id = ?`)
        .get(id)
}

/**
 * Fetches an item by path.
 */
export function fetchItemByPath(pathStr: string): any {
    const db = getDb()
    return db
        .prepare(`${FULL_SELECT_SQL} ${FULL_JOIN_SQL} WHERE i.path = ?`)
        .get(pathStr)
}

/**
 * Fetches the parent of an item.
 */
export function fetchParent(id: string): any {
    const db = getDb()
    return db
        .prepare(
            `
    SELECT p.*, ${ENTITY_COLUMNS_SQL},
           u.watched, u.last_watched_at, u.continue_watching_dismissed, u.next_up_dismissed, u.next_up_episode_id,
           f.view_settings_json, f.scraper_settings_json
    FROM items i
    JOIN items p ON i.parent_id = p.id
    LEFT JOIN media_entities e ON p.entity_id = e.id
    LEFT JOIN user_state u ON p.id = u.item_id
    LEFT JOIN folder_settings f ON p.id = f.item_id
    WHERE i.id = ?
  `
        )
        .get(id)
}

/**
 * Fetches all descendants as a flat list of raw rows.
 */
export function fetchAllDescendantsRaw(nodeId: string): any[] {
    const db = getDb()
    return db
        .prepare(
            `
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM items WHERE parent_id = ?
      UNION ALL
      SELECT i.id FROM items i
      JOIN tree t ON i.parent_id = t.id
    )
    SELECT i.*, ${ENTITY_COLUMNS_SQL},
           u.watched, u.last_watched_at, u.continue_watching_dismissed, u.next_up_dismissed, u.next_up_episode_id,
           f.view_settings_json, f.scraper_settings_json
    FROM items i
    JOIN tree t ON i.id = t.id
    LEFT JOIN media_entities e ON i.entity_id = e.id
    LEFT JOIN user_state u ON i.id = u.item_id
    LEFT JOIN folder_settings f ON i.id = f.item_id
  `
        )
        .all(nodeId) as any[]
}

/**
 * Fetches ancestors chain as raw rows.
 */
export function fetchAncestorsRaw(itemId: string): any[] {
    const db = getDb()
    return db
        .prepare(
            `
    WITH RECURSIVE ancestors(id, parent_id, level) AS (
      SELECT id, parent_id, 0 FROM items WHERE id = ?
      UNION ALL
      SELECT i.id, i.parent_id, a.level + 1
      FROM items i
      JOIN ancestors a ON i.id = a.parent_id
    )
    SELECT i.*, ${ENTITY_COLUMNS_SQL},
           u.watched, u.last_watched_at, u.continue_watching_dismissed, u.next_up_dismissed, u.next_up_episode_id,
           f.view_settings_json, f.scraper_settings_json
    FROM items i
    JOIN ancestors a ON i.id = a.id
    LEFT JOIN media_entities e ON i.entity_id = e.id
    LEFT JOIN user_state u ON i.id = u.item_id
    LEFT JOIN folder_settings f ON i.id = f.item_id
    WHERE i.id != ?
    ORDER BY a.level ASC
  `
        )
        .all(itemId, itemId) as any[]
}

/**
 * Executes a dynamic find query.
 */
export function rawFind(query: string, params: any[]): any[] {
    const db = getDb()
    return db.prepare(query).all(...params) as any[]
}

// --- WRITE OPERATIONS ---

/**
 * Lightweight existence check by ID.
 */
export function existsById(id: string): boolean {
    const db = getDb()
    return !!db.prepare('SELECT 1 FROM items WHERE id = ?').get(id)
}

/**
 * Fast path lookup.
 */
export function getItemPath(id: string): string | null {
    const db = getDb()
    const row = db.prepare('SELECT path FROM items WHERE id = ?').get(id) as
        | { path: string }
        | undefined
    return row?.path ?? null
}

/**
 * Fast check for user-hidden status.
 */
export function isItemHidden(id: string): boolean {
    const db = getDb()
    const row = db.prepare('SELECT is_hidden FROM items WHERE id = ?').get(id) as
        | { is_hidden: number }
        | undefined
    return !!row?.is_hidden
}

/**
 * Returns all item IDs that start with a given path prefix.
 */
export function getAllIdsInScope(pathPrefix: string): string[] {
    const db = getDb()
    const isRoot = pathPrefix === '' || pathPrefix === '.'
    const query = isRoot
        ? 'SELECT id FROM items WHERE is_virtual = 0'
        : 'SELECT id FROM items WHERE (path LIKE ? OR path = ?) AND is_virtual = 0'
    const params = isRoot ? [] : [`${pathPrefix}/%`, pathPrefix]

    const rows = db.prepare(query).all(...params) as { id: string }[]
    return rows.map((r) => r.id)
}

/**
 * Returns a raw list of all descendant IDs for a given folder.
 */
export function getAllDescendantIdsFast(parentId: string): string[] {
    const db = getDb()
    const rows = db
        .prepare(
            `
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM items WHERE parent_id = ?
      UNION ALL
      SELECT i.id FROM items i
      JOIN tree t ON i.parent_id = t.id
    )
    SELECT id FROM tree
  `
        )
        .all(parentId) as { id: string }[]
    return rows.map((r) => r.id)
}

/**
 * Returns items in a scope with their locked fields status.
 */
export function getItemsForCleanup(
    pathPrefix: string
): { id: string; path: string; hasLocks: boolean; inode: number; deviceId: number }[] {
    const db = getDb()
    const isRoot = pathPrefix === '' || pathPrefix === '.'

    const query = `
    SELECT i.id, i.path, i.inode, i.device_id, e.locked_fields_json
    FROM items i
    LEFT JOIN media_entities e ON i.entity_id = e.id
    ${isRoot ? 'WHERE i.is_virtual = 0' : 'WHERE (i.path LIKE ? OR i.path = ?) AND i.is_virtual = 0'}
  `
    const params = isRoot ? [] : [`${pathPrefix}/%`, pathPrefix]

    const rows = db.prepare(query).all(...params) as {
        id: string
        path: string
        inode: number
        device_id: number
        locked_fields_json: string | null
    }[]

    return rows.map((row) => ({
        id: row.id,
        path: row.path,
        hasLocks:
            !!row.locked_fields_json &&
            row.locked_fields_json !== '[]' &&
            row.locked_fields_json !== 'null',
        inode: row.inode,
        deviceId: row.device_id
    }))
}

/**
 * Marks an item as missing.
 */
export function markAsMissing(id: string): void {
    const db = getDb()
    db.prepare('UPDATE items SET is_missing = 1 WHERE id = ?').run(id)
}

/**
 * Deletes an item.
 */
export function deleteItem(itemId: string): void {
    const db = getDb()
    db.prepare('DELETE FROM items WHERE id = ?').run(itemId)
}

/**
 * Upserts a batch of library items.
 */
export function upsertLibraryItems(items: any[]): void {
    const db = getDb()
    const stmt = db.prepare(`
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

    runTransaction(() => {
        for (const item of items) {
            stmt.run(item)
        }
    })
}

/**
 * Initializes/Updates the root item.
 */
export function upsertRootItem(id: string, name: string): void {
    const db = getDb()
    db.prepare(
        `
      INSERT INTO items (id, parent_id, path, name, type, is_missing)
      VALUES (?, NULL, '.', ?, 'folder', 0)
      ON CONFLICT(id) DO UPDATE SET is_missing = 0, name = excluded.name
    `
    ).run(id, name)
}

/**
 * Migrates a record from an old ID/path to a new one.
 */
export function migrateRecord(oldId: string, newId: string, newPath: string): void {
    const db = getDb()

    runTransaction(() => {
        db.prepare('DELETE FROM items WHERE id = ?').run(newId)
        db.prepare('UPDATE items SET id = ?, path = ?, is_missing = 0 WHERE id = ?').run(
            newId,
            newPath,
            oldId
        )
    })
}

/**
 * Updates item path and ID (rename).
 */
export function updateItemPathAndId(oldId: string, newRelativePath: string): void {
    const db = getDb()
    const newId = generateId(newRelativePath)
    const newName = path.basename(newRelativePath)

    runTransaction(() => {
        db.prepare('UPDATE items SET id = ?, path = ?, name = ? WHERE id = ?').run(
            newId,
            newRelativePath,
            newName,
            oldId
        )
    })
}

/**
 * Ensures a root node exists in the database.
 */
export function ensureRootExists(mediaSourcePath: string): void {
    const db = getDb()
    const rootId = generateId('.')
    const rootName =
        mediaSourcePath === '.' || mediaSourcePath === '/'
            ? 'Library'
            : mediaSourcePath.split(/[/\\]/).filter(Boolean).pop() || 'Library'

    if (!!db.prepare('SELECT 1 FROM items WHERE parent_id IS NULL').get()) return

    db.prepare(
        `
    INSERT INTO items (id, parent_id, path, name, type, is_missing)
    VALUES (?, NULL, '.', ?, 'folder', 0)
    `
    ).run(rootId, rootName)
}
/**
 * Updates item visibility flags.
 */
export function updateItemVisibility(itemId: string, hidden?: boolean, missing?: boolean): void {
    const db = getDb()
    db.prepare(
        `
    UPDATE items SET
      is_hidden = COALESCE(@isHidden, is_hidden),
      is_missing = COALESCE(@isMissing, is_missing)
    WHERE id = @id
    `
    ).run({
        '@id': itemId,
        '@isHidden': hidden === undefined ? null : hidden ? 1 : 0,
        '@isMissing': missing === undefined ? null : missing ? 1 : 0
    })
}

/**
 * Links an item to a media entity.
 */
export function setEntityId(itemId: string, entityId: string | null): void {
    const db = getDb()
    db.prepare('UPDATE items SET entity_id = ? WHERE id = ?').run(entityId, itemId)
}

/**
 * Updates the filter_json column for a virtual folder item.
 */
export function updateFilterJson(itemId: string, filterJson: string | null): void {
    const db = getDb()
    db.prepare('UPDATE items SET filter_json = ? WHERE id = ?').run(filterJson, itemId)
}

/**
 * Inserts a virtual folder item.
 * Pass insertOrIgnore=true for idempotent season folder creation (deterministic IDs).
 */
export function insertVirtualItem(params: {
    id: string
    parentId: string
    name: string
    virtualType: 'user' | 'grouping' | 'season' | 'home'
    filterJson?: string
    insertOrIgnore?: boolean
}): void {
    const db = getDb()
    const verb = params.insertOrIgnore ? 'INSERT OR IGNORE' : 'INSERT'
    db.prepare(`
        ${verb} INTO items (id, parent_id, path, name, type, is_virtual, virtual_type, filter_json)
        VALUES (?, ?, ?, ?, 'folder', 1, ?, ?)
    `).run(
        params.id,
        params.parentId,
        `virtual://${params.id}`,
        params.name,
        params.virtualType,
        params.filterJson ?? null
    )
}

/**
 * Returns distinct season numbers from real file children of the given parent.
 * Used by syncVirtualSeasonFolders to know which virtual season folders are needed.
 */
export function getDistinctSeasonNumbers(parentId: string): number[] {
    const db = getDb()
    const rows = db.prepare(`
        SELECT DISTINCT e.season_number
        FROM items i
        LEFT JOIN media_entities e ON i.entity_id = e.id
        WHERE i.parent_id = ? AND i.is_virtual = 0 AND i.type = 'file' AND e.season_number IS NOT NULL
    `).all(parentId) as { season_number: number }[]
    return rows.map((r) => r.season_number)
}

/**
 * Returns IDs of all virtual season folders under a given parent.
 * Used by syncVirtualSeasonFolders to detect orphans.
 */
export function getVirtualSeasonFolderIds(parentId: string): string[] {
    const db = getDb()
    const rows = db.prepare(
        `SELECT id FROM items WHERE parent_id = ? AND virtual_type = 'season'`
    ).all(parentId) as { id: string }[]
    return rows.map((r) => r.id)
}

/**
 * Returns IDs of all grouping virtual folders under a given parent.
 */
export function getVirtualGroupingFolderIds(parentId: string): string[] {
    const db = getDb()
    const rows = db.prepare(
        `SELECT id FROM items WHERE parent_id = ? AND virtual_type = 'grouping'`
    ).all(parentId) as { id: string }[]
    return rows.map((r) => r.id)
}

/**
 * Returns all folder IDs that have an active appliedGrouping (excluding season grouping).
 * Used by the sync hook to know which folders need grouping refresh.
 */
export function getFoldersWithActiveGrouping(): { item_id: string, group_by_key: string }[] {
    const db = getDb()
    return db.prepare(`
        SELECT item_id, json_extract(view_settings_json, '$.appliedGrouping') AS group_by_key
        FROM folder_settings
        WHERE json_extract(view_settings_json, '$.appliedGrouping') IS NOT NULL
          AND json_extract(view_settings_json, '$.appliedGrouping') != 'seasonNumber'
    `).all() as { item_id: string, group_by_key: string }[]
}

/** Stable ID for the singleton home virtual folder. */
export const HOME_FOLDER_ID = 'virtual-home'

/**
 * Ensures the home virtual folder exists.
 * Uses INSERT OR IGNORE with a fixed ID so it is safe to call on every startup.
 * The home folder has virtual_type='home' and a filter scoped to the library root.
 */
export function ensureHomeVirtualFolder(rootId: string): void {
    const db = getDb()
    const filterJson = JSON.stringify({ scope: { parentId: rootId } })
    db.prepare(`
        INSERT OR IGNORE INTO items (id, parent_id, path, name, type, is_virtual, virtual_type, filter_json)
        VALUES (?, ?, 'virtual://home', '__home__', 'folder', 1, 'home', ?)
    `).run(HOME_FOLDER_ID, rootId, filterJson)
}


/**
 * Deletes all virtual children of a given parent with the specified virtual_type.
 * Used to atomically rebuild grouping folders and to clean up orphaned season folders.
 */
export function deleteVirtualItemsByType(
    parentId: string,
    virtualType: 'user' | 'grouping' | 'season' | 'home'
): void {
    const db = getDb()
    db.prepare('DELETE FROM items WHERE parent_id = ? AND virtual_type = ?').run(
        parentId,
        virtualType
    )
}
