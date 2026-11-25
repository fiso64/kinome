import { authStore } from './auth-store.svelte'
import type { SortPlacement } from '@shared/sort-placement'
import type { Capability, LibraryItem, MediaFolder, StoredViewSettings, LibraryFilter, ViewLayout } from '@shared/types'

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
  | { type: 'shortcuts'; props: Record<string, never> }
  | { type: 'rename'; props: { item: LibraryItem } }
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
        editCapability: 'editSettings' | 'editMetadata'
        onDone: (settings: StoredViewSettings) => void
        availableLayouts?: ViewLayout[]
        showClickAction?: boolean
        settings: any
        groupByKeys: string[]
      }
    }
  | { type: 'sortPinning'; props: { item: MediaFolder; placement?: SortPlacement; onDone: (placement: Required<SortPlacement>) => void } }

export type ModalType = ModalConfig['type']

const REQUIRED_CAPABILITY: Record<ModalType, Capability | null> = {
  settings: null,
  itemSettings: 'editMetadata',
  manualSearch: 'editMetadata',
  properties: null,
  shortcuts: null,
  rename: 'editMetadata',
  assignSeasons: 'editMetadata',
  createVirtualFolder: 'editMetadata',
  viewSettings: null, // Inherits the capability of the parent draft.
  sortPinning: 'editMetadata'
}

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
  const modal = { type, props } as ModalConfig
  if (canOpen(modal)) modalStack.push(modal)
}

function canOpen(modal: ModalConfig): boolean {
  if (modal.type === 'itemSettings' && modal.props.initialTab === 'metadata') return true
  const capability = modal.type === 'viewSettings' ? modal.props.editCapability : REQUIRED_CAPABILITY[modal.type]
  return !capability || authStore.can[capability]
}

function closeUnauthorized() {
  const index = modalStack.findIndex((entry) => !canOpen(entry))
  if (index !== -1) modalStack.splice(index)
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
  closeUnauthorized,
  close
}
