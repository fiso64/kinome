import { writable } from 'svelte/store'

/**
 * A store to hold the last active tab ID for any item that uses a tabbed view.
 * The key is the ID of the parent item (the one whose children are the tabs).
 * The value is the ID of the child item that was the active tab.
 */
export const activeTabState = writable<Map<string, string>>(new Map())

/**
 * A temporary store to signal an intentional navigation to a specific tab.
 * This is set before navigating, read by the target view, and then cleared.
 * This is used, for example, to force a specific season tab to open when a
 * "Continue Watching" item is clicked.
 */
interface TabNavigationIntent {
  targetShowId: string
  targetSeasonNumber: number
}

export const tabNavigationIntent = writable<TabNavigationIntent | null>(null)
