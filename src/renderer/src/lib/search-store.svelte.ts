import { api } from './api'
import { navStack } from './navigation-store.svelte'
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

// --- Register with Navigation Store ---
navStack.registerSearchInterface({
    getQuery: () => globalQuery,
    setQuery: (q) => { globalQuery = q },
    isRestoring: false
})

// --- Search Effects (Global Logic) ---

// In Svelte 5, these effects will run as long as the store is imported in a component context.

export function initializeSearchEffects() {
    // --- Global Search Effect ---
    $effect(() => {
        const query = globalQuery
        
        if (isGlobalActive && !isTypingGlobalTag) {
            // Clear detail view before updating history so the snapshot doesn't include the item.
            // This ensures that if we "back" into this search state later, we don't accidentally restore the detail view on top.
            if (navStack.selectedItemForDetailView) {
                navStack.selectedItemForDetailView = null
            }
        }

        // Notify navigation stack about query changes to update history
        // This relies on the 'isTypingTag' check internally in the UI, but here we just pass the raw query state.
        // We only want to update history if it's not a temporary typing state (like trailing colon), 
        // but 'globalQuery' is usually bound directly. 
        // We can check if it's valid for search.
        if (!isTypingGlobalTag) {
            navStack.handleSearchUpdate(JSON.parse(JSON.stringify(query)))
        }

        if (isGlobalActive && !isTypingGlobalTag) {
            isPerformingGlobalSearch = true
            // navStack.selectedItemForDetailView = null // Already cleared above
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
        if (navStack.selectedItemForDetailView && isDetailActive && !isTypingDetailTag) {
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
        if (navStack.selectedItemForDetailView || isGlobalActive) {
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
        // This is a bit of a trick to detect navigation
        void navStack.currentFolder?.id
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
    navStack.handleSearchByTag(key, value)
    globalQuery = { text: '', tags: [{ key, value }] }
}

// --- Exported Store Object ---

export const searchStore = {
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
