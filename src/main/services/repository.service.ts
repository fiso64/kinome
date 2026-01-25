import crypto from 'crypto'
import { getDb, initializeDatabase } from '../database/client'
import type { LibraryItem, MediaFolder } from '../../shared/types'
import { VIEW_SETTINGS_KEYS } from '../../shared/types'

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

// --- Mappers ---

function parseJsonSafe<T>(jsonString: string | null, fallback: T): T {
  if (!jsonString) return fallback
  try {
    return JSON.parse(jsonString)
  } catch (e) {
    return fallback
  }
}

function mapRowToLibraryItem(row: any): LibraryItem {
  if (row.media_type === 'tv' && !row.seasons_json) {
    // Debug log for missing season data
    // log(`[Repo] Warning: TV Show "${row.name}" has no seasons_json. Raw: ${Object.keys(row).join(',')}`)
  }

  const images = parseJsonSafe<any>(row.images_json, {})
  const genres = parseJsonSafe<string[]>(row.genres_json, [])
  const tags = parseJsonSafe<Record<string, string>>(row.tags_json, {})
  const virtualTags = parseJsonSafe<Record<string, string>>(row.virtual_tags_json, {})
  const credits = parseJsonSafe(row.people_json, null)
  const seasons = parseJsonSafe(row.seasons_json, null)
  const episodes = parseJsonSafe(row.episodes_json, null)
  const viewSettings = parseJsonSafe<any>(row.view_settings_json, {})
  const scraperSettings = parseJsonSafe<any>(row.scraper_settings_json, {})

  const vtCount = virtualTags ? Object.keys(virtualTags).length : 0
  if (vtCount > 0) {
    // log(`[Repo] Loaded ${vtCount} virtual tags for "${row.name}" (ID: ${row.id.substring(0,8)}...)`)
  }

  // Detect if a metadata row actually exists.
  // In the LEFT JOIN, if there is no matching metadata row, m.item_id will be NULL.
  const hasMetadata = row.item_id !== null

  const base: any = {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    path: row.path,
    type: row.type,
    size: row.size,
    mtime: row.mtime,
    birthtime: row.birthtime,
    isHidden: Boolean(row.is_hidden),
    isMissing: Boolean(row.is_missing),
    isUserEdited: Boolean(row.is_user_edited),

    // Metadata
    // Logic:
    // 1. If no metadata row exists (hasMetadata false) -> undefined (Not Scanned)
    // 2. If row exists, tmdb_id is NOT NULL -> row.tmdb_id (Found)
    // 3. If row exists, tmdb_id IS NULL:
    //    a. If version IS NULL -> undefined (Created by VirtualTags only, Not Scanned)
    //    b. If version IS NOT NULL -> null (Scanned, but Not Found)
    tmdbId: hasMetadata 
      ? (row.tmdb_id !== null ? row.tmdb_id : (row.version !== null ? null : undefined)) 
      : undefined,
    
    mediaType: hasMetadata ? row.media_type : undefined,
    title: row.title,
    originalTitle: row.original_title,
    overview: row.overview,
    releaseDate: row.release_date,
    year: row.year,
    runtime: row.runtime,
    posterPath: images.poster,
    backdropPath: images.backdrop,
    logoPath: images.logo,
    genres: genres,
    tags: tags,
    virtualTags: virtualTags,
    tmdbCredits: credits,
    tmdbSeasons: seasons,
    tmdbEpisodes: episodes,

    // TV Specific
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,

    // User State
    watched: Boolean(row.watched),
    lastWatched: row.last_watched_at,
    continueWatchingDismissed: Boolean(row.continue_watching_dismissed),
    nextUpDismissed: Boolean(row.next_up_dismissed),

    // Cache Flags
    tmdbDetailsFetched: !!row.tmdb_id,
    tmdbCreditsFetched: !!credits,
    tmdbEpisodesFetched: !!episodes || (row.media_type === 'tv' && !!seasons),

    // Versioning
    _v: row.version
  }

  // Merge View/Folder Settings
  Object.assign(base, viewSettings)
  if (row.type === 'folder') {
    Object.assign(base, {
      retrieve_children_metadata: scraperSettings.retrieve_children_metadata,
      children_type_hint: scraperSettings.children_type_hint,
      process_tv_children: scraperSettings.process_tv_children,
      children: null // Null indicates lazy loading required
    })
  }

  return base as LibraryItem
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
    .get()

  if (!row) return null
  return mapRowToLibraryItem(row) as MediaFolder
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
 */
export function getChildren(parentId: string): LibraryItem[] {
  const db = getDb()
  const rows = db
    .prepare(
      `
    SELECT i.*, m.*, u.watched, u.last_watched_at, u.continue_watching_dismissed, u.next_up_dismissed, f.view_settings_json, f.scraper_settings_json
    FROM items i
    LEFT JOIN metadata m ON i.id = m.item_id
    LEFT JOIN user_state u ON i.id = u.item_id
    LEFT JOIN folder_settings f ON i.id = f.item_id
    WHERE i.parent_id = ?
    ORDER BY i.name ASC
  `
    )
    .all(parentId)

  return rows.map(mapRowToLibraryItem)
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
    .all(node.id)

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
    .all(itemId, itemId)

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
    .all()
  return rows.map(mapRowToLibraryItem)
}

// --- Write Operations ---

export function generateId(relativePath: string): string {
  return crypto.createHash('sha256').update(relativePath).digest('hex')
}

export function markAsUserEdited(itemId: string): LibraryItem[] {
  const db = getDb()
  db.prepare('UPDATE items SET is_user_edited = 1 WHERE id = ?').run(itemId)
  const item = getItemById(itemId)
  return item ? [item] : []
}

export function updateItem(itemId: string, updates: Partial<LibraryItem>): LibraryItem | null {
  const db = getDb()

  const transaction = db.transaction(() => {
    // 1. Items Table
    if (
      updates.isHidden !== undefined ||
      updates.isMissing !== undefined ||
      updates.isUserEdited !== undefined
    ) {
      db.prepare(
        `
        UPDATE items SET 
          is_hidden = COALESCE(@isHidden, is_hidden), 
          is_missing = COALESCE(@isMissing, is_missing),
          is_user_edited = COALESCE(@isUserEdited, is_user_edited)
        WHERE id = @id
      `
      ).run({
        id: itemId,
        isHidden: updates.isHidden === undefined ? null : updates.isHidden ? 1 : 0,
        isMissing: updates.isMissing === undefined ? null : updates.isMissing ? 1 : 0,
        isUserEdited: updates.isUserEdited === undefined ? null : updates.isUserEdited ? 1 : 0
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
          `[Repo] WARNING: Multiple user_state rows found for item ${itemId}:`,
          allStates
        )
      }
      console.log(`[Repo] updateItem ${itemId} - Existing State:`, existingState)
      console.log(`[Repo] updateItem ${itemId} - Updates:`, updates)

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
            : existingState.next_up_dismissed
      }

      db.prepare(
        `
        INSERT INTO user_state (item_id, watched, last_watched_at, continue_watching_dismissed, next_up_dismissed)
        VALUES (@id, @watched, @lastWatched, @continueWatchingDismissed, @nextUpDismissed)
        ON CONFLICT(item_id, user_id) DO UPDATE SET
          watched = excluded.watched,
          last_watched_at = excluded.last_watched_at,
          continue_watching_dismissed = excluded.continue_watching_dismissed,
          next_up_dismissed = excluded.next_up_dismissed
      `
      ).run({
        id: itemId,
        watched: val.watched ?? 0,
        lastWatched: val.lastWatched,
        continueWatchingDismissed: val.cwd ?? 0,
        nextUpDismissed: val.nud ?? 0
      })
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
      '_v'
    ]
    const hasMetadataUpdates = metadataKeys.some((k) => k in updates)

    if (hasMetadataUpdates) {
      const existing =
        (db.prepare('SELECT * FROM metadata WHERE item_id = ?').get(itemId) as any) || {}

      const currentImages = parseJsonSafe<any>(existing.images_json, {})
      if (updates.posterPath !== undefined) currentImages.poster = updates.posterPath
      if (updates.backdropPath !== undefined) currentImages.backdrop = updates.backdropPath
      if (updates.logoPath !== undefined) currentImages.logo = updates.logoPath

      const params = {
        id: itemId,
        tmdb_id: updates.tmdbId !== undefined ? updates.tmdbId : existing.tmdb_id,
        media_type: updates.mediaType !== undefined ? updates.mediaType : existing.media_type,
        title: updates.title !== undefined ? updates.title : existing.title,
        overview: updates.overview !== undefined ? updates.overview : existing.overview,
        year: updates.year !== undefined ? updates.year : existing.year,
        season_number:
          (updates as any).seasonNumber !== undefined
            ? (updates as any).seasonNumber
            : existing.season_number,
        episode_number:
          (updates as any).episodeNumber !== undefined
            ? (updates as any).episodeNumber
            : existing.episode_number,

        genres_json:
          updates.genres !== undefined ? JSON.stringify(updates.genres) : existing.genres_json,
        tags_json: updates.tags !== undefined ? JSON.stringify(updates.tags) : existing.tags_json,
        virtual_tags_json:
          updates.virtualTags !== undefined
            ? JSON.stringify(updates.virtualTags)
            : existing.virtual_tags_json,
        people_json:
          updates.tmdbCredits !== undefined
            ? JSON.stringify(updates.tmdbCredits)
            : existing.people_json,
        seasons_json:
          (updates as any).tmdbSeasons !== undefined
            ? JSON.stringify((updates as any).tmdbSeasons)
            : existing.seasons_json,
        episodes_json:
          (updates as any).tmdbEpisodes !== undefined
            ? JSON.stringify((updates as any).tmdbEpisodes)
            : existing.episodes_json,
        images_json: JSON.stringify(currentImages),
        version: updates._v !== undefined ? updates._v : existing.version
      }

      db.prepare(
        `
        INSERT INTO metadata (
          item_id, tmdb_id, media_type, title, overview, year, season_number, episode_number,
          genres_json, tags_json, virtual_tags_json, people_json, seasons_json, episodes_json, images_json, version
        ) VALUES (
          @id, @tmdb_id, @media_type, @title, @overview, @year, @season_number, @episode_number,
          @genres_json, @tags_json, @virtual_tags_json, @people_json, @seasons_json, @episodes_json, @images_json, @version
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
          images_json = excluded.images_json
      `
      ).run(params)
    }

    // 4. Folder Settings
    const hasViewUpdates = VIEW_SETTINGS_KEYS.some((k) => k in updates)
    const hasScraperUpdates =
      'retrieve_children_metadata' in updates ||
      'children_type_hint' in updates ||
      'process_tv_children' in updates

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

      db.prepare(
        `
            INSERT INTO folder_settings (item_id, view_settings_json, scraper_settings_json)
            VALUES (@id, @view, @scraper)
            ON CONFLICT(item_id) DO UPDATE SET
              view_settings_json = excluded.view_settings_json,
              scraper_settings_json = excluded.scraper_settings_json
        `
      ).run({
        id: itemId,
        view: JSON.stringify(viewSettings),
        scraper: JSON.stringify(scraperSettings)
      })
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

// --- Copy Utilities ---

export function createTransferableCopy(item: LibraryItem): LibraryItem {
  return JSON.parse(JSON.stringify(item))
}

export function createForDetailViewCopy(item: LibraryItem): LibraryItem {
  const copy = createTransferableCopy(item)
  if (copy.type === 'folder') {
    // 1. Fetch immediate children
    copy.children = getChildren(copy.id).filter((c: LibraryItem) => !c.isHidden && !c.isMissing)

    // 2. Fetch grandchildren (Essential for TV Shows: Show -> Season -> Episodes)
    for (const child of copy.children) {
      if (child.type === 'folder') {
        child.children = getChildren(child.id).filter(
          (c: LibraryItem) => !c.isHidden && !c.isMissing
        )
        if (child.children.length === 0) {
          console.log(`[Repo] Warning: No children found for ${child.name} (ID: ${child.id})`)
        } else {
          console.log(`[Repo] Found ${child.children.length} children for ${child.name}`)
          if (child.children.length > 0) {
            console.log(
              `[Repo] Sample Child for ${child.name}:`,
              JSON.stringify(child.children[0], null, 2)
            )
          }
        }
      }
    }
  }
  return copy
}
