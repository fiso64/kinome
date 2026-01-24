import { getLoadedItem } from './item-store'
import { findPathToItem } from './tree-helpers'
import { api } from './api'
import { modalStore } from './modal-store.svelte'
import { resolveViewSettings } from '../../../shared/settings-helpers'
import type { LibraryItem, MediaFolder, SearchIndexEntry } from '../../../shared/types'

// --- Types ---

export type ViewStackItem = MediaFolder

interface HistoryState {
  stackIds: string[]
  detailId: string | null
  modal?: { type: 'settings' } | { type: 'itemSettings'; itemId: string }
}

// --- State (using Svelte Runes) ---

let viewStack = $state<ViewStackItem[]>([])
let selectedItemForDetailView = $state<LibraryItem | null>(null)
// We track if a modal is open via history to conditionally render the "Back" button or handle "Close"
let isHistoryModalOpen = $state(false)

// --- Derived State ---

const currentFolder = $derived(viewStack.length > 0 ? viewStack[viewStack.length - 1] : null)
const isDetailViewActive = $derived(selectedItemForDetailView !== null)
// Show back button if we are not at root state OR if a history-managed modal is open
const canGoBack = $derived(isDetailViewActive || viewStack.length > 1 || isHistoryModalOpen)

// --- History Helpers ---

function getUrlParams(
  stack: ViewStackItem[],
  detail: LibraryItem | null,
  modal?: HistoryState['modal']
): string {
  const params = new URLSearchParams()
  if (detail) {
    params.set('item', detail.id)
  } else if (stack.length > 0) {
    const current = stack[stack.length - 1]
    if (current.path !== '.') {
      params.set('folder', current.id)
    }
  }

  if (modal) {
    params.set('modal', modal.type)
    if (modal.type === 'itemSettings' && modal.itemId) {
      params.set('modalItemId', modal.itemId)
    }
  }

  const str = params.toString()
  return str ? `?${str}` : '/'
}

function getSnapshot(modal?: HistoryState['modal']): HistoryState {
  return {
    stackIds: viewStack.map((f) => f.id),
    detailId: selectedItemForDetailView?.id ?? null,
    modal
  }
}

function pushHistoryState(modal?: HistoryState['modal']) {
  const state = getSnapshot(modal)
  const url = getUrlParams(viewStack, selectedItemForDetailView, modal)
  history.pushState(state, '', url)
  isHistoryModalOpen = !!modal
}

function replaceHistoryState(modal?: HistoryState['modal']) {
  const state = getSnapshot(modal)
  const url = getUrlParams(viewStack, selectedItemForDetailView, modal)
  history.replaceState(state, '', url)
  isHistoryModalOpen = !!modal
}

async function restoreFromState(state: HistoryState | null, rootFallback: MediaFolder) {
  if (state && state.stackIds && Array.isArray(state.stackIds) && state.stackIds.length > 0) {
    // Restore Stack
    const loadedItems = await Promise.all(state.stackIds.map((id) => getLoadedItem(id)))
    const validFolders = loadedItems.filter(
      (i): i is MediaFolder => !!i && i.type === 'folder'
    )

    if (validFolders.length > 0) {
      viewStack = validFolders
    } else {
      viewStack = [rootFallback]
    }

    // Restore Detail
    if (state.detailId) {
      const item = await getLoadedItem(state.detailId)
      selectedItemForDetailView = item
    } else {
      selectedItemForDetailView = null
    }

    // Restore Modal
    if (state.modal) {
      isHistoryModalOpen = true
      if (state.modal.type === 'settings') {
        modalStore.open('settings')
      } else if (state.modal.type === 'itemSettings' && state.modal.itemId) {
        const item = await getLoadedItem(state.modal.itemId)
        if (item) {
          // Resolve settings to pass default layout, required by ItemSettingsModal
          const settings = await api.getSettings()
          const resolved = resolveViewSettings(item as MediaFolder, settings).settings
          modalStore.open('itemSettings', {
            item,
            initialTab: 'metadata', // Default tab when restored
            defaultLayout: resolved.layout
          })
        }
      }
    } else {
      isHistoryModalOpen = false
      // Only close if active modal is one that we manage via history
      // This prevents closing a transient confirmation dialog if a background refresh triggers state restore (rare)
      // But typically popstate means user navigation.
      if (
        modalStore.activeModal?.type === 'settings' ||
        modalStore.activeModal?.type === 'itemSettings'
      ) {
        modalStore.close()
      }
    }
  } else {
    // No valid state, reset to root
    viewStack = [rootFallback]
    selectedItemForDetailView = null
    isHistoryModalOpen = false
    modalStore.close()
    replaceHistoryState()
  }
}

// --- Initialization ---

async function init(root: MediaFolder) {
  // 1. Setup popstate listener
  window.addEventListener('popstate', (event) => {
    restoreFromState(event.state as HistoryState, root)
  })

  // 2. Handle initial state (page load / refresh)
  // If we have history.state (from refresh), use it.
  // If not, but we have URL params (deep link), we might want to construct state (TODO).
  // For now, if history.state is populated (refresh), we use it.
  // If not, we default to root.
  // Note: Modern browsers restore history.state on refresh.
  await restoreFromState(history.state as HistoryState, root)
}

// --- Navigation Methods ---

function navigateToRoot(root: MediaFolder): void {
  viewStack = [root]
  selectedItemForDetailView = null
  pushHistoryState()
}

function pushFolder(folder: MediaFolder): void {
  selectedItemForDetailView = null
  viewStack.push(folder)
  pushHistoryState()
}

// Modal Navigation Methods
function openSettings() {
  modalStore.open('settings')
  pushHistoryState({ type: 'settings' })
}

async function openItemSettings(
  item: LibraryItem,
  initialTab: 'metadata' | 'view' | 'folder' | 'settings' = 'metadata'
) {
  // Resolve settings immediately for smooth UI
  const settings = await api.getSettings()
  const resolved = resolveViewSettings(item as MediaFolder, settings).settings

  modalStore.open('itemSettings', {
    item,
    initialTab,
    defaultLayout: resolved.layout
  })
  pushHistoryState({ type: 'itemSettings', itemId: item.id })
}

function closeModal() {
  // This is the programmatic "back" used by Close buttons on history-managed modals
  history.back()
}

function goBack(): void {
  // Delegate entirely to browser history
  history.back()
}

function drillDown(childFolder: MediaFolder): void {
  const parent = selectedItemForDetailView
  if (!parent) return

  const root = navStack.viewStack[0]
  if (!root) return

  const pathToParent = findPathToItem(root, parent.id)
  if (pathToParent.length > 0) {
    selectedItemForDetailView = null
    viewStack = [...pathToParent, childFolder]
    pushHistoryState()
  }
}

async function handleItemClick(
  item: LibraryItem | SearchIndexEntry
): Promise<{ action: 'play'; item: LibraryItem } | void> {
  // If it's a virtual folder from a search result or grouping
  if ((item as any).isVirtual === true) {
    pushFolder(item as MediaFolder)
    return
  }

  const loadedItem = await getLoadedItem(item.id)
  if (!loadedItem) return

  // Simple file handling (play if not folder-like)
  if (loadedItem.type === 'file' && !loadedItem.opensAsFolder) {
    return { action: 'play', item: loadedItem }
  }

  if (selectedItemForDetailView) {
    const parent = selectedItemForDetailView

    // If clicking own item in detail view
    if (selectedItemForDetailView.id === item.id && item.type === 'file') {
      return { action: 'play', item: loadedItem }
    }

    if (loadedItem.type === 'folder' && (parent as any).childrenClickAction === 'navigate') {
      drillDown(loadedItem as MediaFolder)
      return
    }

    // Navigate to new detail page (e.g. clicking "Next Up" item inside detail view)
    // We update the detail view directly.
    const processedItem = await api.getItemDetails(loadedItem.id)
    selectedItemForDetailView = processedItem ?? loadedItem
    pushHistoryState()
    return
  }

  // Main view navigation
  const currentFolderClickAction = (navStack.currentFolder as any)?.clickAction ?? 'detail'
  if (loadedItem.type === 'folder' && currentFolderClickAction === 'navigate') {
    pushFolder(loadedItem as MediaFolder)
    return
  }

  const processedItem = await api.getItemDetails(loadedItem.id)
  selectedItemForDetailView = processedItem ?? loadedItem
  pushHistoryState()
}

async function handleDetailSearchItemClick(item: SearchIndexEntry): Promise<void> {
  const loadedItem = await getLoadedItem(item.id)
  if (!loadedItem) return

  // Logic: User searched for an item while in detail view.
  // We want to navigate to that item.
  // If the current detail view is a folder in the stack, we might want to keep it in stack?
  // Current logic just replaces detail view.
  // To keep history clean: we are moving from Item A -> Item B.
  
  if (selectedItemForDetailView?.type === 'folder') {
     // If the previous item was a folder, should we push it to stack?
     // The original logic did:
     // if (lastDetailItem?.type === 'folder') viewStack.push(lastDetailItem)
     // But `selectedItemForDetailView` IS the current one.
     // If we want to simulate drilling down, we would need to know relationship.
     // For search, it's usually a jump. Replacing detail view is fine.
  }

  const processedItem = await api.getItemDetails(loadedItem.id)
  selectedItemForDetailView = processedItem ?? loadedItem
  pushHistoryState()
}

function handleSearchByTag(_key: string, _value: string): void {
  // When searching by tag from detail view, we go back to the main list (root or current folder)
  // and apply filter.
  // Effectively closing detail view.
  selectedItemForDetailView = null
  pushHistoryState()
}

// --- Exports ---

export const navStack = {
  get viewStack() {
    return viewStack
  },
  set viewStack(v) {
    viewStack = v
  },
  get selectedItemForDetailView() {
    return selectedItemForDetailView
  },
  set selectedItemForDetailView(i) {
    selectedItemForDetailView = i
  },
  get currentFolder() {
    return currentFolder
  },
  get isDetailViewActive() {
    return isDetailViewActive
  },
  get canGoBack() {
    return canGoBack
  },
  get isHistoryModalOpen() {
    return isHistoryModalOpen
  },

  init,
  navigateToRoot,
  pushFolder,
  openSettings,
  openItemSettings,
  closeModal,
  goBack,
  drillDown,
  handleItemClick,
  handleDetailSearchItemClick,
  handleSearchByTag
}