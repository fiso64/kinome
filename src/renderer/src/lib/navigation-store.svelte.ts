import type { SearchQuery } from '@shared/types'
import { serializeSearchQuery, deserializeSearchQuery } from './search-query-helpers'
import { viewStateStore } from './view-state-store.svelte'

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

// --- Derived Helpers removed, using direct getters in navStore ---

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

  if (currentState.currentFolderId) params.set('folder', currentState.currentFolderId)

  const queryStr = serializeSearchQuery(currentState.globalQuery)

  // Clean URL Strategy: 
  // If a detail item is selected, we don't need to show the search query in the URL.
  // This avoids URL pollution while preserving the search in the HISTORY entry we just left.
  if (currentState.selectedItemId) {
    params.set('item', currentState.selectedItemId)
    // We explicitly DON'T set 'q' here.
  } else if (queryStr) {
    params.set('q', queryStr)
  }

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
  // Reset scroll persistence for detail views when navigating (pushing) to them.
  // This ensures we always start at the top, but preserves scroll position when navigating BACK (popstate).
  // The key format must match what ItemDetail.svelte uses: `${itemId}:detail`
  try {
    const key = `${itemId}:detail`
    // We access the store directly to reset it.
    // Note: We match the default shape used in scroll-persistence.svelte.ts
    const scrollState = viewStateStore.get(key, { y: 0, x: 0, resetVal: null as string | null })
    scrollState.y = 0
    scrollState.x = 0

    // Also reset the Tabs state so that "Next Up" or default tab logic runs afresh.
    // Key format matches TabsView.svelte: `${itemId}:tabs`
    const tabsKey = `${itemId}:tabs`
    const tabsState = viewStateStore.get(tabsKey, { activeTabId: null })
    tabsState.activeTabId = null
  } catch (err) {
    console.warn('[Navigation] Failed to reset scroll persistence:', err)
  }

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

export const navStore = {
  get state() {
    return currentState
  },
  get isDetailViewActive() {
    return currentState.selectedItemId !== null
  },
  get contextItemId() {
    return currentState.selectedItemId ?? currentState.currentFolderId
  },
  get canGoBack() {
    return (
      (currentState.currentFolderId !== 'root' && currentState.currentFolderId !== null) ||
      currentState.selectedItemId !== null ||
      currentState.path !== '/'
    )
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
  setGlobalSearch: (
    query: SearchQuery,
    options: { replace?: boolean; closeDetail?: boolean } = {}
  ) => {
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
