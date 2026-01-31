// No imports needed for this store currently

// --- Types ---

interface NavigationState {
  currentFolderId: string // 'root' = Root
  selectedItemId: string | null // For Detail View
  settingsModalOpen: boolean
  itemSettingsId: string | null
}

// --- State ---

let currentState = $state<NavigationState>({
  currentFolderId: 'root',
  selectedItemId: null,
  settingsModalOpen: false,
  itemSettingsId: null
})

// --- Derived Helpers ---

const isDetailViewActive = $derived(currentState.selectedItemId !== null)

// --- URL Parsing & Synchronization ---

function getUrlParams(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

function parseUrl() {
  const params = getUrlParams()
  const folder = params.get('folder')?.trim() || 'root'
  const item = params.get('item')?.trim() || null
  const modal = params.get('modal')?.trim() || null
  const modalItem = params.get('modalItemId')?.trim() || null

  currentState = {
    currentFolderId: folder,
    selectedItemId: item,
    settingsModalOpen: modal === 'settings',
    itemSettingsId: modal === 'itemSettings' ? modalItem : null
  }

  updateUrl(true)
}

function updateUrl(replace = false) {
  const params = new URLSearchParams()
  if (currentState.currentFolderId)
    params.set('folder', currentState.currentFolderId)
  if (currentState.selectedItemId) params.set('item', currentState.selectedItemId)
  if (currentState.settingsModalOpen) params.set('modal', 'settings')
  if (currentState.itemSettingsId) {
    params.set('modal', 'itemSettings')
    params.set('modalItemId', currentState.itemSettingsId)
  }

  const str = params.toString()
  const url = str ? `?${str}` : '/'

  if (replace) {
    history.replaceState({}, '', url)
  } else {
    history.pushState({}, '', url)
  }
}

// --- Actions ---

function navigateToFolder(folderId: string) {
  currentState.currentFolderId = folderId
  currentState.selectedItemId = null
  updateUrl()
}

function navigateToRoot() {
  currentState.currentFolderId = 'root'
  currentState.selectedItemId = null
  updateUrl()
}

function openDetail(itemId: string) {
  currentState.selectedItemId = itemId
  updateUrl()
}

function closeDetail() {
  currentState.selectedItemId = null
  updateUrl() // This "goes back" effectively
}

function goBack() {
  // If modal open, close it
  if (currentState.settingsModalOpen || currentState.itemSettingsId) {
    currentState.settingsModalOpen = false
    currentState.itemSettingsId = null
    updateUrl()
    return
  }

  // If detail view open, close it
  if (currentState.selectedItemId) {
    currentState.selectedItemId = null
    updateUrl()
    return
  }

  // If in folder, go to parent?
  // This requires knowing the parent.
  // Since we don't have the tree, we rely on the component (AppHeader)
  // to call `navigateToFolder(parentId)` or just use the browser Back button.

  history.back()
}

// --- Init ---

function init() {
  window.addEventListener('popstate', () => {
    parseUrl()
  })
  parseUrl()
}

export const navStoreV2 = {
  get state() {
    return currentState
  },
  get isDetailViewActive() {
    return isDetailViewActive
  },
  init,
  navigateToFolder: (folderId: string) => {
    navigateToFolder(folderId)
  },
  navigateToRoot: () => {
    navigateToRoot()
  },
  openDetail: (itemId: string) => {
    openDetail(itemId)
  },
  closeDetail: () => {
    closeDetail()
  },
  goBack: () => {
    goBack()
  },
  // Modals
  openSettings: () => {
    currentState.settingsModalOpen = true
    updateUrl()
  },
  openItemSettings: (id: string) => {
    currentState.itemSettingsId = id
    updateUrl()
  },
  closeModals: () => {
    currentState.settingsModalOpen = false
    currentState.itemSettingsId = null
    updateUrl()
  }
}
