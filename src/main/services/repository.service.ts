import path from 'path'
import crypto from 'crypto'
import { getDb, initializeDatabase } from '../database/client'
import type { LibraryItem, MediaFolder } from '@shared/types'
import { VIEW_SETTINGS_KEYS, CORE_FIELDS } from '@shared/types'
export { CORE_FIELDS }
import * as groupingService from './grouping.service'
import { resolveViewSettings } from '@shared/settings-helpers'
import { readSettings } from './settings.service'

export interface CheckHelper {
  (row: any, key: string): any
}

interface RepositoryFieldDef {
  sql: string
  table?: 'i' | 'm' | 'u' | 'f' // Dependency table
  isJson?: boolean
  parser?: (val: any) => any
  getValue?: (item: LibraryItem) => string[] // Symmetrical logic for in-memory grouping
}

// Centralized Schema Definition
const REPOSITORY_SCHEMA: Record<string, RepositoryFieldDef> = {
  // Items Table
  id: { sql: 'i.id', table: 'i' },
  parentId: { sql: 'i.parent_id', table: 'i' },
  name: { sql: 'i.name', table: 'i' },
  path: { sql: 'i.path', table: 'i' },
  type: { sql: 'i.type', table: 'i' },
  size: { sql: 'i.size', table: 'i' },
  birthtime: { sql: 'i.birthtime', table: 'i' },
  mtime: { sql: 'i.mtime', table: 'i' },
  isMissing: { sql: 'i.is_missing', table: 'i', parser: Boolean },
  isHidden: { sql: 'i.is_hidden', table: 'i', parser: Boolean },

  // Metadata Table
  tmdbId: { sql: 'm.tmdb_id', table: 'm' },
  mediaType: {
    sql: 'm.media_type',
    table: 'm',
    getValue: (item) => (item.mediaType ? [item.mediaType] : [])
  },
  title: { sql: 'm.title', table: 'm' },
  originalTitle: { sql: 'm.original_title', table: 'm' },
  overview: { sql: 'm.overview', table: 'm' },
  releaseDate: { sql: 'm.release_date', table: 'm' },
  runtime: { sql: 'm.runtime', table: 'm' },
  year: {
    sql: 'm.year',
    table: 'm',
    getValue: (item) => (item.year ? [item.year.toString()] : [])
  },
  seasonNumber: { sql: 'm.season_number', table: 'm' },
  episodeNumber: { sql: 'm.episode_number', table: 'm' },
  // Images (JSON extraction helpers)
  posterPath: { sql: "json_extract(m.images_json, '$.poster')", table: 'm' },
  backdropPath: { sql: "json_extract(m.images_json, '$.backdrop')", table: 'm' },
  logoPath: { sql: "json_extract(m.images_json, '$.logo')", table: 'm' },
  // Metadata JSONs
  genres: {
    sql: 'm.genres_json',
    table: 'm',
    isJson: true,
    getValue: (item) => item.genres ?? []
  },
  tags: { sql: 'm.tags_json', table: 'm', isJson: true },
  virtualTags: { sql: 'm.virtual_tags_json', table: 'm', isJson: true },
  tmdbCredits: { sql: 'm.people_json', table: 'm', isJson: true },
  tmdbSeasons: { sql: 'm.seasons_json', table: 'm', isJson: true },
  tmdbEpisodes: { sql: 'm.episodes_json', table: 'm', isJson: true },
  lockedFields: { sql: 'm.locked_fields_json', table: 'm', isJson: true },
  lastRefreshedAt: { sql: 'm.last_refreshed_at', table: 'm' },
  _v: { sql: 'm.version', table: 'm' },

  // User State Table
  watched: { sql: 'u.watched', table: 'u', parser: Boolean },
  lastWatched: { sql: 'u.last_watched_at', table: 'u' },
  continueWatchingDismissed: { sql: 'u.continue_watching_dismissed', table: 'u', parser: Boolean },
  nextUpDismissed: { sql: 'u.next_up_dismissed', table: 'u', parser: Boolean },
  nextUpEpisodeId: { sql: 'u.next_up_episode_id', table: 'u' },

  // Folder Settings (Scraper)
  retrieve_children_metadata: {
    sql: "json_extract(f.scraper_settings_json, '$.retrieve_children_metadata')",
    table: 'f',
    parser: Boolean
  },
  children_type_hint: {
    sql: "json_extract(f.scraper_settings_json, '$.children_type_hint')",
    table: 'f'
  },
  process_tv_children: {
    sql: "json_extract(f.scraper_settings_json, '$.process_tv_children')",
    table: 'f',
    parser: Boolean
  },

  // Folder Settings (View)
  layout: { sql: "json_extract(f.view_settings_json, '$.layout')", table: 'f' },
  clickAction: { sql: "json_extract(f.view_settings_json, '$.clickAction')", table: 'f' },
  groupBy: { sql: "json_extract(f.view_settings_json, '$.groupBy')", table: 'f' },
  gridPosterSize: { sql: "json_extract(f.view_settings_json, '$.gridPosterSize')", table: 'f' },
  listDescriptionRows: {
    sql: "json_extract(f.view_settings_json, '$.listDescriptionRows')",
    table: 'f'
  },
  showHorizontalScrollbar: {
    sql: "json_extract(f.view_settings_json, '$.showHorizontalScrollbar')",
    table: 'f'
  },
  childViewSettings: {
    sql: "json_extract(f.view_settings_json, '$.childViewSettings')",
    table: 'f',
    isJson: true
  },
  virtualFolderSettings: {
    sql: "json_extract(f.view_settings_json, '$.virtualFolderSettings')",
    table: 'f',
    isJson: true
  }
}

export function isValidField(field: string): boolean {
  return REPOSITORY_SCHEMA[field] !== undefined
}

export interface FindOptions {
  where?: Record<string, any>
  fields?: string[]
  orderBy?: { field: string; direction: 'ASC' | 'DESC' }
  limit?: number
  offset?: number
  includeHidden?: boolean
}

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Repository Service] ${message}`)
}

// --- Initialization ---

export async function loadDb(): Promise<void> {
  log('Initializing SQLite database...')
  initializeDatabase()
}

export async function writeDb(): Promise<void> {
  // No-op: Data is persisted immediately in SQLite.
}

export async function createNewDb(rootNode: MediaFolder | null): Promise<void> {
  const db = getDb()
  db.transaction(() => {
    // Delete all items. Foreign keys will cascade delete metadata, user_state, etc.
    db.prepare('DELETE FROM items').run()
  })()

  if (rootNode) {
    // In this architecture, the filesystem service populates the DB.
    // This function acts as a reset signal.
  }
}

/**
 * Ensures a root node exists in the database.
 * If no root node exists, it creates one using the provided media source path.
 */
export function ensureRootExists(mediaSourcePath: string): void {
  const root = getRoot()
  if (root) return

  log(`No root node found. Creating root for: ${mediaSourcePath}`)
  const db = getDb()
  const rootId = generateId('.')
  const rootName =
    mediaSourcePath === '.' || mediaSourcePath === '/'
      ? 'Library'
      : mediaSourcePath.split(/[/\\]/).filter(Boolean).pop() || 'Library'

  db.prepare(
    `
    INSERT INTO items (id, parent_id, path, name, type, is_missing)
    VALUES (?, NULL, '.', ?, 'folder', 0)
    `
  ).run(rootId, rootName)
}

// --- Bulk Updates / Transactions ---

let isBulkUpdating = false
export const getBulkUpdateStatus = (): boolean => isBulkUpdating
export const setBulkUpdateStatus = (status: boolean): void => {
  isBulkUpdating = status
}

export function runTransaction<T>(fn: () => T): T {
  const db = getDb()
  return db.transaction(fn)()
}

// --- Metadata Helpers ---

/**
 * Checks if a specific field is locked for a library item.
 */
export function isFieldLocked(item: LibraryItem, field: string): boolean {
  return item.lockedFields?.includes(field) ?? false
}

/**
 * Safely parse JSON strings with a fallback value.
 * Ensures the result is never null if a non-null fallback is provided.
 */
export function parseJsonSafe<T>(jsonString: string | null, fallback: T): T {
  if (!jsonString) return fallback
  try {
    const parsed = JSON.parse(jsonString)
    return parsed === null ? fallback : parsed
  } catch (e) {
    return fallback
  }
}

// Helper to get a value from a row, prioritizing the alias but falling back to raw column name if needed.
// This supports both "SELECT * ..." (raw names) and "SELECT col as alias ..." (aliases).
function getRowValue(row: any, alias: string, def: RepositoryFieldDef) {
  if (row[alias] !== undefined) return row[alias]

  // Fallback for raw column names (e.g. 'tmdb_id' instead of 'tmdbId')
  // We strip table prefixes: 'm.tmdb_id' -> 'tmdb_id'
  const rawCol = def.sql.includes('.') ? def.sql.split('.')[1] : def.sql
  // Handle json_extract cases: "json_extract(..., '$.key')" -> we can't easily fallback unless it was selected as raw.
  // But SELECT * doesn't return extracted values, it returns the blob.

  if (row[rawCol] !== undefined) return row[rawCol]

  return undefined
}

function mapRowToLibraryItem(row: any): LibraryItem {
  const item: any = {}

  // 1. Core Identity & Flat Fields
  // We iterate the schema to populate the item.
  for (const [alias, def] of Object.entries(REPOSITORY_SCHEMA)) {
    let val = getRowValue(row, alias, def)

    // Special handling for JSON extraction fallback
    // If val is undefined (not selected explicitly), check if we have the parent JSON blob
    const isImage = ['posterPath', 'backdropPath', 'logoPath'].includes(alias)
    if (val === undefined && isImage && row.images_json) {
      const images = parseJsonSafe(row.images_json, {}) as any
      const key = alias.replace('Path', '') // posterPath -> poster
      val = images[key]
    }

    // Fallback for View/Scraper settings if not selected individually but blob exists
    // (This covers SELECT * cases where we get view_settings_json but not 'layout' alias)
    if (val === undefined && def.table === 'f') {
      if (def.sql.includes('view_settings_json') && row.view_settings_json) {
        const vs = parseJsonSafe<any>(row.view_settings_json, {})
        const key = alias // e.g. 'layout'
        val = vs[key]
      } else if (def.sql.includes('scraper_settings_json') && row.scraper_settings_json) {
        const ss = parseJsonSafe<any>(row.scraper_settings_json, {})
        const key = alias
        val = ss[key]
      }
    }

    // Metadata JSON blobs (genres, tags, etc)
    // If the schema output is a parsed object, we need to handle parsing here.
    if (def.isJson) {
      // If we got a string (from DB text column), parse it.
      // If we got an object (already parsed or from previous step), leave it.
      if (typeof val === 'string') {
        const isArray = ['lockedFields', 'genres'].includes(alias)
        const isNullable = ['tmdbCredits', 'tmdbSeasons', 'tmdbEpisodes'].includes(alias)
        const fallback = isArray ? [] : isNullable ? null : {}

        val = parseJsonSafe(val, fallback)

        // Sanity Check / Auto-Heal:
        // If we expected a nullable array but got an object (e.g. from previous {} fallback bug), force it to null.
        if (
          (alias === 'tmdbSeasons' || alias === 'tmdbEpisodes') &&
          val !== null &&
          !Array.isArray(val)
        ) {
          val = null
        }
      }
      // FIX: Removed the 'else if (val === undefined)' block.
      // This ensures that if the field wasn't fetched, it stays undefined and is omitted from the JSON.
    }

    // Generic Parser (Boolean etc)
    if (val !== undefined && def.parser && val !== null) {
      val = def.parser(val)
    }

    // Assign to item
    if (val !== undefined) {
      item[alias] = val
    }
  }

  // 2. Computed / Logic-heavy fields

  // Note: if using explicit selection, we might not have item_id alias.
  // But we always select m.item_id if metadata is involved?
  // Actually, 'item_id' is not in our schema aliases. It's a join key.
  // In `find`, we might need to ensure existence check is possible.
  // Let's assume schema fields like 'tmdbId' are sufficient.
  // Re-implement the tri-state tmdbId logic (Found / Not Found / Not Scanned)
  // Original logic:
  // if !hasMetadata -> undefined
  // if hasMetadata:
  //    if tmdbId != null -> tmdbId
  //    if tmdbId == null:
  //       if version == null -> undefined
  //       else -> null
  // 
  // We need 'version' (aliased as _v) and 'tmdbId' to be resolved first.
  const ver = item._v
  const tid = item.tmdbId

  // Check if we actually HAVE metadata info from the row (raw item_id from join)
  const metaJoinId = row.item_id // raw column from SELECT * or explicit join
  // If we don't have row.item_id, maybe we can infer from presence of other m.* fields?
  // Safe bet: if we requested metadata (joined), row.item_id should be there.
  // But if we selected specific fields, we might not have selected m.item_id.

  const actuallyHasMetadata =
    metaJoinId !== undefined
      ? metaJoinId !== null
      : item.title !== undefined || item._v !== undefined

  if (!actuallyHasMetadata) {
    // If no metadata record exists, these should be undefined
    item.tmdbId = undefined
    item.mediaType = undefined
    item.lockedFields = undefined
  } else {
    if (tid === null || tid === undefined) {
      // Scanned but not found (version exists) vs Not Scanned (version null)
      // Note: using loose equality for null/undefined check on DB values
      item.tmdbId = ver != null ? null : undefined
    }
    // If tid is present, it's already set.
  }

  // 3. Folder specific logic
  // FIX: Removed explicit assignment of children = null.
  // This allows the field to be undefined (omitted) unless explicitly populated later.
  // if (item.type === 'folder') {
  //   item.children = null
  // }

  return item as LibraryItem
}

// --- Read Operations ---

export { getDb } from '../database/client'

export function getRoot(): MediaFolder | null {
  const db = getDb()
  const row = db
    .prepare(
      `
    SELECT i.*, m.*, u.watched, u.last_watched_at, u.continue_watching_dismissed, u.next_up_dismissed, f.view_settings_json, f.scraper_settings_json
    FROM items i
    LEFT JOIN metadata m ON i.id = m.item_id
    LEFT JOIN user_state u ON i.id = u.item_id
    LEFT JOIN folder_settings f ON i.id = f.item_id
    WHERE i.parent_id IS NULL
    LIMIT 1
  `
    )
    .get() as any

  if (!row) return null
  return mapRowToLibraryItem(row) as MediaFolder
}

/**
 * Builds a full tree structure for a folder and its descendants.
 */
export function getFullFolderTree(root: MediaFolder): MediaFolder {
  const allItems = getAllDescendantsAsList(root)
  const itemMap = new Map<string, LibraryItem>()
  itemMap.set(root.id, root)
  root.children = []

  for (const item of allItems) {
    itemMap.set(item.id, item)
    if (item.type === 'folder') item.children = []
  }

  for (const item of allItems) {
    const parent = item.parentId ? itemMap.get(item.parentId) : null
    if (parent && parent.type === 'folder') {
      if (!parent.children) parent.children = []
      parent.children.push(item)
    }
  }
  return root
}

export function getItemById(id: string): LibraryItem | null {
  const db = getDb()
  const row = db
    .prepare(
      `
    SELECT i.*, m.*, u.watched, u.last_watched_at, u.continue_watching_dismissed, u.next_up_dismissed, f.view_settings_json, f.scraper_settings_json
    FROM items i
    LEFT JOIN metadata m ON i.id = m.item_id
    LEFT JOIN user_state u ON i.id = u.item_id
    LEFT JOIN folder_settings f ON i.id = f.item_id
    WHERE i.id = ?
  `
    )
    .get(id)

  if (!row) return null
  return mapRowToLibraryItem(row)
}

/**
 * Fast path lookup for streaming. Only returns the path, no joins.
 * Use this when you only need the file path (e.g. streaming endpoints).
 */
export function getItemPath(id: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT path FROM items WHERE id = ?').get(id) as { path: string } | undefined
  return row?.path ?? null
}

export function findItemByPath(pathStr: string): LibraryItem | null {
  const db = getDb()
  const row = db
    .prepare(
      `
    SELECT i.*, m.*, u.watched, u.last_watched_at, u.continue_watching_dismissed, u.next_up_dismissed, f.view_settings_json, f.scraper_settings_json
    FROM items i
    LEFT JOIN metadata m ON i.id = m.item_id
    LEFT JOIN user_state u ON i.id = u.item_id
    LEFT JOIN folder_settings f ON i.id = f.item_id
    WHERE i.path = ?
  `
    )
    .get(pathStr)

  if (!row) return null
  return mapRowToLibraryItem(row)
}

export function findParent(id: string): MediaFolder | null {
  const db = getDb()
  const row = db
    .prepare(
      `
    SELECT p.*, m.*, u.watched, u.last_watched_at, u.continue_watching_dismissed, u.next_up_dismissed, f.view_settings_json, f.scraper_settings_json
    FROM items i
    JOIN items p ON i.parent_id = p.id
    LEFT JOIN metadata m ON p.id = m.item_id
    LEFT JOIN user_state u ON p.id = u.item_id
    LEFT JOIN folder_settings f ON p.id = f.item_id
    WHERE i.id = ?
  `
    )
    .get(id)

  if (!row) return null
  return mapRowToLibraryItem(row) as MediaFolder
}

/**
 * Returns the immediate children of a folder.
 * Uses the lean find() logic if fields are specified.
 */
export function getChildren(parentId: string, fields?: string[], includeHidden = true): LibraryItem[] {
  return find({
    where: { parentId },
    fields,
    includeHidden
  })
}

/**
 * Recursively gets all descendants using a Common Table Expression (CTE).
 */
export function getAllDescendantsAsList(node: MediaFolder): LibraryItem[] {
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
    SELECT i.*, m.*, u.watched, u.last_watched_at, u.continue_watching_dismissed, u.next_up_dismissed, f.view_settings_json, f.scraper_settings_json
    FROM items i
    JOIN tree t ON i.id = t.id
    LEFT JOIN metadata m ON i.id = m.item_id
    LEFT JOIN user_state u ON i.id = u.item_id
    LEFT JOIN folder_settings f ON i.id = f.item_id
  `
    )
    .all(node.id) as any[]

  return rows.map(mapRowToLibraryItem)
}

/**
 * Gets the chain of ancestors from the item up to the root.
 */
export function getAncestors(itemId: string): LibraryItem[] {
  const db = getDb()
  const rows = db
    .prepare(
      `
    WITH RECURSIVE ancestors(id, parent_id, level) AS (
      SELECT id, parent_id, 0 FROM items WHERE id = ?
      UNION ALL
      SELECT i.id, i.parent_id, a.level + 1
      FROM items i
      JOIN ancestors a ON i.id = a.parent_id
    )
    SELECT i.*, m.*, u.watched, u.last_watched_at, u.continue_watching_dismissed, u.next_up_dismissed, f.view_settings_json, f.scraper_settings_json
    FROM items i
    JOIN ancestors a ON i.id = a.id
    LEFT JOIN metadata m ON i.id = m.item_id
    LEFT JOIN user_state u ON i.id = u.item_id
    LEFT JOIN folder_settings f ON i.id = f.item_id
    WHERE i.id != ? -- Exclude the item itself
    ORDER BY a.level ASC -- Immediate parent first
  `
    )
    .all(itemId, itemId) as any[]

  return rows.map(mapRowToLibraryItem)
}

export function getAllItemsAsList(): LibraryItem[] {
  const db = getDb()
  const rows = db
    .prepare(
      `
    SELECT i.*, m.*, u.watched, u.last_watched_at, u.continue_watching_dismissed, u.next_up_dismissed, f.view_settings_json, f.scraper_settings_json
    FROM items i
    LEFT JOIN metadata m ON i.id = m.item_id
    LEFT JOIN user_state u ON i.id = u.item_id
    LEFT JOIN folder_settings f ON i.id = f.item_id
  `
    )
    .all() as any[]
  return rows.map(mapRowToLibraryItem)
}

// --- Write Operations ---

export function find(options: FindOptions = {}): LibraryItem[] {
  const db = getDb()
  const requestedFields = options.fields || []
  // Default to CORE_FIELDS if no fields specified (Lean & Lazy)
  const fieldsToSelect: string[] =
    requestedFields.length > 0 ? [...requestedFields] : [...CORE_FIELDS]

  // Determine needed tables based on schema
  const usedTables = new Set<string>()
  for (const alias of fieldsToSelect) {
    const def = REPOSITORY_SCHEMA[alias]
    if (def && def.table) usedTables.add(def.table)
  }

  // Also check WHERE clause for dependencies
  if (options.where) {
    for (const key of Object.keys(options.where)) {
      const def = REPOSITORY_SCHEMA[key]
      if (def && def.table) usedTables.add(def.table)
    }
  }

  // Build SELECT clause
  const selectParts: string[] = []

  // Always ensure 'i.id' is selected if not requested explicitly (mapper needs it)
  if (!fieldsToSelect.includes('id')) {
    fieldsToSelect.unshift('id')
  }

  // Also 'item_id' from metadata is needed for checking if metadata exists.
  if (usedTables.has('m')) {
    selectParts.push('m.item_id')
  }

  for (const alias of fieldsToSelect) {
    const def = REPOSITORY_SCHEMA[alias]
    if (def) {
      selectParts.push(`${def.sql} AS ${alias}`)
    }
  }

  const selectClause = selectParts.join(', ')

  let query = `SELECT ${selectClause} FROM items i`

  if (usedTables.has('m')) {
    query += ` LEFT JOIN metadata m ON i.id = m.item_id`
  }
  if (usedTables.has('u')) {
    query += ` LEFT JOIN user_state u ON i.id = u.item_id`
  }
  if (usedTables.has('f')) {
    query += ` LEFT JOIN folder_settings f ON i.id = f.item_id`
  }

  const params: any[] = []
  const conditions: string[] = []

  // Default includeHidden to true unless explicitly FALSE
  // Note: getChildren() sets it to false.
  const includeHidden = options.includeHidden ?? true

  if (!includeHidden) {
    conditions.push('(i.is_hidden IS NULL OR i.is_hidden = 0)')
  }

  if (options.where) {
    for (const [key, value] of Object.entries(options.where)) {
      // 1. Direct Schema Mapping
      const def = REPOSITORY_SCHEMA[key]
      if (def) {
        if (value === null) {
          conditions.push(`${def.sql} IS NULL`)
        } else if (
          value !== null &&
          typeof value === 'object' &&
          (value as any).$ne === null
        ) {
          conditions.push(`${def.sql} IS NOT NULL`)
        } else if (Array.isArray(value)) {
          if (value.length > 0) {
            conditions.push(`${def.sql} IN(${value.map(() => '?').join(',')})`)
            params.push(...value)
          } else {
            conditions.push('1 = 0') // Empty IN mismatch
          }
        } else {
          conditions.push(`${def.sql} = ?`)
          params.push(value)
        }
      }
      // 2. Virtual Tags (virtualTags.key)
      else if (key.startsWith('virtualTags.')) {
        const tagKey = key.split('.')[1]
        conditions.push(`json_extract(m.virtual_tags_json, '$.${tagKey}') = ?`)
        params.push(value)
      }
      // 3. Tags (tags.key)
      else if (key.startsWith('tags.')) {
        const tagKey = key.split('.')[1]
        conditions.push(`json_extract(m.tags_json, '$.${tagKey}') = ?`)
        params.push(value)
      }
      // 4. Genres (Exact match in Array)
      else if (key === 'genre' || key === 'genres') {
        conditions.push(`EXISTS (SELECT 1 FROM json_each(m.genres_json) WHERE value = ?)`)
        params.push(value)
      }
    }
  } // END options.where

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')} `
  }

  if (options.orderBy) {
    const def = REPOSITORY_SCHEMA[options.orderBy.field]
    const colRaw = def ? def.sql : 'i.name'
    query += ` ORDER BY ${colRaw} ${options.orderBy.direction} `
  }

  if (options.limit) {
    query += ` LIMIT ? `
    params.push(options.limit)
    if (options.offset) {
      query += ` OFFSET ? `
      params.push(options.offset)
    }
  }

  const rows = db.prepare(query).all(...params) as any[]
  return rows.map(mapRowToLibraryItem)
}

// --- Write Operations ---

export function generateId(relativePath: string): string {
  return crypto.createHash('sha256').update(relativePath).digest('hex')
}

export function _updateItem(itemId: string, updates: Partial<LibraryItem>): LibraryItem | null {
  log(`[DEBUG] updateItem called for itemId: ${itemId}`)
  const db = getDb()

  const transaction = db.transaction(() => {
    // ---------------------------------------------------------
    // Phase 0: Invariant Enforcement & Normalization
    // ---------------------------------------------------------
    const mediaType =
      updates.mediaType !== undefined
        ? updates.mediaType
        : (db.prepare('SELECT media_type FROM metadata WHERE item_id = ?').get(itemId) as any)
          ?.media_type

    if (mediaType === 'tv') {
      ; (updates as any).seasonNumber = null
        ; (updates as any).episodeNumber = null
    } else if (mediaType === 'season') {
      ; (updates as any).episodeNumber = null
    }

    // 1. Items Table
    if (updates.isHidden !== undefined || updates.isMissing !== undefined) {
      db.prepare(
        `
        UPDATE items SET
is_hidden = COALESCE(@isHidden, is_hidden),
  is_missing = COALESCE(@isMissing, is_missing)
        WHERE id = @id
  `
      ).run({
        '@id': itemId,
        '@isHidden': updates.isHidden === undefined ? null : updates.isHidden ? 1 : 0,
        '@isMissing': updates.isMissing === undefined ? null : updates.isMissing ? 1 : 0
      })
    }

    // 2. User State
    if (
      (updates as any).watched !== undefined ||
      (updates as any).lastWatched !== undefined ||
      (updates as any).continueWatchingDismissed !== undefined ||
      (updates as any).nextUpDismissed !== undefined
    ) {
      const existingState =
        (db.prepare('SELECT * FROM user_state WHERE item_id = ?').get(itemId) as any) || {}

      // DEBUG: Check for multiple user states
      const allStates = db.prepare('SELECT * FROM user_state WHERE item_id = ?').all(itemId)
      if (allStates.length > 1) {
        console.warn(
          `[Repo] WARNING: Multiple user_state rows found for item ${itemId}: `,
          allStates
        )
      }

      console.log(`[Repo] updateItem ${itemId}`)
      // console.log(`[Repo] [TRACE] updateItem ${itemId} - Existing State: `, existingState)
      // console.log(`[Repo] [TRACE] updateItem ${itemId} - Updates: `, updates)

      const val = {
        watched:
          (updates as any).watched !== undefined
            ? (updates as any).watched
              ? 1
              : 0
            : existingState.watched,
        lastWatched:
          (updates as any).lastWatched !== undefined
            ? (updates as any).lastWatched
            : existingState.last_watched_at,
        cwd:
          (updates as any).continueWatchingDismissed !== undefined
            ? (updates as any).continueWatchingDismissed
              ? 1
              : 0
            : existingState.continue_watching_dismissed,
        nud:
          (updates as any).nextUpDismissed !== undefined
            ? (updates as any).nextUpDismissed
              ? 1
              : 0
            : existingState.next_up_dismissed,
        nextUpEpisodeId: (updates as any).nextUpEpisodeId !== undefined
          ? (updates as any).nextUpEpisodeId
          : existingState.next_up_episode_id
      }

      const userStateParams = {
        '@id': itemId,
        '@watched': val.watched ?? 0,
        '@lastWatched': val.lastWatched,
        '@continueWatchingDismissed': val.cwd ?? 0,
        '@nextUpDismissed': val.nud ?? 0,
        '@nextUpEpisodeId': val.nextUpEpisodeId
      }
      db.prepare(
        `
        INSERT INTO user_state(item_id, watched, last_watched_at, continue_watching_dismissed, next_up_dismissed, next_up_episode_id)
VALUES(@id, @watched, @lastWatched, @continueWatchingDismissed, @nextUpDismissed, @nextUpEpisodeId)
        ON CONFLICT(item_id, user_id) DO UPDATE SET
watched = excluded.watched,
  last_watched_at = excluded.last_watched_at,
  continue_watching_dismissed = excluded.continue_watching_dismissed,
  next_up_dismissed = excluded.next_up_dismissed,
  next_up_episode_id = excluded.next_up_episode_id
    `
      ).run(userStateParams)
    }

    // 3. Metadata
    const metadataKeys = [
      'tmdbId',
      'mediaType',
      'title',
      'overview',
      'year',
      'seasonNumber',
      'episodeNumber',
      'genres',
      'tags',
      'virtualTags',
      'tmdbCredits',
      'posterPath',
      'backdropPath',
      'logoPath',
      'lockedFields',
      'lastRefreshedAt',
      '_v'
    ]
    const hasMetadataUpdates = metadataKeys.some((k) => k in updates)

    if (hasMetadataUpdates) {
      const existing =
        (db.prepare('SELECT * FROM metadata WHERE item_id = ?').get(itemId) as any) || {}

      // --- Invalidation Logic (Structural Changes) ---
      let shouldInvalidateMetadata = false
      if (
        (updates.tmdbId !== undefined && updates.tmdbId !== existing.tmdb_id) ||
        ((updates as any).seasonNumber !== undefined &&
          (updates as any).seasonNumber !== existing.season_number) ||
        ((updates as any).episodeNumber !== undefined &&
          (updates as any).episodeNumber !== existing.episode_number)
      ) {
        shouldInvalidateMetadata = true
        // log(`[Repo] Invalidating metadata for ${itemId} due to structural change.`)
      }

      const currentImages = parseJsonSafe<any>(existing.images_json, {})
      if (updates.posterPath !== undefined) currentImages.poster = updates.posterPath
      if (updates.backdropPath !== undefined) currentImages.backdrop = updates.backdropPath
      if (updates.logoPath !== undefined) currentImages.logo = updates.logoPath

      // If Episode Number changes, the old Title/Overview are "wrong" but present.
      // We set last_refreshed_at = NULL to signal it's dirty.
      // Ideally the Metadata Service handles the re-fetch.

      const params = {
        '@id': itemId,
        '@tmdb_id': updates.tmdbId !== undefined ? updates.tmdbId : existing.tmdb_id,
        '@media_type': updates.mediaType !== undefined ? updates.mediaType : existing.media_type,
        '@title': updates.title !== undefined ? updates.title : existing.title,
        '@overview': updates.overview !== undefined ? updates.overview : existing.overview,
        '@year': updates.year !== undefined ? updates.year : existing.year,
        '@season_number':
          (updates as any).seasonNumber !== undefined
            ? (updates as any).seasonNumber
            : existing.season_number,
        '@episode_number':
          (updates as any).episodeNumber !== undefined
            ? (updates as any).episodeNumber
            : existing.episode_number,

        '@genres_json':
          updates.genres !== undefined ? JSON.stringify(updates.genres) : existing.genres_json,
        '@tags_json':
          updates.tags !== undefined ? JSON.stringify(updates.tags) : existing.tags_json,
        '@virtual_tags_json':
          updates.virtualTags !== undefined
            ? JSON.stringify(updates.virtualTags)
            : existing.virtual_tags_json,

        '@last_refreshed_at': shouldInvalidateMetadata
          ? null
          : updates.lastRefreshedAt !== undefined
            ? updates.lastRefreshedAt
            : existing.last_refreshed_at,

        '@people_json':
          (updates as any).tmdbCredits !== undefined
            ? JSON.stringify((updates as any).tmdbCredits)
            : existing.people_json,

        '@seasons_json':
          (updates as any).tmdbSeasons !== undefined
            ? JSON.stringify((updates as any).tmdbSeasons)
            : existing.seasons_json,
        '@episodes_json':
          (updates as any).tmdbEpisodes !== undefined
            ? JSON.stringify((updates as any).tmdbEpisodes)
            : existing.episodes_json,

        '@images_json': JSON.stringify(currentImages),

        '@locked_fields_json':
          (updates as any).lockedFields !== undefined
            ? JSON.stringify((updates as any).lockedFields || [])
            : existing.locked_fields_json,

        '@version': updates._v !== undefined ? updates._v : existing.version
      }

      db.prepare(
        `
        INSERT INTO metadata(
      item_id, tmdb_id, media_type, title, overview, year, season_number, episode_number,
      genres_json, tags_json, virtual_tags_json, people_json, seasons_json, episodes_json, images_json, locked_fields_json, last_refreshed_at, version
    ) VALUES(
      @id, @tmdb_id, @media_type, @title, @overview, @year, @season_number, @episode_number,
      @genres_json, @tags_json, @virtual_tags_json, @people_json, @seasons_json, @episodes_json, @images_json, @locked_fields_json, @last_refreshed_at, @version
    )
        ON CONFLICT(item_id) DO UPDATE SET
tmdb_id = excluded.tmdb_id,
  media_type = excluded.media_type,
  title = excluded.title,
  overview = excluded.overview,
  version = excluded.version,
  year = excluded.year,
  season_number = excluded.season_number,
  episode_number = excluded.episode_number,
  genres_json = excluded.genres_json,
  tags_json = excluded.tags_json,
  virtual_tags_json = excluded.virtual_tags_json,
  people_json = excluded.people_json,
  seasons_json = excluded.seasons_json,
  episodes_json = excluded.episodes_json,
  images_json = excluded.images_json,
  locked_fields_json = excluded.locked_fields_json,
  last_refreshed_at = excluded.last_refreshed_at
    `
      ).run(params)
    }

    // 4. Folder Settings
    const hasViewUpdates = VIEW_SETTINGS_KEYS.some((k) => k in updates)
    const hasScraperUpdates =
      'retrieve_children_metadata' in updates ||
      'children_type_hint' in updates ||
      'process_tv_children' in updates
    log(
      `[Repo] [TRACE] Folder settings check - hasViewUpdates: ${hasViewUpdates}, hasScraperUpdates: ${hasScraperUpdates}`
    )
    if (hasScraperUpdates) {
      log(
        `[Repo] [TRACE] Scraper update detected: rcm=${(updates as any).retrieve_children_metadata}, cth=${(updates as any).children_type_hint}, ptc=${(updates as any).process_tv_children}`
      )
    }
    log(`[Repo] [TRACE] Updates object keys: ${Object.keys(updates).join(', ')}`)

    if (hasViewUpdates || hasScraperUpdates) {
      const existing =
        (db.prepare('SELECT * FROM folder_settings WHERE item_id = ?').get(itemId) as any) || {}

      const viewSettings = parseJsonSafe<any>(existing.view_settings_json, {})
      const scraperSettings = parseJsonSafe<any>(existing.scraper_settings_json, {})

      if (hasViewUpdates) {
        for (const key of VIEW_SETTINGS_KEYS) {
          if (key in updates) (viewSettings as any)[key] = (updates as any)[key]
        }
      }

      if (hasScraperUpdates) {
        if ((updates as any).retrieve_children_metadata !== undefined)
          scraperSettings.retrieve_children_metadata = (updates as any).retrieve_children_metadata
        if ((updates as any).children_type_hint !== undefined)
          scraperSettings.children_type_hint = (updates as any).children_type_hint
        if ((updates as any).process_tv_children !== undefined)
          scraperSettings.process_tv_children = (updates as any).process_tv_children
      }

      log(`[DEBUG] Saving folder_settings for item ${itemId}:`)
      log(`[DEBUG]   viewSettings: ${JSON.stringify(viewSettings)}`)
      log(`[DEBUG]   scraperSettings: ${JSON.stringify(scraperSettings)}`)
      db.prepare(
        `
            INSERT INTO folder_settings(item_id, view_settings_json, scraper_settings_json)
VALUES(@id, @view, @scraper)
            ON CONFLICT(item_id) DO UPDATE SET
view_settings_json = excluded.view_settings_json,
  scraper_settings_json = excluded.scraper_settings_json
    `
      ).run({
        '@id': itemId,
        '@view': JSON.stringify(viewSettings),
        '@scraper': JSON.stringify(scraperSettings)
      })
      // Verify the save
      const saved = db.prepare('SELECT * FROM folder_settings WHERE item_id = ?').get(itemId) as any
      log(`[DEBUG] Verified save - stored in db: ${JSON.stringify(saved)}`)
    }
  })

  transaction()
  return getItemById(itemId)
}

export function deleteItem(itemId: string): LibraryItem | null {
  const db = getDb()
  const item = getItemById(itemId)
  if (!item) return null

  db.prepare('DELETE FROM items WHERE id = ?').run(itemId)
  return item
}

export function updateItemPathAndId(oldId: string, newRelativePath: string): LibraryItem | null {
  const db = getDb()
  const newId = generateId(newRelativePath)
  const newName = path.basename(newRelativePath)

  db.transaction(() => {
    db.prepare('UPDATE items SET id = ?, path = ?, name = ? WHERE id = ?').run(
      newId,
      newRelativePath,
      newName,
      oldId
    )
  })()

  return getItemById(newId)
}

// --- Copy Utilities ---

export function createTransferableCopy(item: LibraryItem): LibraryItem {
  return JSON.parse(JSON.stringify(item))
}

export async function createForDetailViewCopy(
  item: LibraryItem,
  fields?: string[]
): Promise<LibraryItem> {
  // Now strictly returns the item metadata, no children bundling.
  // Standardizing /items/:id to be resource-oriented.
  const copy = createTransferableCopy(item)
  return copy
}

/**
 * Specialized children fetcher for Detail Views.
 * Handles structural bundling (like Season -> Episode) based on the parent's layout.
 */
export async function getChildrenForDetailView(
  parentId: string,
  fields?: string[]
): Promise<LibraryItem[]> {
  const parent = getItemById(parentId) as MediaFolder
  if (!parent || parent.type !== 'folder') return []

  const settings = await readSettings()
  const { settings: resolved } = resolveViewSettings(parent, settings)

  // 1. Group/Virtualize children (e.g. into Virtual Seasons if layout requires Tabs/Sections)
  const children = await groupingService.groupItemsForDetailView(parent, { fields })

  // 2. Fetch grandchildren (Essential for physical Season -> Episode structure)
  // ONLY fetch if the layout is Tabs or Sections (the only views that "open" hierarchy).
  if (['tabs', 'sections'].includes(resolved.layout)) {
    for (const child of children) {
      if (child.type === 'folder' && !child.isVirtual) {
        child.children = getChildren(child.id, fields).filter(
          (c: LibraryItem) => !c.isHidden && !c.isMissing
        )
      }
    }
  }

  return children
}

// --- Grouping Helper ---

export function getValuesForKey(item: LibraryItem, key: string): string[] {
  // 1. Resolve Shorthand
  const normalizedKey = key === 'genre' ? 'genres' : key

  // 2. Schema-driven extraction
  const def = REPOSITORY_SCHEMA[normalizedKey]
  if (def?.getValue) return def.getValue(item)

  // 3. Dynamic JSON Key Extraction (tags.*, vt.*)
  if (key.startsWith('tags.')) {
    const tagKey = key.substring(5)
    const tagValue = item.tags?.[tagKey]
    return tagValue ? tagValue.split(',').map((v) => v.trim()) : []
  }

  if (key.startsWith('vt.')) {
    const vtKey = key.substring(3)
    const vtValue = item.virtualTags?.[vtKey]
    return vtValue ? [vtValue] : []
  }

  return []
}

/**
 * Fetches all seasons for a TV Show and populates their episodes.
 * Uses a recursive strategy (Show -> Season -> Episodes).
 * UPDATED: Accepts fields array to ensure lean fetching.
 */
export function getSeasonsWithEpisodes(showId: string, fields: string[] = []): LibraryItem[] {
  // 1. Fetch Seasons - apply field filtering
  const seasons = find({
    where: { parentId: showId },
    orderBy: { field: 'seasonNumber', direction: 'ASC' },
    fields: fields.length > 0 ? fields : undefined
  })

  // 2. Fetch Episodes for each Season - apply field filtering
  for (const season of seasons) {
    if (season.type === 'folder') {
      const episodes = find({
        where: { parentId: season.id },
        orderBy: { field: 'episodeNumber', direction: 'ASC' },
        fields: fields.length > 0 ? fields : undefined
      })
      season.children = episodes
    }
  }

  return seasons
}
