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

export async function updateIfChangedAndBroadcast(
  items: LibraryItem | LibraryItem[],
  options: { updateSuggestions?: boolean; settings?: Settings } = {}
): Promise<void> {
  if (!items || (Array.isArray(items) && items.length === 0)) return
  const itemsArray = Array.isArray(items) ? items : [items]

  const settings = options.settings ?? (await settingsService.readSettings())
  const modifiedItems: LibraryItem[] = []

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

      // Always persist to DB — virtual items are first-class rows
      repositoryService._updateItem(item.id, item)
    }
  })

  if (modifiedItems.length === 0) return

  // Re-evaluate virtual tags for modified items via SQL (the single authoritative path).
  // Then read the results back from the DB and attach them to the broadcast payloads,
  // so receivers always see accurate vtag values.
  const itemIds = modifiedItems.map((i) => i.id)
  virtualTagsService.applyVirtualTags(settings.virtualTags, itemIds)
  const freshVirtualTags = metadataRepo.fetchVirtualTagsForItems(itemIds)
  for (const item of modifiedItems) {
    item.virtualTags = freshVirtualTags[item.id] ?? {}
  }

  // Re-sync grouping virtual folders if any active groupings exist.
  syncAllGroupings()

  const plainItems = JSON.parse(JSON.stringify(modifiedItems))
  for (const item of plainItems) {
    const ancestors = repositoryService.getAncestors(item.id)
    item.ancestorIds = ancestors.map((a) => a.id)
  }

  log(`Broadcasting updates for ${modifiedItems.length} items.`)
  getTransport().notifyLibraryItemsUpdated(plainItems)

  if (options.updateSuggestions) {
    const [suggestions, groupByKeys] = await Promise.all([
      autocompleteService.getAutocompleteSuggestions(),
      autocompleteService.getGroupByKeys()
    ])
    getTransport().notifyMetadataIndexUpdated({ suggestions, groupByKeys })
  }
}
