import { writable } from 'svelte/store'

/**
 * A store to hold the last active tab ID for any item that uses a tabbed view.
 * The key is the ID of the parent item (the one whose children are the tabs).
 * The value is the ID of the child item that was the active tab.
 */
export const activeTabState = writable<Map<string, string>>(new Map())