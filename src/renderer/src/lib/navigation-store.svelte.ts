import type { SearchQuery } from '@shared/types'
import { serializeSearchQuery, deserializeSearchQuery } from './search-query-helpers'
import { viewStateStore } from './view-state-store.svelte'

// --- Types ---

interface NavigationState {
  currentFolderId: string // 'home' = Home virtual folder
  selectedItemId: string | null // For Detail View
  path: string // '/' or '/settings'
  globalQuery: SearchQuery // Unified source of truth for global search
}

// --- State ---

let currentState = $state<NavigationState>({
  currentFolderId: 'home',
  selectedItemId: null,
  path: '/',
  globalQuery: { text: '', tags: [] }
})

// --- Route Predicates ---

function hasSearchQuery(query: SearchQuery): boolean {
  return query.text.trim() !== '' || query.tags.length > 0
}

function isHomeRoute(state: NavigationState): boolean {
  return (
    state.currentFolderId === 'home' &&
    state.selectedItemId === null &&
    state.path === '/'
  )
}

function isSettingsRoute(state: NavigationState): boolean {
  return state.path === '/settings'
}

function isDetailRoute(state: NavigationState): boolean {
  return state.selectedItemId !== null
}

function canNavigateBack(state: NavigationState): boolean {
  return (
    state.currentFolderId !== 'home' ||
    isDetailRoute(state) ||
    isSettingsRoute(state) ||
    hasSearchQuery(state.globalQuery)
  )
}

// --- URL Parsing & Synchronization ---

function getUrlParams(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

function readRoute(): NavigationState {
  const params = getUrlParams()
  const folder = params.get('folder')?.trim() || 'home'
  const item = params.get('item')?.trim() || null
  const queryStr = params.get('q')?.trim() || null
  const queryObj = deserializeSearchQuery(queryStr)
  let pathParam = params.get('page')?.trim() || '/'

  if (pathParam !== '/' && !pathParam.startsWith('/')) {
    pathParam = '/' + pathParam
  }

  return {
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
    history.replaceState({ ...history.state, kinomePosition: historyPosition }, '', url)
  } else {
    history.pushState({ kinomePosition: ++historyPosition }, '', url)
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

function navigateToHome() {
  currentState.currentFolderId = 'home'
  currentState.selectedItemId = null
  currentState.path = '/'
  currentState.globalQuery = { text: '', tags: [] }
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
  if (historyPosition > 0) {
    history.back()
  } else {
    allowSettingsExit(navigateToHome)
  }
}

// Settings keeps its draft mounted until the user accepts navigation.
type SettingsExitGuard = () => boolean | Promise<boolean>
let settingsExitGuard: SettingsExitGuard | undefined
let navigationPending = false
let historyPosition = 0

function guardSettingsExit(guard: SettingsExitGuard) {
  settingsExitGuard = guard
  return () => {
    if (settingsExitGuard === guard) settingsExitGuard = undefined
  }
}

function allowSettingsExit(navigate: () => void) {
  if (navigationPending) return
  const decision = isSettingsRoute(currentState) ? settingsExitGuard?.() ?? true : true
  if (typeof decision === 'boolean') {
    if (decision) navigate()
    else restoreHistory()
    return
  }

  navigationPending = true
  void decision.then((allowed) => {
    navigationPending = false
    if (!allowed) restoreHistory()
    else if (history.state?.kinomePosition !== historyPosition) applyHistory()
    else navigate()
  })
}

function applyHistory() {
  currentState = readRoute()
  historyPosition = history.state?.kinomePosition ?? 0
  if (history.state?.kinomePosition === undefined) {
    history.replaceState({ ...history.state, kinomePosition: historyPosition }, '')
  }
}

function restoreHistory() {
  const target = history.state?.kinomePosition
  // An older entry created before Kinome tracked positions can lack a position.
  if (target === undefined) updateUrl()
  else if (target !== historyPosition) history.go(historyPosition - target)
}

function syncHistory() {
  if (navigationPending) return
  if (isSettingsRoute(currentState) && !isSettingsRoute(readRoute())) {
    allowSettingsExit(applyHistory)
  } else {
    applyHistory()
  }
}

function init() {
  applyHistory()
  window.addEventListener('popstate', syncHistory)
}

export const navStore = {
  get state() {
    return currentState
  },
  get currentFolderId() {
    return currentState.currentFolderId
  },
  get selectedItemId() {
    return currentState.selectedItemId
  },
  get path() {
    return currentState.path
  },
  get globalQuery() {
    return currentState.globalQuery
  },
  get isHomeLocation() {
    return isHomeRoute(currentState)
  },
  get isSettingsActive() {
    return isSettingsRoute(currentState)
  },
  get isGlobalSearchActive() {
    return hasSearchQuery(currentState.globalQuery)
  },
  get isDetailViewActive() {
    return isDetailRoute(currentState)
  },
  get contextItemId() {
    return currentState.selectedItemId ?? currentState.currentFolderId
  },
  get canGoBack() {
    return canNavigateBack(currentState)
  },
  init,
  guardSettingsExit,
  navigateToFolder: (folderId: string) => {
    allowSettingsExit(() => navigateToFolder(folderId))
  },
  navigateToHome: () => {
    allowSettingsExit(navigateToHome)
  },
  navigateToSettings: () => {
    if (!isSettingsRoute(currentState) && !navigationPending) navigateToSettings()
  },
  openDetail: (itemId: string) => {
    allowSettingsExit(() => openDetail(itemId))
  },
  closeDetail: () => {
    if (!navigationPending) closeDetail()
  },
  goBack: () => {
    if (!navigationPending) goBack()
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
    if (navigationPending) return
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
