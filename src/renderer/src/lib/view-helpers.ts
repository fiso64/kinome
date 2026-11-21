import { prefersReducedMotion } from 'svelte/motion'
import type { LibraryItem, SearchIndexEntry, MediaFolder } from '@shared/types'

type DisplayableItem = LibraryItem | SearchIndexEntry
type ParentItem = MediaFolder | (MediaFolder & { isVirtual?: boolean })

const byteUnits = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']

export function formatClockTime(seconds: number, guide = seconds): string {
  const time = Math.floor(Math.max(0, seconds))
  const hours = Math.floor(time / 3600)
  const minutes = Math.floor(time / 60) % 60
  const minutesText = String(minutes).padStart(guide >= 600 ? 2 : 1, '0')
  const secondsText = String(time % 60).padStart(2, '0')
  return guide >= 3600 ? `${hours}:${minutesText}:${secondsText}` : `${minutesText}:${secondsText}`
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (!bytes) return '0 Bytes'
  const unit = Math.min(Math.floor(Math.log2(bytes) / 10), byteUnits.length - 1)
  return `${Number((bytes / 1024 ** unit).toFixed(decimals))} ${byteUnits[unit]}`
}

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

export function resultButton(root: HTMLElement, id: string) {
  return root.querySelector<HTMLButtonElement>(`[data-media-item-id="${CSS.escape(id)}"] > button`)
}

export function highlightSearchResult(root: HTMLElement, id?: string) {
  let highlighted = id ? resultButton(root, id) : null
  highlighted?.setAttribute('data-search-highlighted', '')
  return {
    update(id?: string) {
      const next = id ? resultButton(root, id) : null
      if (next === highlighted) return
      highlighted?.removeAttribute('data-search-highlighted')
      highlighted = next
      highlighted?.setAttribute('data-search-highlighted', '')
      highlighted?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion.current ? 'instant' : 'smooth' })
    },
    destroy() {
      highlighted?.removeAttribute('data-search-highlighted')
    }
  }
}
