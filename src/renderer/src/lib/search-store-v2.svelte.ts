import { api } from './api'
import { navStoreV2 } from './navigation-store-v2.svelte'
import { isTypingTag as isTypingTagHelper } from './view-helpers'
import type { SearchIndexEntry, SearchQuery } from '../../../shared/types'
import { serializeSearchQuery } from './search-query-helpers'

// --- State (Local-only search views) ---

let searchResults = $state<SearchIndexEntry[]>([])
let highlightedGlobalIndex = $state<number | null>(null)
let isPerformingGlobalSearch = $state(false)

let detailQuery = $state<SearchQuery>({ text: '', tags: [] })
let detailResults = $state<SearchIndexEntry[]>([])
let highlightedDetailIndex = $state<number | null>(null)
let isPerformingDetailSearch = $state(false)

let filterQuery = $state<SearchQuery>({ text: '', tags: [] })
let isFilterBarVisible = $state(false)
let filterFocusKey = $state(0)

// --- Derived ---

const isGlobalActive = $derived(
  navStoreV2.state.globalQuery.text.trim() !== '' ||
  navStoreV2.state.globalQuery.tags.length > 0
)
const isTypingGlobalTag = $derived(isTypingTagHelper(navStoreV2.state.globalQuery.text))

const isDetailActive = $derived(detailQuery.text.trim() !== '' || detailQuery.tags.length > 0)
const isTypingDetailTag = $derived(isTypingTagHelper(detailQuery.text))

// --- Search Effects ---

export function initializeSearchEffects() {
  // --- Global Search: Sync and Perform ---
  $effect(() => {
    // Atomic access to globalQuery to track all changes
    const query = navStoreV2.state.globalQuery
    const serialized = serializeSearchQuery(query)

    // Check if URL and State are out of sync. 
    // This only happens when the user types (state changes first).
    // On popstate, parseUrl updates state synchronously, so they match here.
    const urlParams = new URLSearchParams(window.location.search)
    const urlQuery = urlParams.get('q') || ''

    if (serialized !== urlQuery) {
      // Safeguard: only trigger navigation if we are NOT in detail view.
      // If we ARE in detail view, URL changes for 'q' should usually be 
      // ignored or handled differently (e.g. if the user actually clicked a search result).
      if (!navStoreV2.isDetailViewActive) {
        navStoreV2.setGlobalSearch(query, {
          closeDetail: !isTypingGlobalTag
        })
      }
    }

    // Perform the actual search
    if (isGlobalActive && !isTypingGlobalTag) {
      isPerformingGlobalSearch = true
      api.performSearch(JSON.parse(JSON.stringify(query))).then((results) => {
        searchResults = results
        isPerformingGlobalSearch = false
        highlightedGlobalIndex = results.length > 0 ? 0 : null
      })
    } else if (!isGlobalActive) {
      searchResults = []
      isPerformingGlobalSearch = false
      highlightedGlobalIndex = null
    }
  })

  // --- Detail View Search Effect ---
  $effect(() => {
    const query = detailQuery
    if (navStoreV2.state.selectedItemId && isDetailActive && !isTypingDetailTag) {
      isPerformingDetailSearch = true
      api.performSearch(JSON.parse(JSON.stringify(query))).then((results) => {
        detailResults = results
        isPerformingDetailSearch = false
        highlightedDetailIndex = results.length > 0 ? 0 : null
      })
    }
    else if (!isDetailActive) {
      detailResults = []
      isPerformingDetailSearch = false
      highlightedDetailIndex = null
    }
  })

  // --- Auto-highlight First Result ---
  $effect(() => {
    if (searchResults.length > 0) {
      if (highlightedGlobalIndex === null || highlightedGlobalIndex >= searchResults.length) {
        highlightedGlobalIndex = 0
      }
    } else {
      highlightedGlobalIndex = null
    }
  })

  // --- Filter Bar Cleanup ---
  let wasFilterVisible = false
  $effect(() => {
    // Hide filter bar when navigating to detail view or global search
    if (navStoreV2.state.selectedItemId || isGlobalActive) {
      if (isFilterBarVisible) {
        const isFilterEmpty = filterQuery.text.trim() === '' && filterQuery.tags.length === 0
        if (!isFilterEmpty) wasFilterVisible = true
        isFilterBarVisible = false
      }
    } else {
      if (wasFilterVisible) {
        isFilterBarVisible = true
        wasFilterVisible = false
      }
    }
  })

  $effect(() => {
    // Clear main view filter when navigating away from search results
    void navStoreV2.state.currentFolderId
    if (!isGlobalActive) {
      filterQuery = { text: '', tags: [] }
    }
  })
}

// --- Methods ---

function clearGlobal() {
  navStoreV2.setGlobalSearch({ text: '', tags: [] }, { replace: true })
}

function clearDetail() {
  detailQuery = { text: '', tags: [] }
}

function clearFilter() {
  filterQuery = { text: '', tags: [] }
}

function searchByTag(key: string, value: string) {
  navStoreV2.setGlobalSearch({ text: '', tags: [{ key, value }] }, { replace: false, closeDetail: true })
}

// --- Exported Store Object ---

export const searchStoreV2 = {
  get globalQuery() {
    return navStoreV2.state.globalQuery
  },
  set globalQuery(v) {
    // This setter is mainly for svelte bindings (bind:query)
    navStoreV2.setGlobalSearch(v, { closeDetail: true })
  },
  get isGlobalActive() {
    return isGlobalActive
  },
  get searchResults() {
    return searchResults
  },
  set searchResults(v) {
    searchResults = v
  },
  get highlightedGlobalIndex() {
    return highlightedGlobalIndex
  },
  set highlightedGlobalIndex(v) {
    highlightedGlobalIndex = v
  },
  get isPerformingGlobalSearch() {
    return isPerformingGlobalSearch
  },

  get detailQuery() {
    return detailQuery
  },
  set detailQuery(v) {
    detailQuery = v
  },
  get isDetailActive() {
    return isDetailActive
  },
  get detailResults() {
    return detailResults
  },
  set detailResults(v) {
    detailResults = v
  },
  get highlightedDetailIndex() {
    return highlightedDetailIndex
  },
  set highlightedDetailIndex(v) {
    highlightedDetailIndex = v
  },
  get isPerformingDetailSearch() {
    return isPerformingDetailSearch
  },

  get filterQuery() {
    return filterQuery
  },
  set filterQuery(v) {
    filterQuery = v
  },
  get isFilterBarVisible() {
    return isFilterBarVisible
  },
  set isFilterBarVisible(v) {
    isFilterBarVisible = v
  },
  get filterFocusKey() {
    return filterFocusKey
  },
  set filterFocusKey(v) {
    filterFocusKey = v
  },

  clearGlobal,
  clearDetail,
  clearFilter,
  searchByTag
}
