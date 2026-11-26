import type { SearchQuery } from '@shared/types'
import { serializeSearchQuery, deserializeSearchQuery } from './search-query-helpers'
import { viewStateStore } from './view-state-store.svelte'

// --- Types ---

interface NavigationState {
  currentFolderId: string // 'home' = Home virtual folder
  selectedItemId: string | null // For Detail View
  path: string // '/' or '/settings'
  settingsTab: string | null // Open Settings tab, kept in the URL so a reload returns to it
  globalQuery: SearchQuery // Unified source of truth for global search
  searchOpen: boolean // The search view, kept in the URL as `q` so Back closes it
}

// --- State ---

let currentState = $state<NavigationState>({
  currentFolderId: 'home',
  selectedItemId: null,
  path: '/',
  settingsTab: null,
  globalQuery: { text: '', tags: [] },
  searchOpen: false
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

function isSearchRoute(state: NavigationState): boolean {
  return state.searchOpen && !isDetailRoute(state) && !isSettingsRoute(state)
}

function isDetailRoute(state: NavigationState): boolean {
  return state.selectedItemId !== null
}

function canNavigateBack(state: NavigationState): boolean {
  return (
    state.currentFolderId !== 'home' ||
    isDetailRoute(state) ||
    isSettingsRoute(state) ||
    isSearchRoute(state)
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
    settingsTab: params.get('tab')?.trim() || null,
    globalQuery: queryObj,
    searchOpen: params.has('q')
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
  } else if (currentState.searchOpen) {
    params.set('q', queryStr)
  }

  if (currentState.path !== '/') {
    params.set('page', 'settings')
    if (currentState.settingsTab) params.set('tab', currentState.settingsTab)
  }

  const str = params.toString()
  const url = str ? `?${str}` : '/'

  // A search entry remembers the entry its search started from, so closing the search
  // returns there in one step, however many searches it went through.
  const searchBase = !isSearchRoute(currentState) ? undefined
    : replace || isSearchRoute(readRoute()) ? history.state?.searchBase : historyPosition

  if (replace) {
    history.replaceState({ ...history.state, kinomePosition: historyPosition, searchBase }, '', url)
  } else {
    history.pushState({ kinomePosition: ++historyPosition, searchBase }, '', url)
  }
}

// --- Actions ---

function navigateToFolder(folderId: string) {
  currentState.currentFolderId = folderId
  currentState.selectedItemId = null
  currentState.path = '/'
  currentState.globalQuery = { text: '', tags: [] } // Clear search on folder change
  currentState.searchOpen = false
  updateUrl()
}

function navigateToHome() {
  currentState.currentFolderId = 'home'
  currentState.selectedItemId = null
  currentState.path = '/'
  currentState.globalQuery = { text: '', tags: [] }
  currentState.searchOpen = false
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
  currentState.settingsTab = null
  currentState.searchOpen = false
  updateUrl()
}

function openSearch() {
  if (isSearchRoute(currentState)) return
  currentState.path = '/'
  currentState.settingsTab = null
  currentState.selectedItemId = null
  currentState.globalQuery = { text: '', tags: [] }
  currentState.searchOpen = true
  updateUrl()
}

function closeSearch() {
  const base = history.state?.searchBase
  if (base !== undefined && base < historyPosition) {
    history.go(base - historyPosition)
  } else {
    // A search opened from a link has no entry to return to.
    currentState.globalQuery = { text: '', tags: [] }
    currentState.searchOpen = false
    updateUrl(true)
  }
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
  // Back from the first entry: leave as the browser would have.
  if (history.state?.kinomeGuard) {
    history.back()
    return
  }
  if (isSettingsRoute(currentState) && !isSettingsRoute(readRoute())) {
    allowSettingsExit(applyHistory)
  } else {
    applyHistory()
  }
}

// Overlays that the browser's back button closes, newest last. They add no history entries:
// the back press is undone, and it closes the newest overlay instead of navigating.
const backClosers: (() => void)[] = []
let restoringForOverlay = false

function closeOnBack(close: () => void): () => void {
  guardFirstEntry()
  backClosers.push(close)
  return () => {
    const index = backClosers.lastIndexOf(close)
    if (index >= 0) backClosers.splice(index, 1)
  }
}

// Back from the app's first entry unloads the page before an overlay can catch it, which
// leaves a blank page in an installed app. So the first overlay opened there moves that
// entry forward one step, with a guard entry behind it that Back can land on.
function guardFirstEntry() {
  if (historyPosition !== 0 || history.state?.kinomeGuarded) return
  history.replaceState({ ...history.state, kinomePosition: -1, kinomeGuard: true }, '')
  history.pushState({ ...history.state, kinomePosition: 0, kinomeGuard: undefined, kinomeGuarded: true }, '', location.href)
}

function closeOverlayOnBack(event: PopStateEvent) {
  if (restoringForOverlay) {
    restoringForOverlay = false
    event.stopImmediatePropagation()
    return
  }
  const close = backClosers.at(-1)
  if (!close) return
  event.stopImmediatePropagation()
  const target = history.state?.kinomePosition
  // Returning to our entry fires one more popstate, which is ours to ignore.
  if (target !== undefined && target !== historyPosition) restoringForOverlay = true
  restoreHistory()
  close()
}

function init() {
  // Arriving on the guard, such as with Forward from another site, shows the entry it guards.
  if (history.state?.kinomeGuard) history.forward()
  applyHistory()
  // Capture listeners on the window run before the navigation listeners below.
  window.addEventListener('popstate', closeOverlayOnBack, { capture: true })
  window.addEventListener('popstate', syncHistory)
}

export const navStore = {
  closeOnBack,
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
  get settingsTab() {
    return currentState.settingsTab
  },
  /** Switching tabs rewrites the current history entry, so Back still leaves Settings in one step. */
  setSettingsTab: (tab: string) => {
    if (!isSettingsRoute(currentState) || navigationPending) return
    currentState.settingsTab = tab
    updateUrl(true)
  },
  get isSettingsActive() {
    return isSettingsRoute(currentState)
  },
  get isGlobalSearchActive() {
    return hasSearchQuery(currentState.globalQuery)
  },
  /** The search view is open, whether or not it has a query yet. */
  get isSearchOpen() {
    return isSearchRoute(currentState)
  },
  openSearch: () => {
    allowSettingsExit(openSearch)
  },
  closeSearch: () => {
    if (!navigationPending && isSearchRoute(currentState)) closeSearch()
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
    // Typing refines the open search in place; starting a search adds an entry.
    const shouldReplace = options.replace ?? isSearchRoute(currentState)

    currentState.globalQuery = query
    currentState.searchOpen = true
    if (options.closeDetail && currentState.selectedItemId) {
      currentState.selectedItemId = null
    }
    updateUrl(shouldReplace)
  }
}
