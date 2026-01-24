import Fuse from 'fuse.js'

import type { LibraryItem, SearchIndexEntry } from '../../shared/types'
import { SEARCH_INDEX_PROPERTIES } from '../../shared/types'
import { itemMatchesAllTags } from '../../shared/filter'

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
        ; (entry as any)[key] = structuredClone(value)
      } else {
        ; (entry as any)[key] = value
      }
    }
  }

  // Handle special cases and computed properties.
  entry.title = item.title ?? item.name

  // Extract person names from credits
  if ('tmdbCredits' in item && item.tmdbCredits) {
    const personNames = new Set<string>()
      ; (item.tmdbCredits.cast ?? []).forEach((p) => p.name && personNames.add(p.name))
      ; (item.tmdbCredits.crew ?? []).forEach((p) => p.name && personNames.add(p.name))
    if (personNames.size > 0) {
      entry.persons = Array.from(personNames)
    }
  }

  entry.staticScore = calculateStaticScore(item, parent)

  return entry as SearchIndexEntry
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
/**
 * Checks if an item is a descendant of any folder in the exclusion list.
 * Travels up the parentMap to find if any ancestor is excluded.
 */
function isDescendantOfExcluded(itemId: string): boolean {
  let currentId = itemId
  while (true) {
    const item = itemMap.get(currentId)
    if (!item) break // Should not happen if map is consistent, or we reached root

    if (item.type === 'folder' && EXCLUDED_FOLDER_NAMES.includes(item.name.toLowerCase())) {
      return true
    }

    const parentId = parentMap.get(currentId)
    if (!parentId) break // Root reached
    currentId = parentId
  }
  return false
}

/**
 * Updates the search index for a batch of items in one pass.
 * @param items The array of LibraryItem objects to update.
 */
export function updateIndexForItems(items: LibraryItem[]) {
  const itemsToUpdate = new Map<string, LibraryItem>()
  const itemsToRemove = new Set<string>()

  // 1. Update Maps first
  for (const item of items) {
    itemMap.set(item.id, item)
    if (item.parentId) {
      parentMap.set(item.id, item.parentId)
    }
  }

  // 2. Determine status
  for (const item of items) {
    if (item.isHidden || isDescendantOfExcluded(item.id)) {
      itemsToRemove.add(item.id)
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

// Proxy-based change detection has been removed.
// The library.service is now responsible for explicitly triggering index updates
// and notifying the renderer.

/**
 * Builds the entire search index from a flat list of all library items.
 * This replaces the recursive traversal which required a loaded tree.
 */
export function buildFullSearchIndex(allItems: LibraryItem[]) {
  const startTime = performance.now()
  searchIndex = []
  itemMap.clear()
  parentMap.clear()
  console.log(
    `[${new Date().toISOString()}] [Search] Index build initiated for ${allItems.length} items.`
  )

  // 1. Populate Item Map and Parent Map
  // We rely on `parentId` which is now populated from SQLite.
  for (const item of allItems) {
    itemMap.set(item.id, item)
    if (item.parentId) {
      parentMap.set(item.id, item.parentId)
    }
  }

  // 2. Build Index with proper scoring and exclusion
  for (const item of allItems) {
    if (item.isHidden) continue

    // Check ancestry for exclusion (e.g. content inside 'extras')
    if (isDescendantOfExcluded(item.id)) {
      continue
    }

    const parentId = parentMap.get(item.id)
    const parent = parentId ? itemMap.get(parentId) : undefined
    const entry = createSearchIndexEntry(item, parent)
    searchIndex.push(entry)
  }

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
