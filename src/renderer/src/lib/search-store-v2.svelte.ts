
import { api } from './api'
import { navStoreV2 } from './navigation-store-v2.svelte'
import { isTypingTag as isTypingTagHelper } from './view-helpers'
import type { SearchIndexEntry } from '../../../shared/types'

// --- Types ---

export interface SearchQuery {
    text: string
    tags: { key: string; value: string }[]
}

// --- State ---

let globalQuery = $state<SearchQuery>({ text: '', tags: [] })
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

const isGlobalActive = $derived(globalQuery.text.trim() !== '' || globalQuery.tags.length > 0)
const isTypingGlobalTag = $derived(isTypingTagHelper(globalQuery.text))

const isDetailActive = $derived(detailQuery.text.trim() !== '' || detailQuery.tags.length > 0)
const isTypingDetailTag = $derived(isTypingTagHelper(detailQuery.text))


// --- Search Effects (Global Logic) ---

export function initializeSearchEffects() {
    // --- Global Search Effect ---
    $effect(() => {
        const query = globalQuery

        if (isGlobalActive && !isTypingGlobalTag) {
            // Close detail view via V2 store
            if (navStoreV2.state.selectedItemId) {
                navStoreV2.closeDetail()
            }
        }

        // TODO: Navigation store history update for search?
        // In V2, we might store search query in URL params too? 
        // navStoreV2 currently parses folder/item/modal. It doesn't handle search params yet.
        // For now, we skip history sync for search, or add it to navStoreV2.

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
        } else if (!isDetailActive) {
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
        // Trigger on folder change
        void navStoreV2.state.currentFolderId
        if (!isGlobalActive) {
            filterQuery = { text: '', tags: [] }
        }
    })
}

// --- Methods ---

function clearGlobal() {
    globalQuery = { text: '', tags: [] }
}

function clearDetail() {
    detailQuery = { text: '', tags: [] }
}

function clearFilter() {
    filterQuery = { text: '', tags: [] }
}

function searchByTag(key: string, value: string) {
    // Navigate to search results (root) logic is slightly different in V2.
    // If we are deep, maybe we stay there? 
    // Usually searching jumps to "Global Search" mode.
    globalQuery = { text: '', tags: [{ key, value }] }
}

// --- Exported Store Object ---

export const searchStoreV2 = {
    get globalQuery() { return globalQuery },
    set globalQuery(v) { globalQuery = v },
    get isGlobalActive() { return isGlobalActive },
    get searchResults() { return searchResults },
    set searchResults(v) { searchResults = v },
    get highlightedGlobalIndex() { return highlightedGlobalIndex },
    set highlightedGlobalIndex(v) { highlightedGlobalIndex = v },
    get isPerformingGlobalSearch() { return isPerformingGlobalSearch },

    get detailQuery() { return detailQuery },
    set detailQuery(v) { detailQuery = v },
    get isDetailActive() { return isDetailActive },
    get detailResults() { return detailResults },
    set detailResults(v) { detailResults = v },
    get highlightedDetailIndex() { return highlightedDetailIndex },
    set highlightedDetailIndex(v) { highlightedDetailIndex = v },
    get isPerformingDetailSearch() { return isPerformingDetailSearch },

    get filterQuery() { return filterQuery },
    set filterQuery(v) { filterQuery = v },
    get isFilterBarVisible() { return isFilterBarVisible },
    set isFilterBarVisible(v) { isFilterBarVisible = v },
    get filterFocusKey() { return filterFocusKey },
    set filterFocusKey(v) { filterFocusKey = v },

    clearGlobal,
    clearDetail,
    clearFilter,
    searchByTag
}
