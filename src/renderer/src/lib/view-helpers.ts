import type { LibraryItem, SearchIndexEntry, MediaFolder } from '@shared/types'

type DisplayableItem = LibraryItem | SearchIndexEntry
type ParentItem = MediaFolder | (MediaFolder & { isVirtual?: boolean })

/**
 * Determines if a given item should be visually greyed out as "watched".
 * @param item The item to check.
 * @param parentItem The parent of the item being checked.
 * @param grayOutWatched A global setting to enable/disable this feature.
 * @returns `true` if the item should be greyed out, `false` otherwise.
 */
export function shouldBeGreyedOut(
  item: DisplayableItem,
  parentItem: ParentItem | undefined,
  grayOutWatched: boolean
): boolean {
  // The `watched` property might be on LibraryItem (file) or SearchIndexEntry
  const isWatched = 'watched' in item && item.watched

  if (!grayOutWatched || !isWatched) {
    return false
  }

  // Condition 1: item itself is a movie. Do not grey out.
  if (item.mediaType === 'movie') {
    return false
  }

  // Condition 2: parent is a movie and item is not an episode (e.g., an extra file). Do not grey out.
  if (parentItem?.mediaType === 'movie' && item.mediaType !== 'episode') {
    return false
  }

  // If none of the exceptions apply, grey it out.
  return true
}

/**
 * Checks if a search input string contains an incomplete tag,
 * which is useful for preventing searches from firing prematurely.
 * @param text The text from the search input.
 * @returns `true` if the user is likely in the middle of typing a tag.
 */
export function isTypingTag(text: string): boolean {
  if (!text) return false
  // These regexes check if the user is in the middle of typing a tag.
  // e.g., ">key" or ">key:value"
  return />([a-zA-Z0-9_.-]*)$/.test(text) || />([a-zA-Z0-9_.-]+):([^:]*)$/.test(text)
}
