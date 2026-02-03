import type { SearchQuery } from '../../../shared/types'
import { serializeSearchQuery, deserializeSearchQuery } from './search-query-helpers'

// --- Types ---

interface NavigationState {
  currentFolderId: string // 'root' = Root
  selectedItemId: string | null // For Detail View
  path: string // '/' or '/settings'
  globalQuery: SearchQuery // Unified source of truth for global search
}

// --- State ---

let currentState = $state<NavigationState>({
  currentFolderId: 'root',
  selectedItemId: null,
  path: '/',
  globalQuery: { text: '', tags: [] }
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
  const queryStr = params.get('q')?.trim() || null
  const queryObj = deserializeSearchQuery(queryStr)
  let pathParam = params.get('page')?.trim() || '/'

  if (pathParam !== '/' && !pathParam.startsWith('/')) {
    pathParam = '/' + pathParam
  }

  currentState = {
    currentFolderId: folder,
    selectedItemId: item,
    path: pathParam,
    globalQuery: queryObj
  }
}

function updateUrl(replace = false) {
  const params = new URLSearchParams()
  // Always set folder if it exists, including 'root' to maintain context
  if (currentState.currentFolderId) params.set('folder', currentState.currentFolderId)
  if (currentState.selectedItemId) params.set('item', currentState.selectedItemId)

  const queryStr = serializeSearchQuery(currentState.globalQuery)
  if (queryStr) params.set('q', queryStr)

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
  currentState.globalQuery = { text: '', tags: [] } // Clear search on folder change
  updateUrl()
}

function navigateToRoot() {
  currentState.currentFolderId = 'root'
  currentState.selectedItemId = null
  currentState.path = '/'
  currentState.globalQuery = { text: '', tags: [] } // Clear search on root
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
  /**
   * Updates the global search query.
   * @param query The new search query object.
   * @param options Configuration for history behavior and side effects.
   */
  setGlobalSearch: (query: SearchQuery, options: { replace?: boolean; closeDetail?: boolean } = {}) => {
    const params = getUrlParams()
    const hasSearchInUrl = params.has('q')

    const shouldReplace = options.replace ?? hasSearchInUrl

    currentState.globalQuery = query
    if (options.closeDetail && currentState.selectedItemId) {
      currentState.selectedItemId = null
    }
    updateUrl(shouldReplace)
  }
}
