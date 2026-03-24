import type { LibraryItem, MediaFolder, StoredViewSettings, LibraryFilter, ViewLayout } from '@shared/types'

// --- Types ---

export type ModalConfig =
  | { type: 'settings'; props?: Record<string, never> }
  | {
      type: 'itemSettings'
      props: {
        item: LibraryItem
        initialTab: 'metadata' | 'view' | 'folder' | 'virtualFolder' | 'settings'
        defaultLayout: ViewLayout
        overrideParent?: LibraryItem
      }
    }
  | {
      type: 'manualSearch'
      props: {
        item: LibraryItem
        initialTab?: 'match' | 'artwork'
      }
    }
  | { type: 'properties'; props: { item: LibraryItem } }
  | { type: 'rename'; props: { item: LibraryItem } }
  | { type: 'initialFolderSettings'; props: { root: MediaFolder } }
  | { type: 'assignSeasons'; props: { item: MediaFolder } }
  | {
      type: 'createVirtualFolder'
      props: {
        parentItem: LibraryItem
        onCreated: (newId: string) => void
      }
    }
  | {
      type: 'viewSettings'
      props: {
        title: string
        initialSettings: StoredViewSettings
        typeKey: '_default' | 'movie' | 'tv' | 'season'
        onSave: (settings: StoredViewSettings) => void
        availableLayouts?: ViewLayout[]
        showClickAction?: boolean
        settings: any
        groupByKeys: string[]
      }
    }
  | { type: 'sortPinning'; props: { item: MediaFolder; initialSortTop?: string[]; initialSortBottom?: string[]; onSaved?: (sortTop: string[], sortBottom: string[]) => void } }

export type ModalType = ModalConfig['type']

// --- State ---

let modalStack = $state<ModalConfig[]>([])
let pendingCount = $state(0)

// --- Methods ---

function open<T extends ModalType>(
  type: T,
  props: T extends 'settings' ? never : Extract<ModalConfig, { type: T }>['props']
): void
function open(type: 'settings'): void
function open(type: ModalType, props?: any) {
  modalStack.push({ type, props } as ModalConfig)
}

function close() {
  modalStack.pop()
}

/**
 * Wraps an async action with a pending indicator. Counter-based so concurrent
 * calls are safe — the indicator stays visible until all of them resolve.
 */
export async function withPending<T>(fn: () => Promise<T>): Promise<T> {
  pendingCount++
  try {
    return await fn()
  } finally {
    pendingCount--
  }
}

// --- Exported Store Object ---

export const modalStore = {
  get activeModal() {
    return modalStack.length > 0 ? modalStack[modalStack.length - 1] : null
  },
  get stack() {
    return modalStack
  },
  get isPending() {
    return pendingCount > 0
  },
  open,
  close
}
