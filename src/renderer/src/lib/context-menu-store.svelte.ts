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
  showLogout?: boolean
  /** Only the app section: Settings has no library item to act on. */
  appOnly?: boolean
}

// --- State ---

let item = $state<LibraryItem | null>(null)
let matchingFiles = $state<SearchIndexEntry['matchingFiles']>()
let parentItem = $state<LibraryItem | null>(null)
let position = $state<ContextMenuPosition>({ top: 0, left: 0 })
let layout = $state<string | undefined>(undefined)
let showLogout = $state(false)
let appOnly = $state(false)
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

  // A second right-click on the same spot shows the browser's menu. Touch screens have no use for it.
  if (dx < 10 && dy < 10 && dt < 2000 && matchMedia('(hover: hover)').matches) {
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

  matchingFiles = 'matchingFiles' in target ? target.matchingFiles?.filter(({ id }) => id !== target.id) : undefined
  layout = options?.layout
  appOnly = options?.appOnly ?? false
  showLogout = (options?.showLogout ?? false) || appOnly
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
  matchingFiles = undefined
  layout = options?.layout
  parentItem = options?.parentItem || null
  position = { top: event.clientY, left: event.clientX }
  isVisible = true
}

function close() {
  item = null
  matchingFiles = undefined
  parentItem = null
  showLogout = false
  appOnly = false
  isVisible = false
}

/**
 * iOS never fires contextmenu, so a long press there would not open item menus.
 * This turns a still, half-second touch into a contextmenu event on the touched element.
 */
export function enableLongPressMenus(): () => void {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  if (!ios) return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let start = { x: 0, y: 0 }
  let pressed = false
  let suppressClickUntil = 0
  const cancel = () => clearTimeout(timer)
  const begin = (event: TouchEvent) => {
    cancel()
    pressed = false
    if (event.touches.length !== 1) return
    const { clientX, clientY } = event.touches[0]
    start = { x: clientX, y: clientY }
    const target = event.target as Element
    timer = setTimeout(() => {
      pressed = !target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }))
    }, 500)
  }
  const move = (event: TouchEvent) => {
    const touch = event.touches[0]
    if (touch && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) cancel()
  }
  const end = () => {
    cancel()
    // The click that ends a long press must not also open the item.
    if (pressed) suppressClickUntil = performance.now() + 400
    pressed = false
  }
  const click = (event: MouseEvent) => {
    if (performance.now() > suppressClickUntil) return
    event.preventDefault()
    event.stopPropagation()
  }
  const options = { capture: true, passive: true }
  window.addEventListener('touchstart', begin, options)
  window.addEventListener('touchmove', move, options)
  window.addEventListener('touchend', end, options)
  window.addEventListener('touchcancel', end, options)
  window.addEventListener('click', click, { capture: true })
  return () => {
    cancel()
    window.removeEventListener('touchstart', begin, options)
    window.removeEventListener('touchmove', move, options)
    window.removeEventListener('touchend', end, options)
    window.removeEventListener('touchcancel', end, options)
    window.removeEventListener('click', click, { capture: true })
  }
}

// --- Exported Store Object ---

export const contextMenuStore = {
  get item() {
    return item
  },
  get matchingFiles() {
    return matchingFiles
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
  get showLogout() {
    return showLogout
  },
  get appOnly() {
    return appOnly
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
