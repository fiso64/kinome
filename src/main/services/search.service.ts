import Fuse from 'fuse.js'
import { serviceEventEmitter } from './event.emitter.service'
import type { Database, LibraryItem, MediaFolder, SearchIndexEntry } from '../shared/types'
import { SEARCH_INDEX_PROPERTIES } from '../shared/types'
import { itemMatchesAllTags } from '../shared/filter'

const SEARCH_RESULT_LIMIT = 50

let searchIndex: SearchIndexEntry[] = []
const itemMap = new Map<string, LibraryItem>()
const parentMap = new Map<string, string>() // Map<childId, parentId>

const EXCLUDED_FOLDER_NAMES = [
  'extras',
  'featurettes',
  'specials',
  'behind the scenes',
  'deleted scenes',
  'interviews'
].map((name) => name.toLowerCase())

/**
 * Calculates a static "importance" score for an item.
 * @param item The item to score.
 * @param parent The item's parent, if it exists.
 * @returns A numeric score.
 */
function calculateStaticScore(item: LibraryItem, parent?: LibraryItem): number {
  let score = 0
  // Major boost for poster
  if (item.posterPath) score += 100
  // Minor boost for having a fetched title
  if (item.title) score += 10
  // Minor boost for being a folder
  if (item.type === 'folder') score += 5

  // Soft deduplication: a file whose parent has a poster gets a penalty.
  if (item.type === 'file' && parent?.posterPath) {
    score -= 50
  }

  return score
}

/**
 * Creates a denormalized, flat search entry from a library item.
 * This function is the key to performance: it creates plain JavaScript
 * object copies of any nested data, ensuring the search index itself
 * is free of proxies and is "IPC-safe" by design.
 * @param item The library item to convert.
 * @param parent The item's parent.
 * @returns A new, plain search index entry.
 */
function createSearchIndexEntry(item: LibraryItem, parent?: LibraryItem): SearchIndexEntry {
  const entry: Partial<SearchIndexEntry> = {}

  // Copy all relevant properties from the item to the search entry.
  for (const key of SEARCH_INDEX_PROPERTIES) {
    if (Object.prototype.hasOwnProperty.call(item, key)) {
      const value = (item as any)[key]
      // Deep clone arrays/objects to ensure the index is free of proxies.
      if (typeof value === 'object' && value !== null) {
        ;(entry as any)[key] = JSON.parse(JSON.stringify(value))
      } else {
        ;(entry as any)[key] = value
      }
    }
  }

  // Handle special cases and computed properties.
  entry.title = item.title ?? item.name

  // Extract person names from credits
  if ('tmdbCredits' in item && item.tmdbCredits) {
    const personNames = new Set<string>()
    ;(item.tmdbCredits.cast ?? []).forEach((p) => p.name && personNames.add(p.name))
    ;(item.tmdbCredits.crew ?? []).forEach((p) => p.name && personNames.add(p.name))
    if (personNames.size > 0) {
      entry.persons = Array.from(personNames)
    }
  }

  entry.staticScore = calculateStaticScore(item, parent)

  return entry as SearchIndexEntry
}

/**
 * Adds or updates an entry in the search index array.
 */
function _updateOrAddItemToIndex(entry: SearchIndexEntry) {
  const index = searchIndex.findIndex((i) => i.id === entry.id)
  if (index !== -1) {
    searchIndex[index] = entry // Update existing item
  } else {
    searchIndex.push(entry) // Add new item
  }
}

/**
 * Removes an entry from the search index array by its ID.
 */
export function removeItemFromIndex(itemId: string) {
  const index = searchIndex.findIndex((i) => i.id === itemId)
  if (index !== -1) {
    searchIndex.splice(index, 1)
  }
}

/**
 * Updates the search index for a batch of items in one pass.
 * @param items The array of LibraryItem objects to update.
 */
export function updateIndexForItems(items: LibraryItem[]) {
  const itemsToUpdate = new Map<string, LibraryItem>()
  const itemsToRemove = new Set<string>()

  // First, determine which items to update and which to remove
  for (const item of items) {
    itemMap.set(item.id, item) // Always keep the item map up-to-date

    if (
      (item.type === 'folder' && EXCLUDED_FOLDER_NAMES.includes(item.name.toLowerCase())) ||
      item.isHidden
    ) {
      itemsToRemove.add(item.id)
      if (item.type === 'folder' && item.children) {
        function collectChildrenIds(folder: MediaFolder) {
          folder.children.forEach((child) => {
            itemsToRemove.add(child.id)
            if (child.type === 'folder') collectChildrenIds(child)
          })
        }
        collectChildrenIds(item)
      }
    } else {
      itemsToUpdate.set(item.id, item)
    }
  }

  if (itemsToRemove.size === 0 && itemsToUpdate.size === 0) return

  const newSearchIndex: SearchIndexEntry[] = []
  const updatedIds = new Set<string>()

  // Rebuild the index by iterating through the old one
  for (const entry of searchIndex) {
    if (itemsToRemove.has(entry.id)) {
      continue // Skip removed items
    }
    if (itemsToUpdate.has(entry.id)) {
      const item = itemsToUpdate.get(entry.id)!
      const parentId = parentMap.get(item.id)
      const parent = parentId ? itemMap.get(parentId) : undefined
      newSearchIndex.push(createSearchIndexEntry(item, parent))
      updatedIds.add(entry.id)
    } else {
      newSearchIndex.push(entry) // Keep existing item
    }
  }

  // Add any new items that weren't in the original index
  for (const [id, item] of itemsToUpdate.entries()) {
    if (!updatedIds.has(id)) {
      const parentId = parentMap.get(item.id)
      const parent = parentId ? itemMap.get(parentId) : undefined
      newSearchIndex.push(createSearchIndexEntry(item, parent))
    }
  }

  searchIndex = newSearchIndex
  console.log(
    `[Search Index] Batched update complete. Updated: ${itemsToUpdate.size}, Removed: ${itemsToRemove.size}`
  )
}

/**
 * Evaluates a single item and decides whether to add, update, or remove it
 * and its children from the search index.
 * @param item The LibraryItem to process.
 */
export function updateIndexForItem(item: LibraryItem) {
  // Always keep the item map up-to-date with the latest version of the item.
  itemMap.set(item.id, item)

  // --- Exclusion Rules ---
  if (
    (item.type === 'folder' && EXCLUDED_FOLDER_NAMES.includes(item.name.toLowerCase())) ||
    item.isHidden
    // Note: Missing items are deliberately not excluded
  ) {
    removeItemFromIndex(item.id)
    // Also remove all its descendants from the index.
    function removeChildren(folder: MediaFolder) {
      folder.children.forEach((child) => {
        removeItemFromIndex(child.id)
        if (child.type === 'folder') {
          removeChildren(child)
        }
      })
    }
    if (item.type === 'folder' && item.children) removeChildren(item)
    return
  }

  // Find parent to calculate score correctly.
  const parentId = parentMap.get(item.id)
  const parent = parentId ? itemMap.get(parentId) : undefined

  const entry = createSearchIndexEntry(item, parent)

  console.log(`[Search Index] Incrementally updating index for: "${entry.title}" (ID: ${entry.id})`)
  _updateOrAddItemToIndex(entry)
}

/**
 * This is the generic handler called by the proxy on any data change.
 * @param target The raw object that was modified.
 * @param prop The property key that was changed.
 * @param isBulkUpdate A flag to disable indexing during bulk operations.
 */
function onObjectChange(target: object, prop: string | symbol, isBulkUpdate: boolean) {
  if (isBulkUpdate) {
    return
  }

  // We only care about changes on LibraryItems.
  if (
    !Object.prototype.hasOwnProperty.call(target, 'id') ||
    !Object.prototype.hasOwnProperty.call(target, 'type')
  ) {
    return
  }

  const item = target as LibraryItem

  // --- Broadcast the change via the service event emitter ---
  // This ensures any change to an item in the main process
  // is immediately reflected in the UI, via the transport layer.
  const plainItem = JSON.parse(JSON.stringify(item))
  serviceEventEmitter.emit('library-item-updated', plainItem)

  // Update the item itself in the search index.
  updateIndexForItem(item)

  // If a folder's poster path changes, its children's scores might be affected.
  // We need to trigger an update for them too.
  if (item.type === 'folder' && prop === 'posterPath' && item.children) {
    item.children.forEach((child) => {
      updateIndexForItem(child)
    })
  }
}

// A WeakMap caches proxies for any object, preventing re-proxying and handling
// garbage collection of old DBs gracefully.
const proxyCache = new WeakMap()

/**
 * Creates a handler for the recursive proxy.
 * @param isBulkUpdate A function that returns the current bulk update status.
 */
function createProxyHandler(isBulkUpdate: () => boolean): ProxyHandler<any> {
  // This handler is created once per DB proxy session and is reused for all
  // nested objects, which is crucial for performance.
  const handler: ProxyHandler<any> = {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)

      // During bulk updates, we want raw performance and don't need change tracking.
      // By returning the raw value, we prevent the creation of nested proxies,
      // which dramatically speeds up full-tree traversals.
      if (isBulkUpdate()) {
        return value
      }

      // If the retrieved value is an object (and not null), wrap it in a proxy.
      if (value && typeof value === 'object') {
        // Return a cached proxy if one exists for this object.
        if (proxyCache.has(value)) {
          return proxyCache.get(value)
        }
        // Otherwise, create a new proxy with the *same* handler, cache it, and return it.
        const newProxy = new Proxy(value, handler)
        proxyCache.set(value, newProxy)
        return newProxy
      }
      return value
    },
    set(target, prop, value, receiver) {
      const oldValue = Reflect.get(target, prop, receiver)
      const success = Reflect.set(target, prop, value, receiver)

      // Only trigger the change handler if the new value is different from the old one.
      if (success && value !== oldValue) {
        onObjectChange(target, prop, isBulkUpdate())
      }

      return success
    }
  }
  return handler
}

/**
 * Wraps the raw database object in a recursive Proxy.
 * @param db The raw database object.
 * @param isBulkUpdate A function that returns the current bulk update status.
 * @returns A new Proxy that wraps the database.
 */
export function createDbProxy(db: Database, isBulkUpdate: () => boolean): Database {
  // The WeakMap is not cleared here. When a new DB is loaded, the old `db` object
  // becomes garbage-collectible. The WeakMap will automatically drop the entries
  // for the old `db` and all its children, preventing memory leaks.
  if (proxyCache.has(db)) {
    return proxyCache.get(db)
  }

  // Create the single, reusable handler for this proxy session.
  const handler = createProxyHandler(isBulkUpdate)
  const proxy = new Proxy(db, handler)

  // Cache the root proxy.
  proxyCache.set(db, proxy)

  return proxy
}

/**
 * Builds the entire search index from the library root.
 * This is called once when the library is first loaded or fully replaced.
 * It populates the search index and the necessary lookup maps.
 */
export function buildFullSearchIndex(root: MediaFolder | null) {
  const startTime = performance.now()
  searchIndex = []
  itemMap.clear()
  parentMap.clear()
  console.log(
    `[${new Date().toISOString()}] [Search] Index build initiated. Cleared searchIndex (now ${searchIndex.length}), itemMap (now ${itemMap.size}).`
  )
  if (!root) {
    return
  }

  function traverse(item: LibraryItem, parent?: MediaFolder) {
    // Exclusion rule
    if (
      (item.type === 'folder' && EXCLUDED_FOLDER_NAMES.includes(item.name.toLowerCase())) ||
      item.isHidden
      // Note: Missing items are deliberately not excluded
    ) {
      return // Don't index this folder or its children
    }

    // Populate maps
    itemMap.set(item.id, item)
    if (parent) {
      parentMap.set(item.id, parent.id)
    }

    // Create and add entry to search index
    const entry = createSearchIndexEntry(item, parent)
    searchIndex.push(entry)

    // Recurse if it's a folder
    if (item.type === 'folder' && item.children) {
      item.children.forEach((child) => traverse(child, item))
    }
  }

  traverse(root)
  const endTime = performance.now()
  const duration = (endTime - startTime).toFixed(2)
  console.log(
    `[${new Date().toISOString()}] [Search] Index built with ${searchIndex.length} items in ${duration}ms.`
  )
}

/**
 * Recursively removes an item and all its descendants from the in-memory lookup maps and search index.
 * @param item The root item to remove.
 */
export function removeItemAndDescendantsFromIndex(item: LibraryItem) {
  function unindexRecursively(currentItem: LibraryItem) {
    itemMap.delete(currentItem.id)
    parentMap.delete(currentItem.id)
    removeItemFromIndex(currentItem.id)
    if (currentItem.type === 'folder' && currentItem.children) {
      currentItem.children.forEach(unindexRecursively)
    }
  }
  unindexRecursively(item)
}

function normalizeText(text: string): string {
  // A simpler normalization for backend search, as tag syntax is already parsed out.
  return text
    .toLowerCase()
    .replace(/[.:_,-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getRankedResults(query: {
  text: string
  tags: { key: string; value: string }[]
}): { item: SearchIndexEntry; finalScore: number; dynamicScore: number }[] {
  const hasText = query.text.trim() !== ''
  const hasTags = query.tags.length > 0

  if (!hasText && !hasTags) {
    return []
  }

  // 1. Filter by tags using the shared utility
  const tagFilteredItems = hasTags
    ? searchIndex.filter((item) => itemMatchesAllTags(item, query))
    : searchIndex

  // 2. If no text, sort by static score and return
  if (!hasText) {
    return tagFilteredItems
      .sort((a, b) => b.staticScore - a.staticScore)
      .map((item) => ({ item, finalScore: item.staticScore, dynamicScore: 0 }))
  }

  // 3. Use Fuse.js for fuzzy search
  const fuse = new Fuse(tagFilteredItems, {
    keys: ['title'],
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true
  })
  const fuseResults = fuse.search(normalizeText(query.text))

  // 4. Combine scores
  const rankedResults = fuseResults.map((result) => {
    const matchScore = 1 - (result.score ?? 1)
    const dynamicScore = matchScore * 50
    const finalScore = result.item.staticScore + dynamicScore
    return { item: result.item, finalScore, dynamicScore }
  })

  // 5. Sort by final score
  return rankedResults.sort((a, b) => b.finalScore - a.finalScore)
}

/**
 * Performs a search and returns a ranked list of items for the UI.
 * This is the lean, production-ready version.
 */
export function performSearch(query: {
  text: string
  tags: { key: string; value: string }[]
}): SearchIndexEntry[] {
  const ranked = getRankedResults(query)
  return ranked.map((r) => r.item).slice(0, SEARCH_RESULT_LIMIT)
}

/**
 * Performs a search and returns detailed data for debugging purposes.
 */
export function debugPerformSearch(query: {
  text: string
  tags: { key: string; value: string }[]
}): any {
  const ranked = getRankedResults(query)

  // We use `reduce` to transform the array of results into an object.
  // When console.table receives an object, it uses the object's keys
  // as the index column, effectively replacing the default '0, 1, 2...' index.
  const resultsAsObject = ranked
    .slice(0, SEARCH_RESULT_LIMIT)
    .reduce((acc: Record<string, unknown>, r) => {
      // The key for our object is the final score.
      const key = r.finalScore.toFixed(2)
      // The value is the row data. We exclude noisy fields for a cleaner table.
      const { id, posterPath, staticScore, ...restOfItem } = r.item
      acc[key] = {
        ...restOfItem,
        breakdown: `${staticScore} + ${r.dynamicScore.toFixed(2)}`,
        id // Keep id for reference
      }
      return acc
    }, {})

  return resultsAsObject
}
