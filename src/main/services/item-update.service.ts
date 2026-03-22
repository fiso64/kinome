import equal from 'fast-deep-equal'
import * as repositoryService from './repository.service'
import * as settingsService from './settings.service'
import * as virtualTagsService from './virtualTags.service'
import * as metadataRepo from '../database/repositories/metadata.repo'
import { getTransport } from '../transport.registry'
import type { LibraryItem, Settings } from '@shared/types'
import * as autocompleteService from './autocomplete.service'
import { syncAllGroupings } from './grouping.service'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Item Update Service] ${message}`)
}

/**
 * Creates a "content-only" snapshot for change detection.
 * Excludes volatile system fields, deep relations, and derived data.
 *
 * virtualTags are excluded because they are derived from metadata fields that
 * ARE included — if metadata changes, the item is already detected as changed.
 * Fresh vtags are fetched from the DB after SQL evaluation and attached before
 * broadcasting, so the broadcast payload is always accurate.
 */
function getComparisonSnapshot(item: LibraryItem | null | undefined) {
  if (!item) return null

  const {
    _v,
    _internalId,
    children,
    ancestorIds,
    isVirtual,
    virtualTags,
    ...data
  } = item as any

  return data
}

/**
 * Robust comparison function using deep snapshots.
 * IMPORTANT: Careful not to use this for partial updates (without merging first), as it will always return false.
 */
export function isItemDataSame(existing: LibraryItem, updated: LibraryItem): boolean {
  const existingSnapshot = getComparisonSnapshot(existing)
  const nextSnapshot = getComparisonSnapshot(updated)
  const same = equal(existingSnapshot, nextSnapshot)

  /*
  if (!same) {
    const diff: any = {}
    const allKeys = new Set([...Object.keys(existingSnapshot || {}), ...Object.keys(nextSnapshot || {})])
    for (const key of allKeys) {
       if (!equal((existingSnapshot as any)?.[key], (nextSnapshot as any)?.[key])) {
         diff[key] = { from: (existingSnapshot as any)?.[key], to: (nextSnapshot as any)?.[key] }
       }
    }
    console.log(`[Item Update] Data changed for ${existing.id}:`, JSON.stringify(diff, null, 2))
  }
  */

  return same
}

/**
 * The shared post-write broadcast pipeline: virtual tags → groupings → ancestor IDs → WS broadcast.
 *
 * Called by updateIfChangedAndBroadcast after its detect+write phase, and directly by bulk
 * operations (bulkMarkWatched, bulkClearMetadata) that handle their own efficient SQL writes.
 *
 * Items passed here must already reflect their final state — the values will be broadcast as-is.
 * Caller is responsible for stamping _v before calling (e.g. item._v = Date.now()).
 */
export async function broadcastModifiedItems(
  items: LibraryItem[],
  options: { updateSuggestions?: boolean; settings?: Settings } = {}
): Promise<void> {
  if (items.length === 0) return

  const settings = options.settings ?? (await settingsService.readSettings())

  const itemIds = items.map((i) => i.id)

  const t1 = Date.now()
  virtualTagsService.applyVirtualTags(settings.virtualTags, itemIds)
  const freshVirtualTags = metadataRepo.fetchVirtualTagsForItems(itemIds)
  log(`[Timing] applyVirtualTags took ${Date.now() - t1}ms`)
  for (const item of items) {
    item.virtualTags = freshVirtualTags[item.id] ?? {}
  }

  const t2 = Date.now()
  syncAllGroupings()
  log(`[Timing] syncAllGroupings took ${Date.now() - t2}ms`)

  const plainItems = JSON.parse(JSON.stringify(items))
  const t3 = Date.now()
  const ancestorMap = repositoryService.getAncestorIdsForItems(plainItems.map((i: any) => i.id))
  for (const item of plainItems) {
    item.ancestorIds = ancestorMap[item.id] ?? []
  }
  log(`[Timing] getAncestors took ${Date.now() - t3}ms`)

  log(`Broadcasting updates for ${items.length} items.`)
  getTransport().notifyLibraryItemsUpdated(plainItems)

  if (options.updateSuggestions) {
    const [suggestions, groupByKeys] = await Promise.all([
      autocompleteService.getAutocompleteSuggestions(),
      autocompleteService.getGroupByKeys()
    ])
    getTransport().notifyMetadataIndexUpdated({ suggestions, groupByKeys })
  }
}

export async function updateIfChangedAndBroadcast(
  items: LibraryItem | LibraryItem[],
  options: { updateSuggestions?: boolean; settings?: Settings } = {}
): Promise<void> {
  if (!items || (Array.isArray(items) && items.length === 0)) return
  const itemsArray = Array.isArray(items) ? items : [items]

  const settings = options.settings ?? (await settingsService.readSettings())
  const modifiedItems: LibraryItem[] = []

  const t0 = Date.now()
  repositoryService.runTransaction(() => {
    for (const item of itemsArray) {
      const existing = repositoryService.getItemById(item.id)

      // 1. Construct the hypothetical "Next State"
      // We merge the partial update 'item' over the 'existing' full object.
      // This fills in the missing holes in the partial update with current DB data.
      const nextState = existing ? { ...existing, ...item } : item

      // 2. Detect Changes using snapshot comparison (virtualTags excluded — derived data)
      // Force an update if _v was explicitly provided in the update payload.
      const forceUpdate =
        (item as any)._v !== undefined && (item as any)._v !== (existing as any)?._v

      const existingSnapshot = getComparisonSnapshot(existing)
      const nextSnapshot = getComparisonSnapshot(nextState as LibraryItem)
      const hasRealChanges = !existing || forceUpdate || !equal(existingSnapshot, nextSnapshot)

      if (hasRealChanges) {
        item._v = Date.now()
        modifiedItems.push(item)
        autocompleteService.invalidateCache()
      }

      // Strip fields that haven't changed to avoid unnecessary DB writes.
      // `existing` already has genres/tmdbCredits from ENTITY_COLUMNS_SQL subqueries — no extra reads.
      // Skipping unchanged relational data avoids upsertGenres/upsertCredits (expensive DELETE+INSERT).
      // Skipping unchanged scalar metadata avoids the upsertMetadata INSERT OR REPLACE entirely.
      const updatePayload: any = { ...item }
      if (existing) {
        const relationalKeys = ['genres', 'tmdbCredits', 'tags'] as const
        const scalarMetaKeys = [
          'tmdbId', 'mediaType', 'title', 'overview', 'year', 'seasonNumber', 'episodeNumber',
          'posterPath', 'backdropPath', 'logoPath', 'lockedFields', 'lastRefreshedAt'
        ] as const
        for (const key of [...relationalKeys, ...scalarMetaKeys]) {
          if (key in updatePayload && equal(updatePayload[key], (existing as any)[key])) {
            delete updatePayload[key]
          }
        }
      }

      // Always persist to DB — virtual items are first-class rows.
      // skipFetch: true — the return value is unused here; saves one heavy getItemById per item.
      repositoryService._updateItem(item.id, updatePayload, { skipFetch: true })
    }
  })
  log(`[Timing] runTransaction total: ${Date.now() - t0}ms`)

  await broadcastModifiedItems(modifiedItems, { ...options, settings })
}
