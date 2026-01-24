import { getLoadedItem } from './item-store'
import { findPathToItem } from './tree-helpers'
import { api } from './api'
import type { LibraryItem, MediaFolder, SearchIndexEntry } from '../../../shared/types'

// --- Types ---

export type ViewStackItem = MediaFolder

// --- State (using Svelte Runes) ---

let viewStack = $state<ViewStackItem[]>([])
let selectedItemForDetailView = $state<LibraryItem | null>(null)
let lastDetailItem = $state<LibraryItem | null>(null)

// --- Derived State ---

const currentFolder = $derived(viewStack.length > 0 ? viewStack[viewStack.length - 1] : null)
const isDetailViewActive = $derived(selectedItemForDetailView !== null)
const canGoBack = $derived(isDetailViewActive || viewStack.length > 1)

// --- Navigation Methods ---

function navigateToRoot(root: MediaFolder): void {
  viewStack = [root]
  selectedItemForDetailView = null
  lastDetailItem = null
}

function pushFolder(folder: MediaFolder): void {
  selectedItemForDetailView = null
  lastDetailItem = null
  viewStack.push(folder)
}

function openDetailView(item: LibraryItem): void {
  selectedItemForDetailView = item
}

function closeDetailView(): void {
  selectedItemForDetailView = null
}

function goBack(): void {
  if (!canGoBack) return

  if (selectedItemForDetailView) {
    if (lastDetailItem) {
      selectedItemForDetailView = lastDetailItem
      viewStack.pop()
      lastDetailItem = null
    } else {
      selectedItemForDetailView = null
    }
  } else {
    if (lastDetailItem) {
      selectedItemForDetailView = lastDetailItem
      viewStack.pop()
      viewStack.pop()
      lastDetailItem = null
    } else if (viewStack.length > 1) {
      viewStack.pop()
    }
  }
}

function drillDown(childFolder: MediaFolder): void {
  const parent = selectedItemForDetailView
  if (!parent) return

  const root = navStack.viewStack[0]
  if (!root) return

  const pathToParent = findPathToItem(root, parent.id)
  if (pathToParent.length > 0) {
    lastDetailItem = parent
    selectedItemForDetailView = null
    viewStack = [...pathToParent, childFolder]
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

    // Navigate to new detail page
    lastDetailItem = parent
    if (parent.type === 'folder') {
      viewStack.push(parent)
    }
    const processedItem = await api.getItemDetails(loadedItem.id)
    selectedItemForDetailView = processedItem ?? loadedItem
    return
  }

  // Main view navigation
  const currentFolderClickAction = (navStack.currentFolder as any)?.clickAction ?? 'detail'
  if (loadedItem.type === 'folder' && currentFolderClickAction === 'navigate') {
    pushFolder(loadedItem as MediaFolder)
    return
  }

  lastDetailItem = null
  const processedItem = await api.getItemDetails(loadedItem.id)
  selectedItemForDetailView = processedItem ?? loadedItem
}

async function handleDetailSearchItemClick(item: SearchIndexEntry): Promise<void> {
  const loadedItem = await getLoadedItem(item.id)
  if (!loadedItem) return

  lastDetailItem = selectedItemForDetailView
  if (lastDetailItem?.type === 'folder') {
    viewStack.push(lastDetailItem as MediaFolder)
  }

  const processedItem = await api.getItemDetails(loadedItem.id)
  selectedItemForDetailView = processedItem ?? loadedItem
}

function handleSearchByTag(_key: string, _value: string): void {
  lastDetailItem = selectedItemForDetailView
  selectedItemForDetailView = null
  // Note: The global search query itself remains in App.svelte for now
  // as it drives a lot of local UI state there.
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
  get lastDetailItem() {
    return lastDetailItem
  },
  set lastDetailItem(v) {
    lastDetailItem = v
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

  navigateToRoot,
  pushFolder,
  openDetailView,
  closeDetailView,
  goBack,
  drillDown,
  handleItemClick,
  handleDetailSearchItemClick,
  handleSearchByTag
}
