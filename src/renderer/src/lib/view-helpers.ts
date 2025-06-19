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