import { api } from './api'
import { navStore } from './navigation-store.svelte'
import { isTypingTag as isTypingTagHelper, resultButton } from './view-helpers'
import type { SearchIndexEntry, SearchPage, SearchQuery, SearchRequest } from '@shared/types'
import { serializeSearchQuery } from './search-query-helpers'

// --- State (Local-only search views) ---

let searchResults = $state<SearchIndexEntry[]>([])
let globalSearchTotal = $state<number | null>(0)
let highlightedGlobalIndex = $state<number | null>(null)
let isPerformingGlobalSearch = $state(false)
let globalSearchError = $state(false)

let detailQuery = $state<SearchQuery>({ text: '', tags: [] })
let detailResults = $state<SearchIndexEntry[]>([])
let highlightedDetailIndex = $state<number | null>(null)
let isPerformingDetailSearch = $state(false)
let detailSearchError = $state(false)

let filterQuery = $state<SearchQuery>({ text: '', tags: [] })
let isFilterBarVisible = $state(false)
let filterFocusKey = $state(0)

// --- Derived ---

const isGlobalActive = $derived(navStore.isGlobalSearchActive)
const isTypingGlobalTag = $derived(isTypingTagHelper(navStore.globalQuery.text))

const isDetailActive = $derived(detailQuery.text.trim() !== '' || detailQuery.tags.length > 0)
const isTypingDetailTag = $derived(isTypingTagHelper(detailQuery.text))

// --- Search Helpers ---

async function runSearch(query: SearchRequest): Promise<SearchPage> {
  const { items, total } = await api.performSearch(query)
  const seen = new Set<string>()
  const results = items.filter((r) => {
    if (seen.has(r.id)) return false
    seen.add(r.id)
    return true
  })
  return { items: results, total }
}

function scheduleSearch(
  query: SearchRequest,
  onSuccess: (page: SearchPage) => void,
  onError: () => void
) {
  let cancelled = false
  const timer = setTimeout(async () => {
    try {
      const results = await runSearch(query)
      if (!cancelled) onSuccess(results)
    } catch {
      if (!cancelled) onError()
    }
  }, 100)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}

// --- Search Effects ---
let lastSerializedQuery = ''

export function initializeSearchEffects() {
  // --- Global Search: Sync and Perform ---
  $effect(() => {
    // Atomic access to globalQuery to track all changes
    const query = navStore.globalQuery
    const serialized = serializeSearchQuery(query)

    // Search inputs edit the query in place, so the URL catches up here.
    if (navStore.isSearchOpen && serialized !== (new URLSearchParams(window.location.search).get('q') ?? '')) {
      navStore.setGlobalSearch(query)
    }

    if (!isGlobalActive) {
      searchResults = []
      globalSearchTotal = 0
      isPerformingGlobalSearch = false
      globalSearchError = false
      highlightedGlobalIndex = null
      lastSerializedQuery = ''
      return
    }
    if (isTypingGlobalTag || serialized === lastSerializedQuery) {
      isPerformingGlobalSearch = false
      return
    }

    isPerformingGlobalSearch = true
    globalSearchError = false
    return scheduleSearch({ ...$state.snapshot(query), includeTotal: true }, ({ items, total }) => {
      lastSerializedQuery = serialized
      globalSearchTotal = total
      searchResults = items
      isPerformingGlobalSearch = false
    }, () => {
      searchResults = []
      globalSearchTotal = 0
      isPerformingGlobalSearch = false
      globalSearchError = true
      lastSerializedQuery = ''
    })
  })

  $effect(() => {
    if (!navStore.selectedItemId || !isDetailActive || isTypingDetailTag) {
      isPerformingDetailSearch = false
      if (!isDetailActive) {
        detailResults = []
        highlightedDetailIndex = null
        detailSearchError = false
      }
      return
    }

    isPerformingDetailSearch = true
    detailSearchError = false
    return scheduleSearch($state.snapshot(detailQuery), ({ items: results }) => {
      detailResults = results
      isPerformingDetailSearch = false
      highlightedDetailIndex = results.length > 0 ? 0 : null
    }, () => {
      detailResults = []
      highlightedDetailIndex = null
      isPerformingDetailSearch = false
      detailSearchError = true
    })
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
    if (navStore.selectedItemId || isGlobalActive) {
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
    void navStore.currentFolderId
    if (!isGlobalActive) {
      filterQuery = { text: '', tags: [] }
    }
  })
}

// --- Methods ---

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


function handleResultKeys(
  event: KeyboardEvent,
  scope: 'library' | 'title',
  input: HTMLInputElement | undefined,
  onSelect: (item: SearchIndexEntry) => void
) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const { target, currentTarget: root } = event
  if (!(target instanceof HTMLElement) || !(root instanceof HTMLElement)) return
  const fromInput = target === input
  const focusedResult = target.closest<HTMLElement>('[data-media-item-id]')
  if (!fromInput && !focusedResult && target !== root) return

  const global = scope === 'library'
  const items = global ? searchResults : detailResults
  if (items.length === 0) return
  const index = global ? highlightedGlobalIndex : highlightedDetailIndex

  if (event.key === 'Enter' && fromInput) {
    if (index !== null && items[index]) {
      event.preventDefault()
      onSelect(items[index])
    }
    return
  }

  const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
  if (direction === 0) return
  const focusedIndex = focusedResult ? items.findIndex(({ id }) => id === focusedResult.dataset.mediaItemId) : -1
  const current = focusedIndex >= 0 ? focusedIndex : index
  const next = current === null ? (direction > 0 ? 0 : items.length - 1) : (current + direction + items.length) % items.length
  const button = resultButton(root, items[next].id)
  if (!button) return

  event.preventDefault()
  if (!fromInput) button.focus()
  if (global) highlightedGlobalIndex = next
  else highlightedDetailIndex = next
}

export const searchStore = {
  get globalQuery() {
    return navStore.globalQuery
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
  get globalSearchTotal() {
    return globalSearchTotal
  },
  get highlightedGlobalIndex() {
    return highlightedGlobalIndex
  },
  set highlightedGlobalIndex(v) {
    highlightedGlobalIndex = v
  },
  get globalSearchError() {
    return globalSearchError
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
  get detailSearchError() {
    return detailSearchError
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

  handleResultKeys,
  clearDetail,
  clearFilter,
  searchByTag,
  handleLibraryUpdates
}
