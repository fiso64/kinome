import { getLoadedItem } from './item-store'
import { findPathToItem } from './tree-helpers'
import { api } from './api'
import { modalStore } from './modal-store.svelte'
import { resolveViewSettings } from '../../../shared/settings-helpers'
import type { LibraryItem, MediaFolder, SearchIndexEntry } from '../../../shared/types'

// --- Types ---

export type ViewStackItem = MediaFolder

interface SearchQuery {
  text: string
  tags: { key: string; value: string }[]
}

interface HistoryState {
  stackIds: string[]
  detailId: string | null
  modal?: { type: 'settings' } | { type: 'itemSettings'; itemId: string }
  searchQuery?: SearchQuery
}

// --- Integration with Search Store ---
let searchInterface: {
  getQuery: () => SearchQuery
  setQuery: (q: SearchQuery) => void
  isRestoring: boolean
} | null = null

export function registerSearchInterface(si: typeof searchInterface) {
  searchInterface = si
}

// --- State (using Svelte Runes) ---

let viewStack = $state<ViewStackItem[]>([])
let selectedItemForDetailView = $state<LibraryItem | null>(null)
let isHistoryModalOpen = $state(false)

// --- Derived State ---

const currentFolder = $derived(viewStack.length > 0 ? viewStack[viewStack.length - 1] : null)
const isDetailViewActive = $derived(selectedItemForDetailView !== null)
const canGoBack = $derived(isDetailViewActive || viewStack.length > 1 || isHistoryModalOpen)

// --- History Helpers ---

function serializeTags(tags: { key: string; value: string }[]): string {
  return JSON.stringify(tags)
}

function getUrlParams(
  stack: ViewStackItem[],
  detail: LibraryItem | null,
  modal?: HistoryState['modal'],
  searchQuery?: SearchQuery
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

  if (searchQuery && (searchQuery.text || searchQuery.tags.length > 0)) {
    if (searchQuery.text) params.set('q', searchQuery.text)
    if (searchQuery.tags.length > 0) params.set('tags', serializeTags(searchQuery.tags))
  }

  const str = params.toString()
  return str ? `?${str}` : '/'
}

function getSnapshot(
  modal?: HistoryState['modal'],
  searchQueryOverride?: SearchQuery
): HistoryState {
  const rawQuery = searchQueryOverride ?? searchInterface?.getQuery()
  return {
    stackIds: viewStack.map((f) => f.id),
    detailId: selectedItemForDetailView?.id ?? null,
    modal: modal ? JSON.parse(JSON.stringify(modal)) : undefined,
    // Deep clone to strip Svelte proxies before saving to history
    searchQuery: rawQuery ? JSON.parse(JSON.stringify(rawQuery)) : undefined
  }
}

function pushHistoryState(modal?: HistoryState['modal'], searchQuery?: SearchQuery) {
  const state = getSnapshot(modal, searchQuery)
  const url = getUrlParams(viewStack, selectedItemForDetailView, modal, state.searchQuery)
  history.pushState(state, '', url)
  isHistoryModalOpen = !!modal
}

function replaceHistoryState(modal?: HistoryState['modal'], searchQuery?: SearchQuery) {
  const state = getSnapshot(modal, searchQuery)
  const url = getUrlParams(viewStack, selectedItemForDetailView, modal, state.searchQuery)
  history.replaceState(state, '', url)
  isHistoryModalOpen = !!modal
}

/**
 * Called by SearchStore when the user types.
 * Determines whether to push or replace history based on current search state.
 */
function handleSearchUpdate(newQuery: SearchQuery) {
  if (searchInterface && searchInterface.isRestoring) return

  const currentState = history.state as HistoryState | null
  const currentSearch = currentState?.searchQuery ?? { text: '', tags: [] }

  const isCurrentEmpty = !currentSearch.text && currentSearch.tags.length === 0
  const isNewEmpty = !newQuery.text && newQuery.tags.length === 0

  if (isNewEmpty && isCurrentEmpty) return

  if (isCurrentEmpty && !isNewEmpty) {
    pushHistoryState(currentState?.modal, newQuery)
  } else {
    replaceHistoryState(currentState?.modal, newQuery)
  }
}

async function restoreFromState(state: HistoryState | null, rootFallback: MediaFolder) {
  if (searchInterface) searchInterface.isRestoring = true

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
          const settings = await api.getSettings()
          const resolved = resolveViewSettings(item as MediaFolder, settings).settings
          modalStore.open('itemSettings', {
            item,
            initialTab: 'metadata',
            defaultLayout: resolved.layout
          })
        }
      }
    } else {
      isHistoryModalOpen = false
      if (
        modalStore.activeModal?.type === 'settings' ||
        modalStore.activeModal?.type === 'itemSettings'
      ) {
        modalStore.close()
      }
    }

    // Restore Search
    if (searchInterface) {
      const query = state.searchQuery ?? { text: '', tags: [] }
      searchInterface.setQuery(query)
    }
  } else {
    // No valid state, reset to root
    viewStack = [rootFallback]
    selectedItemForDetailView = null
    isHistoryModalOpen = false
    modalStore.close()
    if (searchInterface) searchInterface.setQuery({ text: '', tags: [] })
    replaceHistoryState()
  }

  setTimeout(() => {
    if (searchInterface) searchInterface.isRestoring = false
  }, 0)
}

// --- Initialization ---

async function init(root: MediaFolder) {
  window.addEventListener('popstate', (event) => {
    restoreFromState(event.state as HistoryState, root)
  })
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

function openSettings() {
  modalStore.open('settings')
  pushHistoryState({ type: 'settings' })
}

async function openItemSettings(
  item: LibraryItem,
  initialTab: 'metadata' | 'view' | 'folder' | 'settings' = 'metadata'
) {
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
  history.back()
}

function goBack(): void {
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
  if ((item as any).isVirtual === true) {
    pushFolder(item as MediaFolder)
    return
  }

  const loadedItem = await getLoadedItem(item.id)
  if (!loadedItem) return

  if (loadedItem.type === 'file' && !loadedItem.opensAsFolder) {
    return { action: 'play', item: loadedItem }
  }

  if (selectedItemForDetailView) {
    const parent = selectedItemForDetailView

    if (selectedItemForDetailView.id === item.id && item.type === 'file') {
      return { action: 'play', item: loadedItem }
    }

    if (loadedItem.type === 'folder' && (parent as any).childrenClickAction === 'navigate') {
      drillDown(loadedItem as MediaFolder)
      return
    }

    const processedItem = await api.getItemDetails(loadedItem.id)
    selectedItemForDetailView = processedItem ?? loadedItem
    pushHistoryState()
    return
  }

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

  const processedItem = await api.getItemDetails(loadedItem.id)
  selectedItemForDetailView = processedItem ?? loadedItem
  pushHistoryState()
}

function handleSearchByTag(_key: string, _value: string): void {
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
  handleSearchByTag,
  handleSearchUpdate,
  registerSearchInterface
}