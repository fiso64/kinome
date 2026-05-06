/**
 * REPOSITORY SERVICE (Domain Facade)
 *
 * PURPOSE:
 * This is the high-level API for library data. It acts as a "Facade" that abstracts 
 * the complexity of our multi-table database schema away from the rest of the app.
 *
 * PRIMARY RESPONSIBILITIES:
 * 1. Assembler: Combines raw data from physical repositories (Items, MediaEntities, UserState, Settings)
 *    into fully-formed, logical LibraryItem objects using Mappers.
 * 2. Transaction Coordinator: Manages atomic updates that span multiple tables.
 * 3. Query Abstraction: Uses the Query Builder to handle complex, joined SQL searches.
 *
 * WHAT THIS IS NOT (Avoid Bloat):
 * - NOT a place for raw SQL strings. All SQL must reside in specialized .repo.ts files.
 * - NOT a place for feature logic (Scanners, TV Structure, Next Up, etc.). Those belong in 
 *   orchestration services (LibraryService, MetadataService).
 *
 * WHEN TO BYPASS:
 * - Use specialized repos (e.g., itemsRepo, metadataRepo) directly when performing 
 *   performance-critical "bulk surgery" or isolated table operations that do not 
 *   require the overhead of logical LibraryItem mapping.
 */
import { getDb, initializeDatabase, runTransaction } from '../database/client'
import { mapRowToLibraryItem } from '../database/mappers'
import { buildFindQuery, type FindOptions } from '../database/query-builder'
import { ensureUpToDate } from './account-filter.service'
import { getCurrentAccountId } from '../request-context'
import * as itemsRepo from '../database/repositories/filesystem.repo'
import {
  ENTITY_COLUMNS_SQL,
  HOME_FOLDER_ID,
  HOME_CATEGORIES_ID,
  HOME_RECENTLY_ADDED_ID,
  HOME_GENRES_ID,
  HOME_ALL_MEDIA_ID
} from '../database/repositories/filesystem.repo'
import * as metadataRepo from '../database/repositories/metadata.repo'
import * as userRepo from '../database/repositories/user.repo'
import * as settingsRepo from '../database/repositories/settings.repo'
import type { LibraryItem, MediaFolder, MediaSource } from '@shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Repository Service] ${message}`)
}

// Bulk update state
let isBulkUpdating = false
export const getBulkUpdateStatus = (): boolean => isBulkUpdating
export const setBulkUpdateStatus = (status: boolean): void => {
  isBulkUpdating = status
}

// Re-export core database utilities
export { getDb, runTransaction } from '../database/client'
export { generateId, existsById, getItemPath, isItemHidden } from '../database/repositories/filesystem.repo'
export { REPOSITORY_SCHEMA, getValuesForKey, isValidField, ITEM_TABLE_FIELDS } from '../database/repo-definitions'
export { type FindOptions } from '../database/query-builder'
export { CORE_FIELDS } from '@shared/types'

// --- Lifecycle ---

export async function loadDb(): Promise<void> {
  log('Initializing SQLite database...')
  initializeDatabase()
}

export async function writeDb(): Promise<void> {
  // No-op for SQLite
}

export async function createNewDb(_rootNode: MediaFolder | null): Promise<void> {
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM items').run()
  })()
}

// Re-export stable home subfolder IDs so callers don't need a direct repo import.
export { HOME_CATEGORIES_ID, HOME_RECENTLY_ADDED_ID, HOME_GENRES_ID, HOME_ALL_MEDIA_ID } from '../database/repositories/filesystem.repo'

/**
 * Idempotent: ensures home subfolders and their initial view settings exist.
 * Uses INSERT OR IGNORE throughout — safe to call on every startup.
 * Returns true if home's view settings were inserted for the first time.
 */
export function ensureHomeDefaults(rootId: string): boolean {
  itemsRepo.ensureHomeVirtualFolder(rootId)
  itemsRepo.ensureHomeChildren()

  const isFirstHomeRun = settingsRepo.initSettings(HOME_FOLDER_ID, {
    layout: 'sections',
    appliedGrouping: 'vt._home_category',
    childViewSettings: {
      layout: 'horizontal-grid',
      sortBy: 'random',
      overrides: {
        [HOME_CATEGORIES_ID]: { layout: 'button-grid', gridPosterSize: 220, scrollHorizontally: true, sortBy: 'alpha' },
        [HOME_GENRES_ID]: { layout: 'button-grid', gridPosterSize: 180, scrollHorizontally: false, sortBy: 'alpha' }
      }
    },
    sortTop: [HOME_CATEGORIES_ID, HOME_RECENTLY_ADDED_ID],
    sortBottom: [HOME_GENRES_ID]
  })

  settingsRepo.initSettings(HOME_CATEGORIES_ID, {
    layout: 'button-grid',
    gridPosterSize: 250,
    scrollHorizontally: false,
    appliedGrouping: 'vt._home_category',
    sortTop: [HOME_ALL_MEDIA_ID]
  })

  settingsRepo.initSettings(HOME_ALL_MEDIA_ID, {
    layout: 'sections',
    appliedGrouping: 'vt._home_category'
  })

  settingsRepo.initSettings(HOME_RECENTLY_ADDED_ID, {
    sortBy: 'date-added',
    sortDescending: true,
  })

  settingsRepo.initSettings(HOME_GENRES_ID, {
    layout: 'button-grid',
    gridPosterSize: 180,
    scrollHorizontally: false,
    appliedGrouping: 'genre'
  })

  return isFirstHomeRun
}

export function ensureSourceRoot(source: MediaSource, resolvedAbsPath: string): void {
  itemsRepo.ensureLibraryVirtualRoot()
  itemsRepo.ensureSourceRoot(source.id, resolvedAbsPath)
  ensureHomeDefaults(itemsRepo.LIBRARY_ROOT_ID)
}

export function getHomeFolderId(): string {
  return HOME_FOLDER_ID
}

// --- Read Operations ---

export function getRoot(): MediaFolder | null {
  const row = itemsRepo.fetchRoot()
  return row ? (mapRowToLibraryItem(row) as MediaFolder) : null
}

export function getItemById(id: string): LibraryItem | null {
  const row = itemsRepo.fetchItemById(id)
  return row ? mapRowToLibraryItem(row) : null
}

export function findItemByPath(pathStr: string): LibraryItem | null {
  const row = itemsRepo.fetchItemByPath(pathStr)
  return row ? mapRowToLibraryItem(row) : null
}

export function findParent(id: string): MediaFolder | null {
  const row = itemsRepo.fetchParent(id)
  return row ? (mapRowToLibraryItem(row) as MediaFolder) : null
}

export function getChildren(
  parentId: string,
  fields?: string[],
  includeHidden = false,
  includeIgnored = false
): LibraryItem[] {
  return find({ where: { parentId }, fields, includeHidden, includeIgnored })
}

export function getChildrenForDetailView(parentId: string, fields?: string[]): LibraryItem[] {
  return getChildren(parentId, fields)
}

export function getTvShowsForStructuralSync(): LibraryItem[] {
  const db = getDb()
  // SPEC(scan_architecture.md §Phase 2, line 163-169):
  //   process_tv_children is TRUE by default for TV shows.
  //   LEFT JOIN + IS NOT 0 treats NULL (no folder_settings row) as enabled.
  const rows = db
    .prepare(
      `
    SELECT i.*, ${ENTITY_COLUMNS_SQL}, f.process_tv_children
    FROM items i
    JOIN media_entities e ON i.entity_id = e.id
    LEFT JOIN folder_settings f ON i.id = f.item_id
    WHERE i.type = 'folder'
      AND e.media_type = 'tv'
      AND i.is_ignored = 0
      AND i.is_hidden = 0
      AND (f.process_tv_children IS NULL OR f.process_tv_children != 0)
  `
    )
    .all() as any[]
  return rows.map(mapRowToLibraryItem)
}

export function getDiscoveryItemsForPhase2(): LibraryItem[] {
  const db = getDb()
  // SPEC(scan_architecture.md §Phase 2, line 187-195):
  //   dirty_roots = items WHERE
  //     (mediaType IN ('movie', 'tv', NULL) AND lastRefreshedAt IS NULL)
  //     AND (parent.retrieve_children_metadata == TRUE)
  //
  //   Both conditions are ANDed: must be dirty AND have a gated parent.
  const rows = db
    .prepare(
      `
    SELECT i.*, ${ENTITY_COLUMNS_SQL},
           f.view_settings_json, f.retrieve_children_metadata, f.children_type_hint, f.process_tv_children
    FROM items i
    LEFT JOIN media_entities e ON i.entity_id = e.id
    LEFT JOIN folder_settings f ON i.id = f.item_id
    LEFT JOIN folder_settings pf ON i.parent_id = pf.item_id
    WHERE (e.media_type IN ('movie', 'tv') OR e.media_type IS NULL)
      AND e.last_refreshed_at IS NULL
      AND i.is_ignored = 0
      AND i.is_hidden = 0
      AND pf.retrieve_children_metadata = 1
  `
    )
    .all() as any[]

  return rows.map(mapRowToLibraryItem)
}

export function getAllDescendantsAsList(node: MediaFolder): LibraryItem[] {
  const rows = itemsRepo.fetchAllDescendantsRaw(node.id)
  return rows.map(mapRowToLibraryItem)
}

export function getEpisodeProgressForShow(showId: string, userId: string): import('../utils/continue-watching').EpisodeInfo[] {
  return itemsRepo.fetchEpisodeProgressForShow(showId, userId) as import('../utils/continue-watching').EpisodeInfo[]
}

export function getAncestorIdsForItems(itemIds: string[]): Record<string, string[]> {
  return itemsRepo.fetchAncestorIdsForItems(itemIds)
}

export function getAncestors(itemId: string): LibraryItem[] {
  const rows = itemsRepo.fetchAncestorsRaw(itemId)
  return rows.map(mapRowToLibraryItem)
}

export function find(options: FindOptions = {}): LibraryItem[] {
  const userId = options.userId ?? getCurrentAccountId()
  if (userId) ensureUpToDate(userId)
  const { query, params } = buildFindQuery({ ...options, userId })
  const rows = itemsRepo.rawFind(query, params)
  return rows.map(mapRowToLibraryItem)
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

export function getItemCredits(id: string): any | null {
  return metadataRepo.fetchCreditsByItemId(id)
}

// --- Write Operations ---

export function deleteItem(itemId: string): LibraryItem | null {
  const item = getItemById(itemId)
  if (!item) return null
  itemsRepo.deleteItem(itemId)
  return item
}

export function migrateRecord(oldId: string, item: any): void {
  itemsRepo.migrateRecord(oldId, item)
}

export function updateItemPathAndId(oldId: string, newRelativePath: string): LibraryItem | null {
  const sourceId = itemsRepo.getItemSourceId(oldId)
  if (!sourceId) return null
  itemsRepo.updateItemPathAndId(oldId, newRelativePath, sourceId)
  const newId = itemsRepo.generateId(sourceId, newRelativePath)
  return getItemById(newId)
}

/**
 * Orchestrates a multi-table update for a library item.
 * This is the "Service" level update logic.
 */
export function _updateItem(itemId: string, updates: Partial<LibraryItem>, options?: { skipFetch?: boolean }, userId?: string): LibraryItem | null {
  return runTransaction(() => {
    // 1. Invariant Enforcement
    const existingMeta = metadataRepo.fetchMetadataRow(itemId)
    const mediaType = updates.mediaType || existingMeta?.media_type

    if (mediaType === 'tv') {
      ; (updates as any).seasonNumber = null
        ; (updates as any).episodeNumber = null
    } else if (mediaType === 'season') {
      ; (updates as any).episodeNumber = null
    }

    // 2. Perform Updates across Repositories
    if (updates.isHidden !== undefined || updates.isMissing !== undefined) {
      itemsRepo.updateItemVisibility(itemId, updates.isHidden, updates.isMissing)
    }

    const hasUserStateUpdate =
      updates.watched !== undefined ||
      updates.lastWatched !== undefined ||
      updates.continueWatchingDismissed !== undefined ||
      updates.nextUpDismissed !== undefined ||
      (updates as any).nextUpEpisodeId !== undefined

    if (hasUserStateUpdate) {
      if (!userId) throw new Error(`_updateItem: userId required when updating user state fields (itemId=${itemId})`)
      userRepo.updateUserState(itemId, userId, {
        watched: updates.watched,
        lastWatchedAt: updates.lastWatched,
        continueWatchingDismissed: updates.continueWatchingDismissed,
        nextUpDismissed: updates.nextUpDismissed,
        nextUpEpisodeId: (updates as any).nextUpEpisodeId
      })
    }

    // Metadata Updates (writes to media_entities via metadataRepo)
    const metadataKeys = [
      'tmdbId', 'mediaType', 'title', 'overview', 'year', 'runtime', 'seasonNumber', 'episodeNumber',
      'genres', 'tags', 'virtualTags', 'tmdbCredits', 'posterPath', 'backdropPath', 'logoPath',
      'lockedFields', 'lastRefreshedAt', '_v'
    ]
    if (metadataKeys.some((k) => k in updates)) {
      metadataRepo.upsertMetadata(itemId, updates)
    }

    // Virtual Folder Filter
    if ((updates as any).filter !== undefined) {
      itemsRepo.updateFilterJson(itemId, (updates as any).filter ? JSON.stringify((updates as any).filter) : null)
    }

    // Folder Settings
    if (updates.viewSettings !== undefined || updates.folderSettings !== undefined) {
      settingsRepo.mergeSettings(itemId, {
        viewSettings: updates.viewSettings,
        folderSettings: updates.folderSettings
      })
    }

    return options?.skipFetch ? null : getItemById(itemId)
  })
}

// --- Utilities ---

export function isFieldLocked(item: LibraryItem, field: string): boolean {
  return item.lockedFields?.includes(field) ?? false
}

export function createTransferableCopy(item: LibraryItem): LibraryItem {
  return JSON.parse(JSON.stringify(item))
}

export async function createForDetailViewCopy(item: LibraryItem, _fields?: string[]): Promise<LibraryItem> {
  return createTransferableCopy(item)
}
