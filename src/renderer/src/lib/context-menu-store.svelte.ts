import type { LibraryItem, SearchIndexEntry } from '@shared/types'
import { api } from './api'
import { notificationStore } from './notification-store.svelte'

// --- Types ---

export interface ContextMenuPosition {
  top: number
  left: number
}

export interface ContextMenuOptions {
  layout?: string
}

// --- State ---

let item = $state<LibraryItem | null>(null)
let parentItem = $state<LibraryItem | null>(null)
let position = $state<ContextMenuPosition>({ top: 0, left: 0 })
let layout = $state<string | undefined>(undefined)
let isVisible = $state(false)
let lastClick = { x: 0, y: 0, time: 0 }

// --- Methods ---

async function open(
  target: LibraryItem | SearchIndexEntry,
  event: MouseEvent,
  options?: ContextMenuOptions & { parentItem?: LibraryItem }
) {
  const dx = Math.abs(event.clientX - lastClick.x)
  const dy = Math.abs(event.clientY - lastClick.y)
  const dt = event.timeStamp - lastClick.time

  if (dx < 10 && dy < 10 && dt < 2000) {
    if (isVisible) {
      close()
    }
    return // Allow native browser menu
  }

  event.preventDefault()
  event.stopPropagation()

  lastClick = { x: event.clientX, y: event.clientY, time: event.timeStamp }

  if ('staticScore' in target) {
    // It's a search result, needs full item loading
    let fullItem: LibraryItem | null
    try {
      fullItem = await api.getItem(target.id)
    } catch (err: any) {
      notificationStore.add(err.message || 'Failed to load item.', 'error')
      return
    }
    if (fullItem) {
      item = fullItem
    } else {
      return
    }
  } else {
    item = target
  }

  layout = options?.layout
  parentItem = options?.parentItem || null
  position = { top: event.clientY, left: event.clientX }
  isVisible = true
}

/**
 * Always shows the context menu for a folder background right-click.
 * Unlike `open()`, this bypasses the duplicate-click guard so that
 * right-clicking on empty space in a folder always shows the app menu
 * instead of the browser's native context menu.
 */
function openForBackground(
  target: LibraryItem,
  event: MouseEvent,
  options?: ContextMenuOptions & { parentItem?: LibraryItem }
) {
  event.preventDefault()
  event.stopPropagation()

  lastClick = { x: event.clientX, y: event.clientY, time: event.timeStamp }

  item = target
  layout = options?.layout
  parentItem = options?.parentItem || null
  position = { top: event.clientY, left: event.clientX }
  isVisible = true
}

function close() {
  item = null
  parentItem = null
  isVisible = false
}

// --- Exported Store Object ---

export const contextMenuStore = {
  get item() {
    return item
  },
  get parentItem() {
    return parentItem
  },
  get position() {
    return position
  },
  get layout() {
    return layout
  },
  get isVisible() {
    return isVisible
  },
  get lastClick() {
    return lastClick
  },
  open,
  openForBackground,
  close
}
