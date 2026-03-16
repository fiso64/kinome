import equal from 'fast-deep-equal'
import * as repositoryService from './repository.service'
import * as settingsService from './settings.service'
import * as virtualTagsService from './virtualTags.service'
import { getTransport } from '../transport.registry'
import type { LibraryItem } from '@shared/types'
import * as autocompleteService from './autocomplete.service'
import { syncAllGroupings } from './virtualFolders.service'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Item Update Service] ${message}`)
}

/**
 * Creates a "content-only" snapshot for change detection.
 * Excludes volatile system fields and deep relations to prevent false positives.
 */
function getComparisonSnapshot(item: LibraryItem | null | undefined) {
  if (!item) return null

  // We only exclude fields that are:
  // 1. Recursive/Relational (children)
  // 2. Internal DB implementation details (_internalId, _v)
  // 3. Runtime broadcast noise (ancestorIds, isVirtual)
  const {
    _v, // TODO: Really think about _v handling.
    _internalId,
    children,
    ancestorIds,
    isVirtual,
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
  options: { updateSuggestions?: boolean } = {}
): Promise<void> {
  if (!items || (Array.isArray(items) && items.length === 0)) return
  const itemsArray = Array.isArray(items) ? items : [items]

  const settings = await settingsService.readSettings()
  const modifiedItems: LibraryItem[] = []

  repositoryService.runTransaction(() => {
    for (const item of itemsArray) {
      const existing = repositoryService.getItemById(item.id)

      // 1. Construct the hypothetical "Next State"
      // We merge the partial update 'item' over the 'existing' full object.
      // This fills in the missing holes in the partial update with current DB data.
      const nextState = existing ? { ...existing, ...item } : item

      // 2. Recalculate Virtual Tags on the FULL state
      // This fixes the bug where tags were lost because partial updates missed dependency fields (e.g. genres)
      const newVirtualTags = virtualTagsService.evaluateVirtualTagsForItem(
        nextState as LibraryItem,
        settings
      )

      // Apply the calculated tags to both our comparison object AND the payload
      nextState.virtualTags = newVirtualTags
      item.virtualTags = newVirtualTags

      // 3. Detect Changes using the robust snapshot comparison
      // Now we compare Full Object (Existing) vs Full Object (Next State)
      // We also allow forcing an update if _v was explicitly provided in the update payload.
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

      // Always persist to DB to ensure system fields (like lastRefreshedAt) are saved
      if (!item.isVirtual) {
        repositoryService._updateItem(item.id, item)
      }
    }
  })

  if (modifiedItems.length === 0) return

  // Re-sync grouping virtual folders if any active groupings exist.
  // This is cheap (one query + set diff per active grouping) and ensures
  // grouping folders stay in sync after metadata changes.
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
