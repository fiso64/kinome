<script lang="ts">
  import WindowControls from './WindowControls.svelte'
  import SearchInput from '../ui/SearchInput.svelte'
  import MediaView from './MediaView.svelte'
  import { createEventDispatcher } from 'svelte'
  import { navStore } from '@lib/navigation-store.svelte'
  import { searchStore } from '@lib/search-store.svelte'
  import { api } from '@lib/api'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import type {
    Settings,
    MediaFolder,
    LibraryItem,
    SearchIndexEntry,
    AutocompleteSuggestions
  } from '@shared/types'

  let {
    isWaitingForScan,
    isScanning,
    isContextMenuVisible,
    settings,
    suggestions
  }: {
    isWaitingForScan: boolean
    isScanning: boolean
    isContextMenuVisible: boolean
    settings: Settings | null
    suggestions: AutocompleteSuggestions
  } = $props()

  // --- V2 State ---
  const canGoBack = $derived(navStore.canGoBack)

  // Fetch Context Item for Configuration (Folder or Detail Item)
  const contextItemQuery = libraryDataService.getItemDetailsQuery(() => navStore.contextItemId)

  const contextItem = $derived(contextItemQuery.data as MediaFolder | LibraryItem | undefined)

  // Search properties from store
  const isGlobalSearchActive = $derived(searchStore.isGlobalActive)
  const globalSearchResults = $derived(searchStore.searchResults)
  const isPerformingDetailSearch = $derived(searchStore.isPerformingDetailSearch)
  const detailSearchResults = $derived(searchStore.detailResults)

  // Layout Config Logic (Simplified: prioritize detail item, fallback to folder)
  const contextItemToConfigure = $derived(contextItem)

  // --- Search Bindings ---
  // In V2, we bind directly to the store objects?
  // Or we use the store's getters/setters.
  // Using $bindable on props implies parent control.
  // Here we want local control synced to store.

  // We can just use the store properties directly in the template if they are mutable Runes?
  // searchStoreV2 properties like globalQuery are get/set accessors to a Rune.
  // So binding `bind:query={searchStoreV2.globalQuery}` works if the component accepts binding.

  const dispatch = createEventDispatcher<{
    back: void
    refresh: void
    openSettings: void
    openLayoutSelector: void
    showContextMenu: { item: LibraryItem; event: MouseEvent }
    globalSearchItemClick: { item: SearchIndexEntry }
    detailSearchItemClick: { item: SearchIndexEntry }
  }>()

  let searchInputEl = $state<HTMLInputElement | undefined>(undefined)
  let isSearchFocused = $state(false)

  function handleSearchBlur(event: FocusEvent) {
    // We need to query for the dropdown element inside the handler,
    // as it might not exist in the DOM when the component first mounts.
    const dropdown = document.querySelector('.search-dropdown')

    // If the element that is receiving focus next is inside the dropdown,
    // don't hide the dropdown. This allows clicks on dropdown items to work.
    if (dropdown && event.relatedTarget && dropdown.contains(event.relatedTarget as Node)) {
      return
    }

    // Otherwise, the user has clicked outside or tabbed away, so hide the dropdown immediately.
    isSearchFocused = false
  }

  function handleSearchKeyDown(event: KeyboardEvent) {
    const autocompleteMenu = document.querySelector('.autocomplete-menu')
    if (autocompleteMenu && autocompleteMenu.contains(event.target as Node)) {
      return // Let autocomplete handle its own keyboard events
    }

    const isDetailContext = navStore.isDetailViewActive
    const items = isDetailContext ? detailSearchResults : globalSearchResults
    let highlightedIndex = isDetailContext
      ? searchStore.highlightedDetailIndex
      : searchStore.highlightedGlobalIndex

    if (items.length === 0) return

    let newIndex = highlightedIndex
    let shouldPreventDefault = false

    if (event.key === 'ArrowDown') {
      shouldPreventDefault = true
      if (highlightedIndex === null) {
        newIndex = 0
      } else {
        newIndex = (highlightedIndex + 1) % items.length
      }
    } else if (event.key === 'ArrowUp') {
      shouldPreventDefault = true
      if (highlightedIndex === null || highlightedIndex === 0) {
        newIndex = items.length - 1
      } else {
        newIndex--
      }
    } else if (event.key === 'Enter') {
      shouldPreventDefault = true
      if (highlightedIndex !== null) {
        const selectedResult = items[highlightedIndex]
        if (selectedResult) {
          if (isDetailContext) {
            dispatch('detailSearchItemClick', { item: selectedResult })
          } else {
            dispatch('globalSearchItemClick', { item: selectedResult })
          }
        }
      }
    }

    if (shouldPreventDefault) {
      event.preventDefault()
    }

    if (newIndex !== highlightedIndex) {
      if (isDetailContext) {
        searchStore.highlightedDetailIndex = newIndex
      } else {
        searchStore.highlightedGlobalIndex = newIndex
      }
    }
  }

  // Export a method to be called from the parent.
  // This is how we can manage focus from a parent component.
  export function focusSearchInput() {
    searchInputEl?.focus()
    searchInputEl?.select()
  }

  export function blurSearchInput() {
    searchInputEl?.blur()
  }

  const searchPopupParentItem = $derived(
    settings
      ? ({
          id: 'search-popup-view',
          name: 'Search Popup',
          type: 'folder',
          path: '',
          children: [],
          viewSettings: settings.searchPopupView // Correctly nest under viewSettings
        } as MediaFolder)
      : undefined
  )
</script>

<header class:in-detail-view={navStore.isDetailViewActive}>
  <div class="header-content" class:no-drag={isContextMenuVisible}>
    <div class="header-left">
      <button
        class="back-button"
        class:hidden={!canGoBack}
        onclick={() => navStore.goBack()}
        title="Go back"
      >
        ←
      </button>
      <!-- In detail view, the title is handled by the component itself -->
      {#if !navStore.isDetailViewActive}
        <h1>
          {#if isGlobalSearchActive}
            Search Results
          {:else}
            {contextItem?.title ?? contextItem?.name ?? 'Kinome'}
          {/if}
        </h1>
      {/if}
    </div>

    <div class="search-container" onkeydown={handleSearchKeyDown}>
      {#key navStore.isDetailViewActive}
        {#if navStore.isDetailViewActive}
          <SearchInput
            bind:query={searchStore.detailQuery}
            {suggestions}
            bind:element={searchInputEl}
            onfocus={() => (isSearchFocused = true)}
            onblur={handleSearchBlur}
          />
        {:else}
          <SearchInput
            bind:query={searchStore.globalQuery}
            {suggestions}
            bind:element={searchInputEl}
            onfocus={() => (isSearchFocused = true)}
            onblur={handleSearchBlur}
          />
        {/if}
      {/key}

      {#if isSearchFocused && navStore.isDetailViewActive}
        <div class="search-dropdown">
          {#if isPerformingDetailSearch && detailSearchResults.length === 0}
            <div class="dropdown-status">Searching...</div>
          {:else if detailSearchResults.length > 0}
            <MediaView
              items={detailSearchResults}
              parentItem={searchPopupParentItem}
              onItemClick={(item) => dispatch('globalSearchItemClick', { item: item as any })}
              onShowContextMenu={(item, e) =>
                dispatch('showContextMenu', { item: item as any, event: e })}
              highlightedIndex={searchStore.highlightedDetailIndex}
              isPreSorted={true}
              {settings}
              listFixedAspectRatio={true}
            />
          {:else if !isPerformingDetailSearch && searchStore.detailQuery.text.trim().length > 0}
            <div class="dropdown-status">No results found.</div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="header-right">
      <button
        onclick={() => dispatch('refresh')}
        disabled={isWaitingForScan || isScanning}
        title="Refresh Library (F5)"
        aria-label="Refresh Library"
        class="refresh-button"
      >
        <span class="icon-wrapper" class:reloading={isWaitingForScan || isScanning}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21.5 2v6h-6"></path>
            <path d="M2.5 22v-6h6"></path>
            <path d="M2 11.5a10 10 0 0 1 18.8-4.3L21.5 8"></path>
            <path d="M22 12.5a10 10 0 0 1-18.8 4.3L2.5 16"></path>
          </svg>
        </span>
      </button>
      {#if contextItemToConfigure}
        <button
          onclick={() => dispatch('openLayoutSelector')}
          title="Set View Layout"
          aria-label="Set View Layout"
          class="layout-button"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
            ></rect>
            <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
            ></rect>
            <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
            ></rect>
            <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
            ></rect>
          </svg>
        </button>
        <button
          onclick={(e) => dispatch('showContextMenu', { item: contextItemToConfigure!, event: e })}
          title="More options..."
          aria-label="More options"
          class="more-options-button"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 4 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            ><path
              d="M2 4C3.10457 4 4 3.10457 4 2C4 0.895431 3.10457 0 2 0C0.895431 0 0 0.895431 0 2C0 3.10457 0.895431 4 2 4Z"
              fill="currentColor"
            /><path
              d="M2 10C3.10457 10 4 9.10457 4 8C4 6.89543 3.10457 6 2 6C0.895431 6 0 6.89543 0 8C0 9.10457 0.895431 10 2 10Z"
              fill="currentColor"
            /><path
              d="M2 16C3.10457 16 4 15.1046 4 14C4 12.8954 3.10457 12 2 12C0.895431 12 0 12.8954 0 14C0 15.1046 0.895431 16 2 16Z"
              fill="currentColor"
            /></svg
          >
        </button>
      {/if}
      <button onclick={() => dispatch('openSettings')} title="Settings" class="settings-button"
        >⚙️</button
      >
    </div>
  </div>
  {#if api.capabilities.hasWindowControls}
    <WindowControls />
  {/if}
</header>

<style>
  .search-container {
    display: flex;
    justify-content: center;
    min-width: 0; /* Let the child dictate min-width */
    position: relative;
  }

  .search-dropdown {
    position: absolute;
    top: calc(100% + 5px); /* Position below the search input */
    left: 0;
    right: 0;
    z-index: 200;
    background-color: var(--color-background-soft);
    border: 1px solid var(--color-background-mute);
    border-radius: 8px;
    box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
    /* The height is calculated to show roughly 5 items.
       We cap this with 70vh to ensure it fits on smaller screens. */
    max-height: min(40rem, 70vh);
    overflow-y: auto;
  }
  .search-dropdown :global(.media-list) {
    padding: 0.5rem;
  }
  .dropdown-status {
    padding: 2rem;
    text-align: center;
    color: var(--ev-c-text-2);
  }

  header {
    display: flex;
    border-bottom: 1px solid var(--color-background-mute);
    height: var(--header-height);
    flex-shrink: 0;
    transition: background-color 0.3s ease;
    position: relative;
    z-index: 10;
  }

  header.in-detail-view {
    background-color: transparent;
    border-bottom: none;
  }

  .header-content {
    flex-grow: 1;
    display: grid;
    grid-template-columns: 1fr minmax(auto, 1000px) 1fr;
    align-items: center;
    gap: 1.5rem;
    padding: 0 1.5rem;
    -webkit-app-region: drag;
  }

  .header-left,
  .header-right {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .header-left {
    overflow: hidden; /* For long folder names */
    justify-self: start;
  }

  .header-right {
    justify-self: end;
  }

  h1 {
    font-size: 1.2rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .back-button,
  .refresh-button,
  .layout-button,
  .more-options-button,
  .settings-button {
    width: 36px;
    height: 36px;
    padding: 0;
    font-size: 1.2rem;
    line-height: 1;
    display: inline-flex;
    justify-content: center;
    align-items: center;
    flex-shrink: 0;
  }

  .settings-button,
  .layout-button,
  .more-options-button {
    background-color: var(--ev-button-alt-bg);
    color: var(--ev-c-text-1);
  }

  .back-button.hidden {
    visibility: hidden;
  }

  .reloading {
    display: flex;
    animation: spin 1s linear infinite;
  }
  .icon-wrapper {
    display: flex;
    justify-content: center;
    align-items: center;
  }
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .header-content.no-drag {
    -webkit-app-region: no-drag;
  }
</style>
