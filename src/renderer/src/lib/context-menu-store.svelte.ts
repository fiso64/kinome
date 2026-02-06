import type { LibraryItem, SearchIndexEntry } from '@shared/types'
import { api } from './api'

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
let position = $state<ContextMenuPosition>({ top: 0, left: 0 })
let layout = $state<string | undefined>(undefined)
let isVisible = $state(false)
let lastClick = { x: 0, y: 0, time: 0 }

// --- Methods ---

async function open(
  target: LibraryItem | SearchIndexEntry,
  event: MouseEvent,
  options?: ContextMenuOptions
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
    const fullItem = await api.getItem(target.id)
    if (fullItem) {
      item = fullItem
    } else {
      return
    }
  } else {
    item = target
  }

  layout = options?.layout
  position = { top: event.clientY, left: event.clientX }
  isVisible = true
}

function close() {
  item = null
  isVisible = false
}

// --- Exported Store Object ---

export const contextMenuStore = {
  get item() {
    return item
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
  close
}
