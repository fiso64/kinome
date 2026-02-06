import type { LibraryItem, MediaFolder } from '@shared/types'

// --- Types ---

export type ModalConfig =
  | { type: 'settings'; props?: Record<string, never> }
  | {
      type: 'itemSettings'
      props: {
        item: LibraryItem
        initialTab: 'metadata' | 'view' | 'folder' | 'settings'
        defaultLayout: 'grid' | 'horizontal-grid' | 'list' | 'tree' | 'tabs' | 'sections'
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

export type ModalType = ModalConfig['type']

// --- State ---

let activeModal = $state<ModalConfig | null>(null)

// --- Methods ---

function open<T extends ModalType>(
  type: T,
  props: T extends 'settings' ? never : Extract<ModalConfig, { type: T }>['props']
): void
function open(type: 'settings'): void
function open(type: ModalType, props?: object) {
  activeModal = { type, props } as ModalConfig
}

function close() {
  activeModal = null
}

// --- Exported Store Object ---

export const modalStore = {
  get activeModal() {
    return activeModal
  },
  open,
  close
}
