import type { LibraryItem, SearchIndexEntry } from '../../../shared/types'
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

// --- Methods ---

async function open(
    target: LibraryItem | SearchIndexEntry,
    event: MouseEvent,
    options?: ContextMenuOptions
) {
    event.preventDefault()
    event.stopPropagation()

    if ('staticScore' in target) {
        // It's a search result, needs full item loading
        const fullItem = await api.getItemV2(target.id)
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
    open,
    close
}
