// No imports needed for this store currently

// --- Types ---

interface NavigationState {
  currentFolderId: string // 'root' = Root
  selectedItemId: string | null // For Detail View
  path: string // '/' or '/settings'
  searchQuery: string | null // For Global Search
}

// --- State ---

let currentState = $state<NavigationState>({
  currentFolderId: 'root',
  selectedItemId: null,
  path: '/',
  searchQuery: null
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
  const query = params.get('q')?.trim() || null
  let pathParam = params.get('page')?.trim() || '/'

  if (pathParam !== '/' && !pathParam.startsWith('/')) {
    pathParam = '/' + pathParam
  }

  currentState = {
    currentFolderId: folder,
    selectedItemId: item,
    path: pathParam,
    searchQuery: query
  }

  updateUrl(true)
}

function updateUrl(replace = false) {
  const params = new URLSearchParams()
  if (currentState.currentFolderId) params.set('folder', currentState.currentFolderId)
  if (currentState.selectedItemId) params.set('item', currentState.selectedItemId)
  if (currentState.searchQuery) params.set('q', currentState.searchQuery)
  if (currentState.path !== '/') params.set('page', 'settings')

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
  currentState.path = '/'
  currentState.searchQuery = null // Clear search on folder change
  updateUrl()
}

function navigateToRoot() {
  currentState.currentFolderId = 'root'
  currentState.selectedItemId = null
  currentState.path = '/'
  currentState.searchQuery = null // Clear search on root
  updateUrl()
}

function openDetail(itemId: string) {
  currentState.selectedItemId = itemId
  currentState.path = '/'
  updateUrl()
}

function closeDetail() {
  currentState.selectedItemId = null
  updateUrl() // This "goes back" effectively
}

function navigateToSettings() {
  currentState.path = '/settings'
  updateUrl()
}

function goBack() {
  // If we have history to go back to, use it. This preserves all context (folder, item, page).
  // Otherwise (e.g. direct link), go to the home screen.
  if (window.history.length > 1) {
    history.back()
  } else {
    navigateToRoot()
  }
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
  get contextItemId() {
    return currentState.selectedItemId ?? currentState.currentFolderId
  },
  init,
  navigateToFolder: (folderId: string) => {
    navigateToFolder(folderId)
  },
  navigateToRoot: () => {
    navigateToRoot()
  },
  navigateToSettings: () => {
    navigateToSettings()
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
  setSearchQuery: (q: string | null, replace = true) => {
    currentState.searchQuery = q
    updateUrl(replace)
  }
}
