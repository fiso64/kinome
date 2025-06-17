import type { LibraryItem, SearchIndexEntry } from './types'

type DisplayableItem = LibraryItem | SearchIndexEntry
type Query = { text: string; tags: { key: string; value: string }[] }

function normalizeTextForTagMatching(text: string): string {
  // A simpler normalization for backend search, as tag syntax is already parsed out.
  return text
    .toLowerCase()
    .replace(/[.:_,-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Checks if a single item matches the tag part of a search query.
 * @param item The item to check.
 * @param tags The array of key/value tags from the query.
 * @returns `true` if the item matches all tags, `false` otherwise.
 */
function itemMatchesTags(item: DisplayableItem, tags: { key: string; value: string }[]): boolean {
  for (const tag of tags) {
    let tagMatch = false
    const tagValue = tag.value.toLowerCase()

    switch (tag.key) {
      case 'mediaType':
        tagMatch = item.mediaType?.toLowerCase() === tagValue
        break
      case 'genre':
        tagMatch = item.genres?.some((g) => g.toLowerCase() === tagValue) ?? false
        break
      case 'year':
        tagMatch = item.year?.toString() === tag.value
        break
      default:
        // Check virtual tags first
        if (item.virtualTags && Object.prototype.hasOwnProperty.call(item.virtualTags, tag.key)) {
          tagMatch = item.virtualTags[tag.key]?.toLowerCase() === tagValue
        }
        // Then check custom tags
        else if (item.tags) {
          const itemTagValue = item.tags[tag.key]
          if (typeof itemTagValue === 'string') {
            tagMatch = itemTagValue.split(',').some((v) => v.trim().toLowerCase() === tagValue)
          }
        }
    }
    if (!tagMatch) return false
  }
  return true
}

/**
 * Checks if a single item matches the text part of a search query.
 * This is a simple `includes` check for the local filter.
 * @param item The item to check.
 * @param text The normalized text from the query.
 * @returns `true` if the item's title includes the text, `false` otherwise.
 */
function itemMatchesText(item: DisplayableItem, text: string): boolean {
  if (!text) return true
  const itemTitle = item.title ?? ('name' in item ? (item as LibraryItem).name : '')
  return normalizeTextForTagMatching(itemTitle).includes(text)
}

/**
 * Filters an array of items based on a local filter query (text and tags).
 * This is intended for the renderer's local filter bar to avoid IPC.
 * @param items The array of items to filter.
 * @param query The search query object.
 * @returns A new array containing only the items that match the query.
 */
export function filterItems<T extends DisplayableItem>(items: T[], query: Query): T[] {
  if (!query || (query.text === '' && query.tags.length === 0)) {
    return items
  }
  const normalizedQueryText = normalizeTextForTagMatching(query.text)
  return items.filter((item) => {
    return itemMatchesText(item, normalizedQueryText) && itemMatchesTags(item, query.tags)
  })
}

/**
 * Checks if an item matches the tag portion of a query.
 * This is intended for the main process search, which uses Fuse.js for text matching separately.
 * @param item The item to check.
 * @param query The search query object.
 * @returns `true` if the item matches all tags, `false` otherwise.
 */
export function itemMatchesAllTags(item: DisplayableItem, query: Query): boolean {
  if (query.tags.length === 0) {
    return true
  }
  return itemMatchesTags(item, query.tags)
}
