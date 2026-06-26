/**
 * Filesystem/media item repository.
 * Owns durable media_items and physical media_locations rows for scanned files and folders.
 */
import path from 'path'
import crypto from 'crypto'
import { getDb, runTransaction } from '../client'
import { LIBRARY_ROOT_ID } from '@shared/types'
import { ITEM_READ_MODEL } from '../query-builder'
import { resolveSelectedLocationForItem } from './media-location.repo'

export { LIBRARY_ROOT_ID }

/**
 * Generates the stable source-root ID and preserves legacy source/path-derived IDs.
 * New child filesystem items should use generateItemId() instead.
 */
export function normalizeRelativePath(relativePath: string): string {
    const withForwardSlashes = relativePath.replace(/\\/g, '/').trim()
    const normalized = path.posix.normalize(withForwardSlashes || '.')
    if (normalized === '.') return '.'
    return normalized.replace(/^\/+/, '').replace(/^\.\//, '')
}

export function relativePathFromAbsolute(sourceAbsolutePath: string, absolutePath: string): string {
    return normalizeRelativePath(path.relative(sourceAbsolutePath, absolutePath))
}

export function generateId(sourceId: string, relativePath: string): string {
    return crypto.createHash('sha256').update(`${sourceId}:${normalizeRelativePath(relativePath)}`).digest('hex')
}

export function generateItemId(): string {
    return crypto.randomUUID()
}

export function generateLocationId(sourceId: string, relativePath: string): string {
    return crypto.createHash('sha256').update(`location:${sourceId}:${normalizeRelativePath(relativePath)}`).digest('hex')
}

function nowMsSql(): string {
    return "cast(strftime('%s','now') as int) * 1000"
}

function upsertMediaItemFromLibraryRow(db: ReturnType<typeof getDb>, item: any): void {
    db.prepare(`
        INSERT INTO media_items (
            id, parent_item_id, physical_kind, media_kind, name, entity_id,
            is_virtual, virtual_type, filter_json, owner_id,
            is_hidden, logical_missing, preferred_location_id, created_at, updated_at
        )
        VALUES (
            @id, @parentId, @physicalKind,
            (SELECT media_type FROM media_entities WHERE id = @entityId),
            @name, @entityId,
            @isVirtual, @virtualType, @filterJson, @ownerId,
            COALESCE(@isHidden, 0), COALESCE(@logicalMissing, 0), NULL,
            COALESCE(@createdAt, ${nowMsSql()}), ${nowMsSql()}
        )
        ON CONFLICT(id) DO UPDATE SET
            parent_item_id = excluded.parent_item_id,
            physical_kind = excluded.physical_kind,
            media_kind = COALESCE(excluded.media_kind, media_kind),
            name = excluded.name,
            entity_id = COALESCE(excluded.entity_id, entity_id),
            is_virtual = excluded.is_virtual,
            virtual_type = excluded.virtual_type,
            filter_json = COALESCE(excluded.filter_json, filter_json),
            owner_id = COALESCE(excluded.owner_id, owner_id),
            is_hidden = CASE WHEN @isHidden IS NULL THEN is_hidden ELSE excluded.is_hidden END,
            logical_missing = excluded.logical_missing,
            updated_at = excluded.updated_at
    `).run({
        '@id': item['@id'],
        '@parentId': item['@parentId'] ?? null,
        '@physicalKind': item['@physicalKind'] ?? item['@type'],
        '@entityId': item['@entityId'] ?? null,
        '@name': item['@name'],
        '@isVirtual': item['@isVirtual'] ?? 0,
        '@virtualType': item['@virtualType'] ?? null,
        '@filterJson': item['@filterJson'] ?? null,
        '@ownerId': item['@ownerId'] ?? null,
        '@isHidden': item['@isHidden'] ?? null,
        '@logicalMissing': item['@logicalMissing'] ?? 0,
        '@createdAt': item['@createdAt'] ?? null
    })
}

function upsertMediaLocationFromLibraryRow(db: ReturnType<typeof getDb>, item: any): void {
    if (item['@isVirtual'] === 1 || !item['@sourceId']) return
    const relativePath = normalizeRelativePath(item['@path'])

    db.prepare(`
        INSERT INTO media_locations (
            id, item_id, source_id, relative_path, name, type,
            size, mtime, birthtime, inode, device_id, location_fingerprint,
            is_present, is_ignored, is_hidden, is_shadowed, shadowed_by_location_id,
            first_seen_at, last_seen_at, missing_since
        )
        VALUES (
            @locationId, @id, @sourceId, @path, @name, @type,
            @size, @mtime, @birthtime, @inode, @deviceId, @locationFingerprint,
            COALESCE(@isPresent, 1), COALESCE(@isIgnored, 0), COALESCE(@isLocationHidden, 0),
            COALESCE(@isShadowed, 0), @shadowedByLocationId,
            COALESCE(@firstSeenAt, ${nowMsSql()}), ${nowMsSql()},
            CASE WHEN COALESCE(@isPresent, 1) = 0 THEN ${nowMsSql()} ELSE NULL END
        )
        ON CONFLICT(source_id, relative_path) DO UPDATE SET
            item_id = excluded.item_id,
            name = excluded.name,
            type = excluded.type,
            size = excluded.size,
            mtime = excluded.mtime,
            birthtime = excluded.birthtime,
            inode = excluded.inode,
            device_id = excluded.device_id,
            location_fingerprint = excluded.location_fingerprint,
            is_present = excluded.is_present,
            is_ignored = CASE WHEN @isIgnored IS NULL THEN is_ignored ELSE excluded.is_ignored END,
            is_hidden = CASE WHEN @isLocationHidden IS NULL THEN is_hidden ELSE excluded.is_hidden END,
            is_shadowed = excluded.is_shadowed,
            shadowed_by_location_id = excluded.shadowed_by_location_id,
            last_seen_at = excluded.last_seen_at,
            missing_since = excluded.missing_since
    `).run({
        '@locationId': item['@locationId'] ?? generateLocationId(item['@sourceId'], relativePath),
        '@id': item['@id'],
        '@sourceId': item['@sourceId'],
        '@path': relativePath,
        '@name': item['@name'],
        '@type': item['@type'],
        '@size': item['@size'] ?? null,
        '@mtime': item['@mtime'] ?? null,
        '@birthtime': item['@birthtime'] ?? null,
        '@inode': item['@inode'] ?? null,
        '@deviceId': item['@deviceId'] ?? null,
        '@locationFingerprint': item['@locationFingerprint'] ?? null,
        '@isPresent': item['@isPresent'] ?? 1,
        '@isIgnored': item['@isIgnored'] ?? null,
        '@isLocationHidden': item['@isLocationHidden'] ?? item['@isHidden'] ?? null,
        '@isShadowed': item['@isShadowed'] ?? 0,
        '@shadowedByLocationId': item['@shadowedByLocationId'] ?? null,
        '@firstSeenAt': item['@firstSeenAt'] ?? null
    })
}

// --- Shared SQL fragments ---
// CRITICAL: We CANNOT use `e.*` because `e.id` would shadow `i.id` in bun:sqlite's
// row-to-object conversion (last column with same name wins). Instead, we explicitly
// list all media_entities columns except `id`, which is only selected as `_entity_id`.
export const ENTITY_COLUMNS_SQL = `
    e.id AS _entity_id,
    e.tmdb_id, e.media_type, e.title, e.original_title, e.overview,
    e.release_date, e.year, e.tmdb_runtime,
    e.season_number, e.episode_number, e.parent_entity_id,
    e.poster_path, e.backdrop_path, e.logo_path,
    e.locked_fields_json, e.last_refreshed_at, e.version,
    (SELECT json_group_array(g.name) FROM entity_genres eg JOIN genres g ON eg.genre_id = g.id WHERE eg.entity_id = e.id) AS genres,
    (SELECT json_group_object(t.key, t.value) FROM item_tags t WHERE t.item_id = i.id) AS tags,
    (SELECT json_group_object(vt.key, vt.value) FROM item_virtual_tags vt WHERE vt.item_id = i.id) AS virtualTags,
    (SELECT json_group_array(json_object('id', p.id, 'name', p.name, 'profile_path', p.profile_path, 'credit_type', c.credit_type, 'character', c.character, 'job', c.job, 'order', c.display_order)) FROM credits c JOIN people p ON c.person_id = p.id WHERE c.entity_id = e.id) AS tmdbCredits`

// appliedGrouping lives in its own column; inject it back into the JSON blob for the mapper.
// Aliased as 'viewSettings' to match the REPOSITORY_SCHEMA field name so mapRowToLibraryItem
// finds it on the first row[alias] check in getRowValue.
const VIEW_SETTINGS_SQL = `
    CASE WHEN f.applied_grouping IS NOT NULL
        THEN json_set(COALESCE(f.view_settings_json, '{}'), '$.appliedGrouping', f.applied_grouping)
        ELSE f.view_settings_json END AS viewSettings`

const FULL_JOIN_SQL = `
    FROM ${ITEM_READ_MODEL} i
    LEFT JOIN media_entities e ON i.entity_id = e.id
    LEFT JOIN folder_settings f ON i.id = f.item_id
`

const FULL_SELECT_SQL = `
    SELECT i.*, ${ENTITY_COLUMNS_SQL},
           ${VIEW_SETTINGS_SQL},
           f.retrieve_children_metadata, f.children_type_hint, f.process_tv_children
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
           ${VIEW_SETTINGS_SQL},
           f.retrieve_children_metadata, f.children_type_hint, f.process_tv_children
    FROM ${ITEM_READ_MODEL} i
    JOIN ${ITEM_READ_MODEL} p ON i.parent_id = p.id
    LEFT JOIN media_entities e ON p.entity_id = e.id
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
      SELECT id FROM ${ITEM_READ_MODEL} WHERE parent_id = ?
      UNION ALL
      SELECT i.id FROM ${ITEM_READ_MODEL} i
      JOIN tree t ON i.parent_id = t.id
    )
    SELECT i.*, ${ENTITY_COLUMNS_SQL},
           ${VIEW_SETTINGS_SQL},
           f.retrieve_children_metadata, f.children_type_hint, f.process_tv_children
    FROM ${ITEM_READ_MODEL} i
    JOIN tree t ON i.id = t.id
    LEFT JOIN media_entities e ON i.entity_id = e.id
    LEFT JOIN folder_settings f ON i.id = f.item_id
  `
        )
        .all(nodeId) as any[]
}

/**
 * Fetches only the fields needed to compute next-up and auto-undismissal for a show's episodes.
 * Much lighter than fetchAllDescendantsRaw: 2 JOINs instead of 4, only 4 columns selected,
 * and filtered to episode files in SQL.
 */
export function fetchEpisodeProgressForShow(showId: string, userId: string): { id: string; seasonNumber: number | null; episodeNumber: number | null; watched: boolean | null }[] {
    const db = getDb()
    return db.prepare(`
        WITH RECURSIVE tree(id) AS (
          SELECT id FROM ${ITEM_READ_MODEL} WHERE parent_id = ?
          UNION ALL
          SELECT i.id FROM ${ITEM_READ_MODEL} i JOIN tree t ON i.parent_id = t.id
        )
        SELECT i.id, e.season_number AS seasonNumber, e.episode_number AS episodeNumber, u.watched
        FROM ${ITEM_READ_MODEL} i
        JOIN tree t ON i.id = t.id
        LEFT JOIN media_entities e ON i.entity_id = e.id
        LEFT JOIN user_state u ON i.id = u.item_id AND u.user_id = ?
        WHERE i.type = 'file' AND e.media_type = 'episode'
    `).all(showId, userId) as any[]
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
      SELECT id, parent_id, 0 FROM ${ITEM_READ_MODEL} WHERE id = ?
      UNION ALL
      SELECT i.id, i.parent_id, a.level + 1
      FROM ${ITEM_READ_MODEL} i
      JOIN ancestors a ON i.id = a.parent_id
    )
    SELECT i.*, ${ENTITY_COLUMNS_SQL},
           ${VIEW_SETTINGS_SQL},
           f.retrieve_children_metadata, f.children_type_hint, f.process_tv_children
    FROM ${ITEM_READ_MODEL} i
    JOIN ancestors a ON i.id = a.id
    LEFT JOIN media_entities e ON i.entity_id = e.id
    LEFT JOIN folder_settings f ON i.id = f.item_id
    WHERE i.id != ?
    ORDER BY a.level ASC
  `
        )
        .all(itemId, itemId) as any[]
}

/**
 * Fetches ancestor IDs for multiple items in one recursive CTE.
 * Returns a map of item_id → ancestor_id[].
 * Much cheaper than calling fetchAncestorsRaw per item when broadcasting bulk updates.
 */
export function fetchAncestorIdsForItems(itemIds: string[]): Record<string, string[]> {
    if (itemIds.length === 0) return {}
    const db = getDb()
    const placeholders = itemIds.map(() => '?').join(', ')
    const rows = db.prepare(`
        WITH RECURSIVE anc(source_id, id, parent_id) AS (
          SELECT id, id, parent_id FROM ${ITEM_READ_MODEL} WHERE id IN (${placeholders})
          UNION ALL
          SELECT a.source_id, i.id, i.parent_id
          FROM ${ITEM_READ_MODEL} i JOIN anc a ON i.id = a.parent_id
          WHERE a.parent_id IS NOT NULL
        )
        SELECT source_id, id AS ancestor_id FROM anc WHERE id != source_id
    `).all(...itemIds) as { source_id: string; ancestor_id: string }[]

    const result: Record<string, string[]> = {}
    for (const { source_id, ancestor_id } of rows) {
        if (!result[source_id]) result[source_id] = []
        result[source_id].push(ancestor_id)
    }
    return result
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
    return !!db.prepare('SELECT 1 FROM media_items WHERE id = ?').get(id)
}

/**
 * Fast path lookup.
 */
export function getItemPath(id: string): string | null {
    return resolveSelectedLocationForItem(id, { requirePresent: false })?.relativePath ?? null
}

/**
 * Fast check for user-hidden status.
 */
export function isItemHidden(id: string): boolean {
    const db = getDb()
    const row = db.prepare(`SELECT is_hidden FROM ${ITEM_READ_MODEL} WHERE id = ?`).get(id) as
        | { is_hidden: number }
        | undefined
    return !!row?.is_hidden
}

/**
 * Returns all item IDs for a given source, optionally scoped to a path prefix.
 */
export function getAllIdsInScope(sourceId: string, pathPrefix: string): string[] {
    const db = getDb()
    const normalizedPrefix = normalizeRelativePath(pathPrefix)
    const isRoot = normalizedPrefix === '' || normalizedPrefix === '.'
    const query = isRoot
        ? 'SELECT DISTINCT item_id AS id FROM media_locations WHERE source_id = ?'
        : 'SELECT DISTINCT item_id AS id FROM media_locations WHERE source_id = ? AND (relative_path LIKE ? OR relative_path = ?)'
    const params = isRoot ? [sourceId] : [sourceId, `${normalizedPrefix}/%`, normalizedPrefix]

    const rows = db.prepare(query).all(...params) as { id: string }[]
    return rows.map((r) => r.id)
}

/**
 * Returns all relative paths for items in a given source (folders only).
 */
export function getAllFolderPathsInSource(sourceId: string): Set<string> {
    const db = getDb()
    const rows = db.prepare(
        `SELECT relative_path AS path
         FROM media_locations
         WHERE source_id = ?
           AND type = 'folder'
           AND is_present = 1
           AND is_shadowed = 0`
    ).all(sourceId) as { path: string }[]
    return new Set(rows.map((r) => r.path))
}

/**
 * Returns folder paths that have at least one direct child in the same source.
 * Used for source shadowing so empty higher-priority folders do not mask
 * populated lower-priority folders at the same relative path.
 */
export function getNonEmptyFolderPathsInSource(sourceId: string): Set<string> {
    const db = getDb()
    const rows = db.prepare(
        `SELECT folder.relative_path AS path
         FROM media_locations folder
         WHERE folder.source_id = ?
           AND folder.type = 'folder'
           AND folder.is_present = 1
           AND folder.is_shadowed = 0
           AND EXISTS (
             SELECT 1
             FROM media_locations child
             JOIN media_items child_item ON child_item.id = child.item_id
             WHERE child.source_id = folder.source_id
               AND child_item.parent_item_id = folder.item_id
               AND child.is_present = 1
           )`
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
      SELECT id FROM ${ITEM_READ_MODEL} WHERE parent_id = ?
      UNION ALL
      SELECT i.id FROM ${ITEM_READ_MODEL} i
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
): { id: string; locationId: string; path: string; hasLocks: boolean; inode: number; deviceId: number }[] {
    const db = getDb()
    const normalizedPrefix = normalizeRelativePath(pathPrefix)
    const isRoot = normalizedPrefix === '' || normalizedPrefix === '.'

    const query = `
    SELECT
      mi.id,
      ml.id AS location_id,
      ml.relative_path AS path,
      ml.inode,
      ml.device_id,
      e.locked_fields_json
    FROM media_locations ml
    JOIN media_items mi ON mi.id = ml.item_id
    LEFT JOIN media_entities e ON mi.entity_id = e.id
    WHERE ml.source_id = ?
      AND ml.is_present = 1
    ${isRoot ? '' : 'AND (ml.relative_path LIKE ? OR ml.relative_path = ?)'}
  `
    const params = isRoot ? [sourceId] : [sourceId, `${normalizedPrefix}/%`, normalizedPrefix]

    const rows = db.prepare(query).all(...params) as {
        id: string
        location_id: string
        path: string
        inode: number
        device_id: number
        locked_fields_json: string | null
    }[]

    return rows.map((row) => ({
        id: row.id,
        locationId: row.location_id,
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
    db.prepare('UPDATE media_items SET logical_missing = 1 WHERE id = ?').run(id)
}

/**
 * Marks one physical location as missing. The logical item is only marked
 * missing when no other present locations remain.
 */
export function markLocationAsMissing(locationId: string): void {
    const db = getDb()
    runTransaction(() => {
        const row = db.prepare('SELECT item_id FROM media_locations WHERE id = ?').get(locationId) as
            | { item_id: string }
            | undefined
        if (!row) return

        db.prepare(`
            UPDATE media_locations
            SET is_present = 0,
                missing_since = COALESCE(missing_since, cast(strftime('%s','now') as int) * 1000)
            WHERE id = ?
        `).run(locationId)

        const present = db.prepare(`
            SELECT 1 FROM media_locations
            WHERE item_id = ? AND is_present = 1
            LIMIT 1
        `).get(row.item_id)

        if (!present) {
            markAsMissing(row.item_id)
        }
    })
}

/**
 * Deletes an item.
 */
export function deleteItem(itemId: string): void {
    const db = getDb()
    db.prepare('DELETE FROM media_items WHERE id = ?').run(itemId)
}

export function deleteLocation(locationId: string): void {
    const db = getDb()
    db.prepare('DELETE FROM media_locations WHERE id = ?').run(locationId)
}

export function deleteItemIfNoPresentLocations(itemId: string): void {
    const db = getDb()
    const present = db.prepare(`
        SELECT 1 FROM media_locations
        WHERE item_id = ? AND is_present = 1
        LIMIT 1
    `).get(itemId)
    if (!present) deleteItem(itemId)
}

export function getItemIdBySourcePath(sourceId: string, relativePath: string): string | null {
    const db = getDb()
    const normalizedPath = normalizeRelativePath(relativePath)
    const row = db.prepare(`
        SELECT item_id
        FROM media_locations
        WHERE source_id = ? AND relative_path = ?
        LIMIT 1
    `).get(sourceId, normalizedPath) as { item_id: string } | undefined
    return row?.item_id ?? null
}

export function findReusableItemIdForDiscoveredLocation(params: {
    sourceId: string
    relativePath: string
    inode: number
    deviceId: number
}): string | null {
    const db = getDb()
    const inodeRows = db.prepare(`
        SELECT item_id
        FROM media_locations
        WHERE source_id != ?
          AND inode = ?
          AND device_id = ?
          AND inode IS NOT NULL
          AND device_id IS NOT NULL
        ORDER BY is_present DESC, last_seen_at DESC
        LIMIT 3
    `).all(params.sourceId, params.inode, params.deviceId) as { item_id: string }[]
    const inodeItemIds = new Set(inodeRows.map((row) => row.item_id))
    if (inodeItemIds.size === 1) return inodeRows[0].item_id
    if (inodeItemIds.size > 1) return null

    const normalizedPath = normalizeRelativePath(params.relativePath)
    const missingRelativePathRows = db.prepare(`
        SELECT item_id
        FROM media_locations
        WHERE source_id != ?
          AND relative_path = ?
          AND is_present = 0
        ORDER BY last_seen_at DESC
        LIMIT 3
    `).all(params.sourceId, normalizedPath) as { item_id: string }[]
    const missingRelativePathItemIds = new Set(missingRelativePathRows.map((row) => row.item_id))
    return missingRelativePathItemIds.size === 1 ? missingRelativePathRows[0].item_id : null
}

export function findPresentLocationByRelativePath(
    relativePath: string,
    excludeSourceId: string
): { itemId: string; locationId: string } | null {
    const db = getDb()
    const normalizedPath = normalizeRelativePath(relativePath)
    const rows = db.prepare(`
        SELECT item_id, id
        FROM media_locations
        WHERE source_id != ?
          AND relative_path = ?
          AND is_present = 1
          AND is_shadowed = 0
        ORDER BY last_seen_at DESC
        LIMIT 3
    `).all(excludeSourceId, normalizedPath) as { item_id: string; id: string }[]
    const itemIds = new Set(rows.map((row) => row.item_id))
    if (itemIds.size !== 1) return null
    const row = rows[0]
    return row ? { itemId: row.item_id, locationId: row.id } : null
}

/**
 * Upserts a batch of library items.
 */
export function upsertLibraryItems(items: any[]): void {
    const db = getDb()
    runTransaction(() => {
        for (const item of items) {
            if (item['@isShadowed'] !== 1) {
                upsertMediaItemFromLibraryRow(db, item)
            }
            upsertMediaLocationFromLibraryRow(db, item)
        }
    })
}

/**
 * Initializes/Updates a source root item (child of the library virtual root).
 */
export function upsertRootItem(id: string, name: string, sourceId: string): void {
    const db = getDb()
    runTransaction(() => {
        upsertMediaItemFromLibraryRow(db, {
            '@id': id,
            '@parentId': LIBRARY_ROOT_ID,
            '@name': name,
            '@type': 'folder',
            '@sourceId': sourceId,
            '@path': '.',
            '@isHidden': 0,
            '@isIgnored': 0,
            '@logicalMissing': 0
        })
        upsertMediaLocationFromLibraryRow(db, {
            '@id': id,
            '@parentId': LIBRARY_ROOT_ID,
            '@name': name,
            '@type': 'folder',
            '@sourceId': sourceId,
            '@path': '.',
            '@isHidden': 0,
            '@isIgnored': 0,
            '@logicalMissing': 0
        })
    })
}

/**
 * Migrates a record from an old ID/path to a new one.
 */
export function migrateRecord(oldId: string, item: any): void {
    const db = getDb()
    const locationId = `location:${oldId}`

    runTransaction(() => {
        db.prepare(`
            UPDATE media_items
            SET parent_item_id = ?,
                physical_kind = ?,
                name = ?,
                logical_missing = 0,
                updated_at = cast(strftime('%s','now') as int) * 1000
            WHERE id = ?
        `).run(item['@parentId'], item['@type'], item['@name'], oldId)

        db.prepare(`
            DELETE FROM media_locations
            WHERE source_id = ?
              AND relative_path = ?
              AND item_id != ?
        `).run(item['@sourceId'], item['@path'], oldId)

        db.prepare(`
            UPDATE media_locations
            SET id = ?,
                source_id = ?,
                relative_path = ?,
                name = ?,
                type = ?,
                size = ?,
                mtime = ?,
                birthtime = ?,
                inode = ?,
                device_id = ?,
                is_present = 1,
                is_ignored = COALESCE(?, is_ignored),
                is_hidden = COALESCE(?, is_hidden),
                last_seen_at = cast(strftime('%s','now') as int) * 1000,
                missing_since = NULL
            WHERE item_id = ?
        `).run(
            locationId,
            item['@sourceId'],
            item['@path'],
            item['@name'],
            item['@type'],
            item['@size'],
            item['@mtime'],
            item['@birthtime'],
            item['@inode'],
            item['@deviceId'],
            item['@isIgnored'],
            item['@isHidden'],
            oldId
        )

        db.prepare(`
            INSERT OR IGNORE INTO media_locations (
                id, item_id, source_id, relative_path, name, type,
                size, mtime, birthtime, inode, device_id, location_fingerprint,
                is_present, is_ignored, is_hidden, is_shadowed, shadowed_by_location_id,
                first_seen_at, last_seen_at, missing_since
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, COALESCE(?, 0), COALESCE(?, 0), 0, NULL,
                cast(strftime('%s','now') as int) * 1000,
                cast(strftime('%s','now') as int) * 1000,
                NULL)
        `).run(
            locationId,
            oldId,
            item['@sourceId'],
            item['@path'],
            item['@name'],
            item['@type'],
            item['@size'],
            item['@mtime'],
            item['@birthtime'],
            item['@inode'],
            item['@deviceId'],
            item['@isIgnored'],
            item['@isHidden']
        )
    })
}

/**
 * Updates item path and ID (rename).
 */
export function updateItemPathAndId(oldId: string, newRelativePath: string, sourceId: string): void {
    const db = getDb()
    const newName = path.basename(newRelativePath)

    runTransaction(() => {
        db.prepare(`
            UPDATE media_items
            SET name = ?,
                updated_at = cast(strftime('%s','now') as int) * 1000
            WHERE id = ?
        `).run(newName, oldId)

        db.prepare(`
            UPDATE media_locations
            SET relative_path = ?,
                name = ?,
                last_seen_at = cast(strftime('%s','now') as int) * 1000
            WHERE item_id = ?
              AND source_id = ?
              AND is_present = 1
        `).run(newRelativePath, newName, oldId, sourceId)
    })
}

/**
 * Fast lookup of source_id for an item. Used to resolve absolute paths at runtime.
 */
export function getItemSourceId(itemId: string): string | null {
    return resolveSelectedLocationForItem(itemId, { requirePresent: false })?.sourceId ?? null
}

/**
 * Resolves the selected present location for filesystem operations.
 */
export function getPresentItemLocation(
    itemId: string,
    type?: 'file' | 'folder',
    userId?: string | null
): { sourceId: string; relativePath: string; type: 'file' | 'folder' } | null {
    const location = resolveSelectedLocationForItem(itemId, { requirePresent: true, type, userId })
    if (!location) return null
    return {
        sourceId: location.sourceId,
        relativePath: location.relativePath,
        type: location.type
    }
}

export function getPresentFolderLocation(
    itemId: string,
    userId?: string | null
): { sourceId: string; relativePath: string } | null {
    const location = getPresentItemLocation(itemId, 'folder', userId)
    if (!location) return null
    return {
        sourceId: location.sourceId,
        relativePath: location.relativePath
    }
}

/**
 * Ensures the singleton library virtual root exists.
 * This is the DB root that parents all source root items.
 * Safe to call on every startup (INSERT OR IGNORE).
 */
export function ensureLibraryVirtualRoot(): void {
    const db = getDb()
    runTransaction(() => {
        upsertMediaItemFromLibraryRow(db, {
            '@id': LIBRARY_ROOT_ID,
            '@parentId': null,
            '@name': 'Library',
            '@type': 'folder',
            '@physicalKind': 'virtual',
            '@isVirtual': 1,
            '@virtualType': 'home',
            '@filterJson': null,
            '@ownerId': null,
            '@isHidden': 0,
            '@logicalMissing': 0
        })
    })
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
    const params = {
        '@id': itemId,
        '@isHidden': hidden === undefined ? null : hidden ? 1 : 0,
        '@isMissing': missing === undefined ? null : missing ? 1 : 0
    }
    runTransaction(() => {
        db.prepare(`
            UPDATE media_items
            SET is_hidden = COALESCE(@isHidden, is_hidden),
                logical_missing = COALESCE(@isMissing, logical_missing),
                updated_at = ${nowMsSql()}
            WHERE id = @id
        `).run(params)
    })
}

/**
 * Links an item to a media entity.
 */
export function setEntityId(itemId: string, entityId: string | null): void {
    const db = getDb()
    runTransaction(() => {
        db.prepare(`
            UPDATE media_items
            SET entity_id = ?,
                media_kind = (SELECT media_type FROM media_entities WHERE id = ?),
                updated_at = ${nowMsSql()}
            WHERE id = ?
        `).run(entityId, entityId, itemId)
    })
}

/**
 * Updates the filter_json column for a virtual folder item.
 */
export function updateFilterJson(itemId: string, filterJson: string | null): void {
    const db = getDb()
    runTransaction(() => {
        db.prepare(`
            UPDATE media_items
            SET filter_json = ?,
                updated_at = ${nowMsSql()}
            WHERE id = ?
        `).run(filterJson, itemId)
    })
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
    runTransaction(() => {
        upsertMediaItemFromLibraryRow(db, {
            '@id': params.id,
            '@parentId': params.parentId,
            '@name': params.name,
            '@type': 'folder',
            '@physicalKind': 'virtual',
            '@isVirtual': 1,
            '@virtualType': params.virtualType,
            '@filterJson': params.filterJson ?? null,
            '@ownerId': null,
            '@isHidden': 0,
            '@logicalMissing': 0
        })
    })
}

/**
 * Returns distinct season numbers from real episode file children of the given parent.
 * Used by syncVirtualSeasonFolders to know which virtual season folders are needed.
 */
export function getDistinctSeasonNumbers(parentId: string): number[] {
    const db = getDb()
    const rows = db.prepare(`
        SELECT DISTINCT e.season_number
        FROM ${ITEM_READ_MODEL} i
        LEFT JOIN media_entities e ON i.entity_id = e.id
        WHERE i.parent_id = ?
          AND i.is_virtual = 0
          AND i.type = 'file'
          AND e.media_type = 'episode'
          AND e.season_number IS NOT NULL
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
        `SELECT id FROM media_items WHERE parent_item_id = ? AND virtual_type = 'season'`
    ).all(parentId) as { id: string }[]
    return rows.map((r) => r.id)
}

/**
 * Returns IDs of all grouping virtual folders under a given parent.
 */
export function getVirtualGroupingFolderIds(parentId: string): string[] {
    const db = getDb()
    const rows = db.prepare(
        `SELECT id FROM media_items WHERE parent_item_id = ? AND virtual_type = 'grouping'`
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
        SELECT item_id, applied_grouping AS group_by_key
        FROM folder_settings
        WHERE applied_grouping IS NOT NULL
          AND applied_grouping != 'seasonNumber'
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
    runTransaction(() => {
        upsertMediaItemFromLibraryRow(db, {
            '@id': HOME_FOLDER_ID,
            '@parentId': rootId,
            '@name': '__home__',
            '@type': 'folder',
            '@physicalKind': 'virtual',
            '@isVirtual': 1,
            '@virtualType': 'home',
            '@filterJson': filterJson,
            '@ownerId': null,
            '@isHidden': 0,
            '@logicalMissing': 0
        })
    })
}


/**
 * Ensures the three default home subfolders exist.
 * Uses INSERT OR IGNORE with stable IDs — safe to call on every startup.
 * The folders are created as virtualType='user' so users can delete them.
 */
export function ensureHomeChildren(): void {
    const db = getDb()
    const homeChildren = [
        {
            id: HOME_CATEGORIES_ID,
            parentId: HOME_FOLDER_ID,
            name: 'Categories',
            filterJson: JSON.stringify({ scope: { parentId: HOME_FOLDER_ID } })
        },
        {
            id: HOME_RECENTLY_ADDED_ID,
            parentId: HOME_FOLDER_ID,
            name: 'Recently Added',
            filterJson: JSON.stringify({
                scope: { parentId: HOME_FOLDER_ID },
                conditions: [{ field: 'addedDaysAgo', op: 'lte', value: 14 }]
            })
        },
        {
            id: HOME_GENRES_ID,
            parentId: HOME_FOLDER_ID,
            name: 'Genres',
            filterJson: JSON.stringify({ scope: { parentId: HOME_FOLDER_ID } })
        },
        {
            id: HOME_ALL_MEDIA_ID,
            parentId: HOME_CATEGORIES_ID,
            name: 'All Media',
            filterJson: JSON.stringify({ scope: { parentId: HOME_FOLDER_ID } })
        }
    ]

    runTransaction(() => {
        for (const child of homeChildren) {
            upsertMediaItemFromLibraryRow(db, {
                '@id': child.id,
                '@parentId': child.parentId,
                '@name': child.name,
                '@type': 'folder',
                '@physicalKind': 'virtual',
                '@isVirtual': 1,
                '@virtualType': 'user',
                '@filterJson': child.filterJson,
                '@ownerId': null,
                '@isHidden': 0,
                '@logicalMissing': 0
            })
        }
    })
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
    runTransaction(() => {
        db.prepare('DELETE FROM media_items WHERE parent_item_id = ? AND virtual_type = ?').run(
            parentId,
            virtualType
        )
    })
}
