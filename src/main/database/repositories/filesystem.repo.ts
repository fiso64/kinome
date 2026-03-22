/**
 * ITEMS REPOSITORY (Physical Filesystem Anchor)
 * Owns the 'items' table. Handles identity (IDs, Paths, Inodes) and filesystem stats.
 */
import path from 'path'
import crypto from 'crypto'
import { getDb, runTransaction } from '../client'

/** Stable ID for the singleton library virtual root (parents all source roots). */
export const LIBRARY_ROOT_ID = 'virtual-library-root'

/**
 * Generates a stable ID for a filesystem item.
 * The sourceId is the UUID of the MediaSource — it never changes even if the path moves.
 */
export function generateId(sourceId: string, relativePath: string): string {
    return crypto.createHash('sha256').update(`${sourceId}:${relativePath}`).digest('hex')
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
           f.view_settings_json, f.retrieve_children_metadata, f.children_type_hint, f.process_tv_children
`

// --- READ OPERATIONS ---

/**
 * Fetches the library virtual root item raw data.
 */
export function fetchRoot(): any {
    const db = getDb()
    return db
        .prepare(`${FULL_SELECT_SQL} ${FULL_JOIN_SQL} WHERE i.id = ?`)
        .get(LIBRARY_ROOT_ID)
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
           f.view_settings_json, f.retrieve_children_metadata, f.children_type_hint, f.process_tv_children
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
           f.view_settings_json, f.retrieve_children_metadata, f.children_type_hint, f.process_tv_children
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
           f.view_settings_json, f.retrieve_children_metadata, f.children_type_hint, f.process_tv_children
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
 * Returns all item IDs for a given source, optionally scoped to a path prefix.
 */
export function getAllIdsInScope(sourceId: string, pathPrefix: string): string[] {
    const db = getDb()
    const isRoot = pathPrefix === '' || pathPrefix === '.'
    const query = isRoot
        ? 'SELECT id FROM items WHERE source_id = ? AND is_virtual = 0'
        : 'SELECT id FROM items WHERE source_id = ? AND (path LIKE ? OR path = ?) AND is_virtual = 0'
    const params = isRoot ? [sourceId] : [sourceId, `${pathPrefix}/%`, pathPrefix]

    const rows = db.prepare(query).all(...params) as { id: string }[]
    return rows.map((r) => r.id)
}

/**
 * Returns all relative paths for items in a given source (folders only).
 */
export function getAllFolderPathsInSource(sourceId: string): Set<string> {
    const db = getDb()
    const rows = db.prepare(
        `SELECT path FROM items WHERE source_id = ? AND type = 'folder' AND is_virtual = 0`
    ).all(sourceId) as { path: string }[]
    return new Set(rows.map((r) => r.path))
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
 * Always scoped to a single source to prevent cross-source pollution during cleanup.
 */
export function getItemsForCleanup(
    sourceId: string,
    pathPrefix: string
): { id: string; path: string; hasLocks: boolean; inode: number; deviceId: number }[] {
    const db = getDb()
    const isRoot = pathPrefix === '' || pathPrefix === '.'

    const query = `
    SELECT i.id, i.path, i.inode, i.device_id, e.locked_fields_json
    FROM items i
    LEFT JOIN media_entities e ON i.entity_id = e.id
    WHERE i.source_id = ? AND i.is_virtual = 0
    ${isRoot ? '' : 'AND (i.path LIKE ? OR i.path = ?)'}
  `
    const params = isRoot ? [sourceId] : [sourceId, `${pathPrefix}/%`, pathPrefix]

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
    INSERT INTO items (id, parent_id, path, name, type, source_id, size, mtime, birthtime, inode, device_id, is_missing, is_ignored, is_hidden)
    VALUES (@id, @parentId, @path, @name, @type, @sourceId, @size, @mtime, @birthtime, @inode, @deviceId, 0, @isIgnored, @isHidden)
    ON CONFLICT(id) DO UPDATE SET
      is_missing = 0,
      parent_id = excluded.parent_id,
      source_id = excluded.source_id,
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
 * Initializes/Updates a source root item (child of the library virtual root).
 */
export function upsertRootItem(id: string, name: string, sourceId: string): void {
    const db = getDb()
    db.prepare(
        `
      INSERT INTO items (id, parent_id, path, name, type, source_id, is_missing)
      VALUES (?, ?, '.', ?, 'folder', ?, 0)
      ON CONFLICT(id) DO UPDATE SET is_missing = 0, name = excluded.name, source_id = excluded.source_id
    `
    ).run(id, LIBRARY_ROOT_ID, name, sourceId)
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
export function updateItemPathAndId(oldId: string, newRelativePath: string, sourceId: string): void {
    const db = getDb()
    const newId = generateId(sourceId, newRelativePath)
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
 * Fast lookup of source_id for an item. Used to resolve absolute paths at runtime.
 */
export function getItemSourceId(itemId: string): string | null {
    const db = getDb()
    const row = db.prepare('SELECT source_id FROM items WHERE id = ?').get(itemId) as
        | { source_id: string | null }
        | undefined
    return row?.source_id ?? null
}

/**
 * Ensures the singleton library virtual root exists.
 * This is the DB root that parents all source root items.
 * Safe to call on every startup (INSERT OR IGNORE).
 */
export function ensureLibraryVirtualRoot(): void {
    const db = getDb()
    db.prepare(
        `
    INSERT OR IGNORE INTO items (id, parent_id, path, name, type, source_id, is_virtual, virtual_type, is_missing)
    VALUES (?, NULL, ?, 'Library', 'folder', NULL, 1, 'home', 0)
    `
    ).run(LIBRARY_ROOT_ID, `virtual://${LIBRARY_ROOT_ID}`)
}

/**
 * Ensures a source root item exists (child of the library virtual root).
 * Safe to call on every startup (uses upsertRootItem which does INSERT OR REPLACE on id).
 */
export function ensureSourceRoot(sourceId: string, resolvedAbsPath: string): void {
    const name =
        resolvedAbsPath === '.' || resolvedAbsPath === '/'
            ? 'Library'
            : resolvedAbsPath.split(/[/\\]/).filter(Boolean).pop() || 'Library'
    const rootId = generateId(sourceId, '.')
    upsertRootItem(rootId, name, sourceId)
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

/** Stable IDs for the default home subfolders (created once, deletable by user). */
export const HOME_CATEGORIES_ID = 'virtual-home-categories'
export const HOME_RECENTLY_ADDED_ID = 'virtual-home-recently-added'
export const HOME_GENRES_ID = 'virtual-home-genres'
export const HOME_ALL_MEDIA_ID = 'virtual-home-all-media'

/**
 * Ensures the home virtual folder exists.
 * Uses INSERT OR IGNORE with a fixed ID so it is safe to call on every startup.
 * The home folder has virtual_type='home' and a filter scoped to the library root.
 */
export function ensureHomeVirtualFolder(rootId: string): void {
    const db = getDb()
    const filter: import('@shared/types').LibraryFilter = {
        conditionGroups: [
            [{ field: 'parent.retrieveChildrenMetadata', op: 'eq', value: 1 }],
            [{ field: 'mediaType', op: 'eq', value: 'movie' }],
            [{ field: 'mediaType', op: 'eq', value: 'tv' }],
        ],
    }
    const filterJson = JSON.stringify(filter)
    db.prepare(`
        INSERT OR IGNORE INTO items (id, parent_id, path, name, type, is_virtual, virtual_type, filter_json)
        VALUES (?, ?, 'virtual://home', '__home__', 'folder', 1, 'home', ?)
    `).run(HOME_FOLDER_ID, rootId, filterJson)
}


/**
 * Ensures the three default home subfolders exist.
 * Uses INSERT OR IGNORE with stable IDs — safe to call on every startup.
 * The folders are created as virtualType='user' so users can delete them.
 */
export function ensureHomeChildren(): void {
    const db = getDb()
    const insert = db.prepare(`
        INSERT OR IGNORE INTO items (id, parent_id, path, name, type, is_virtual, virtual_type, filter_json)
        VALUES (?, ?, ?, ?, 'folder', 1, 'user', ?)
    `)

    // "Categories": all home items, grouped by _home_category
    insert.run(
        HOME_CATEGORIES_ID,
        HOME_FOLDER_ID,
        `virtual://${HOME_CATEGORIES_ID}`,
        'Categories',
        JSON.stringify({ scope: { parentId: HOME_FOLDER_ID } })
    )

    // "Recently Added": home items added within the last 14 days
    insert.run(
        HOME_RECENTLY_ADDED_ID,
        HOME_FOLDER_ID,
        `virtual://${HOME_RECENTLY_ADDED_ID}`,
        'Recently Added',
        JSON.stringify({
            scope: { parentId: HOME_FOLDER_ID },
            conditions: [{ field: 'addedDaysAgo', op: 'lte', value: 14 }]
        })
    )

    // "Genres": all home items, grouped by genre
    insert.run(
        HOME_GENRES_ID,
        HOME_FOLDER_ID,
        `virtual://${HOME_GENRES_ID}`,
        'Genres',
        JSON.stringify({ scope: { parentId: HOME_FOLDER_ID } })
    )

    // "All Media": all home items, inside Categories
    insert.run(
        HOME_ALL_MEDIA_ID,
        HOME_CATEGORIES_ID,
        `virtual://${HOME_ALL_MEDIA_ID}`,
        'All Media',
        JSON.stringify({ scope: { parentId: HOME_FOLDER_ID } })
    )
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
