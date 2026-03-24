import { api } from './api'
import { navStore } from './navigation-store.svelte'
import { isTypingTag as isTypingTagHelper } from './view-helpers'
import type { SearchIndexEntry, SearchQuery } from '@shared/types'
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
  navStore.state.globalQuery.text.trim() !== '' || navStore.state.globalQuery.tags.length > 0
)
const isTypingGlobalTag = $derived(isTypingTagHelper(navStore.state.globalQuery.text))

const isDetailActive = $derived(detailQuery.text.trim() !== '' || detailQuery.tags.length > 0)
const isTypingDetailTag = $derived(isTypingTagHelper(detailQuery.text))

// --- Search Effects ---
let lastSerializedQuery = ''

export function initializeSearchEffects() {
  // --- Global Search: Sync and Perform ---
  $effect(() => {
    // Atomic access to globalQuery to track all changes
    const query = navStore.state.globalQuery
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
      if (!navStore.isDetailViewActive) {
        navStore.setGlobalSearch(query, {
          closeDetail: !isTypingGlobalTag
        })
      }
    }

    // Perform the actual search
    if (isGlobalActive && !isTypingGlobalTag) {
      if (serialized === lastSerializedQuery && searchResults.length > 0) {
        // Skip re-fetch if query is identical and we already have results
        return
      }
      lastSerializedQuery = serialized

      isPerformingGlobalSearch = true
      api.performSearch(JSON.parse(JSON.stringify(query))).then((results) => {
        // Deduplicate by id — multi-account results can contain the same item from multiple accounts
        const seen = new Set<string>()
        searchResults = results.filter((r) => {
          if (seen.has(r.id)) return false
          seen.add(r.id)
          return true
        })
        isPerformingGlobalSearch = false
        // Only auto-highlight if we don't already have a valid highlight
        if (highlightedGlobalIndex === null || highlightedGlobalIndex >= results.length) {
          highlightedGlobalIndex = results.length > 0 ? 0 : null
        }
      })
    } else if (!isGlobalActive) {
      searchResults = []
      isPerformingGlobalSearch = false
      highlightedGlobalIndex = null
      lastSerializedQuery = ''
    }
  })

  // --- Detail View Search Effect ---
  $effect(() => {
    const query = detailQuery
    if (navStore.state.selectedItemId && isDetailActive && !isTypingDetailTag) {
      isPerformingDetailSearch = true
      api.performSearch(JSON.parse(JSON.stringify(query))).then((results) => {
        detailResults = results
        isPerformingDetailSearch = false
        highlightedDetailIndex = results.length > 0 ? 0 : null
      })
    } else if (!isDetailActive) {
      detailResults = []
      isPerformingDetailSearch = false
      highlightedDetailIndex = null
    }
  })

  // --- Auto-highlight First Result ---
  $effect(() => {
    if (searchResults.length > 0) {
      // ONLY auto-set if it's null (e.g. initial load or query change)
      // If we already have a highlight (e.g. from handleItemClick), keep it.
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
    if (navStore.state.selectedItemId || isGlobalActive) {
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
    void navStore.state.currentFolderId
    if (!isGlobalActive) {
      filterQuery = { text: '', tags: [] }
    }
  })
}

// --- Methods ---

function clearGlobal() {
  navStore.setGlobalSearch({ text: '', tags: [] }, { replace: true })
}

function clearDetail() {
  detailQuery = { text: '', tags: [] }
}

function clearFilter() {
  filterQuery = { text: '', tags: [] }
}

function searchByTag(key: string, value: string) {
  navStore.setGlobalSearch(
    { text: '', tags: [{ key, value }] },
    { replace: false, closeDetail: true }
  )
}

function handleLibraryUpdates(updatedItems: any[]) {
  const patchArray = (arr: SearchIndexEntry[]) => {
    let changed = false
    const nextArr = [...arr]
    for (const updated of updatedItems) {
      for (let i = 0; i < nextArr.length; i++) {
        if (nextArr[i].id === updated.id) {
          nextArr[i] = {
            ...nextArr[i],
            ...updated,
            title: updated.title ?? updated.name ?? nextArr[i].title,
            posterPath: updated.posterPath ?? nextArr[i].posterPath
          }
          changed = true
        }
      }
    }
    return changed ? nextArr : null
  }

  const nextGlobal = patchArray(searchResults)
  if (nextGlobal) searchResults = nextGlobal

  const nextDetail = patchArray(detailResults)
  if (nextDetail) detailResults = nextDetail
}

// --- Exported Store Object ---

export const searchStore = {
  get globalQuery() {
    return navStore.state.globalQuery
  },
  set globalQuery(v) {
    // This setter is mainly for svelte bindings (bind:query)
    navStore.setGlobalSearch(v, { closeDetail: true })
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
  searchByTag,
  handleLibraryUpdates
}
