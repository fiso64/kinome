<script lang="ts">
  import WindowControls from './WindowControls.svelte'
  import SearchInput from '../ui/SearchInput.svelte'
  import MediaView from './MediaView.svelte'
  import { createEventDispatcher } from 'svelte'

  let {
    canGoBack,
    isDetailViewActive,
    isGlobalSearchActive,
    currentFolder,
    isRefreshing,
    isScanning,
    isContextMenuVisible,
    folderToConfigureLayout,
    suggestions,
    isPerformingGlobalSearch,
    globalSearchResults,
    isPerformingDetailSearch,
    detailSearchResults,
    isDetailSearchActive,
    // Bindings
    globalSearchQuery = $bindable(),
    detailViewSearchQuery = $bindable(),
    highlightedGlobalSearchItemIndex = $bindable(),
    highlightedDetailSearchItemIndex = $bindable(),
    settings
  }: {
    canGoBack: boolean
    isDetailViewActive: boolean
    isGlobalSearchActive: boolean
    currentFolder: MediaFolder | null
    isRefreshing: boolean
    isScanning: boolean
    isContextMenuVisible: boolean
    folderToConfigureLayout: MediaFolder | null
    suggestions: AutocompleteSuggestions
    isPerformingGlobalSearch: boolean
    globalSearchResults: SearchIndexEntry[]
    isPerformingDetailSearch: boolean
    detailSearchResults: SearchIndexEntry[]
    isDetailSearchActive: boolean
    // Bindings
    globalSearchQuery: { text: string; tags: { key: string; value: string }[] }
    detailViewSearchQuery: { text: string; tags: { key: string; value: string }[] }
    highlightedGlobalSearchItemIndex: number | null
    highlightedDetailSearchItemIndex: number | null
    settings: Settings | null
  } = $props()

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

  function handleSearchKeyDown(event: KeyboardEvent) {
    const autocompleteMenu = document.querySelector('.autocomplete-menu')
    if (autocompleteMenu && autocompleteMenu.contains(event.target as Node)) {
      return // Let autocomplete handle its own keyboard events
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      dispatch('back')
      return
    }

    const isDetailContext = isDetailViewActive
    const items = isDetailContext ? detailSearchResults : globalSearchResults
    let highlightedIndex = isDetailContext
      ? highlightedDetailSearchItemIndex
      : highlightedGlobalSearchItemIndex

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
        highlightedDetailSearchItemIndex = newIndex
      } else {
        highlightedGlobalSearchItemIndex = newIndex
      }
    }
  }

  $effect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const searchContainer = document.querySelector('.search-container')
      if (searchContainer && !searchContainer.contains(event.target as Node)) {
        detailViewSearchQuery = { text: '', tags: [] }
      }
    }
    if (isDetailViewActive && isDetailSearchActive) {
      window.addEventListener('click', handleClickOutside, { capture: true })
    }
    return () => {
      window.removeEventListener('click', handleClickOutside, { capture: true })
    }
  })

  // Export a method to be called from the parent.
  // This is how we can manage focus from a parent component.
  export function focusSearchInput() {
    searchInputEl?.focus()
    searchInputEl?.select()
  }

  const searchPopupParentItem = $derived(
    settings
      ? ({
          id: 'search-popup-view',
          name: 'Search Popup',
          type: 'folder',
          path: '',
          children: [],
          ...settings.searchPopupView
        } as MediaFolder)
      : undefined
  )
</script>

<header class:in-detail-view={isDetailViewActive}>
  <div class="header-content" class:no-drag={isContextMenuVisible}>
    <div class="header-left">
      <button
        class="back-button"
        class:hidden={!canGoBack}
        onclick={() => dispatch('back')}
        title="Go back"
      >
        ←
      </button>
      <!-- In detail view, the title is handled by the component itself -->
      {#if !isDetailViewActive}
        <h1>
          {#if isGlobalSearchActive}
            Search Results
          {:else}
            {currentFolder?.title ?? currentFolder?.name ?? 'Media Browser'}
          {/if}
        </h1>
      {/if}
    </div>

    <div class="search-container" onkeydown={handleSearchKeyDown}>
      {#if isDetailViewActive}
        <SearchInput
          bind:query={detailViewSearchQuery}
          {suggestions}
          bind:element={searchInputEl}
        />
      {:else}
        <SearchInput bind:query={globalSearchQuery} {suggestions} bind:element={searchInputEl} />
      {/if}

      {#if isDetailViewActive && (isDetailSearchActive || isPerformingDetailSearch)}
        <div class="search-dropdown">
          {#if isPerformingDetailSearch && detailSearchResults.length === 0}
            <div class="dropdown-status">Searching...</div>
          {:else if detailSearchResults.length > 0}
            <MediaView
              items={detailSearchResults}
              parentItem={searchPopupParentItem}
              onItemClick={(item) => dispatch('detailSearchItemClick', { item })}
              onShowContextMenu={(item, e) => dispatch('showContextMenu', { item, event: e })}
              highlightedIndex={highlightedDetailSearchItemIndex}
              isPreSorted={true}
              grayOutWatched={false}
              {settings}
              listFixedAspectRatio={true}
            />
          {:else if !isPerformingDetailSearch}
            <div class="dropdown-status">No results found.</div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="header-right">
      {#if !isDetailViewActive}
        <button
          onclick={() => dispatch('refresh')}
          disabled={isRefreshing || isScanning}
          title="Refresh Library (F5)"
          class="refresh-button"
        >
          <span class:reloading={isRefreshing}>⟳</span>
        </button>
      {/if}
      {#if folderToConfigureLayout}
        <button
          onclick={() => dispatch('openLayoutSelector')}
          title="Set View Layout"
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
          onclick={(e) => dispatch('showContextMenu', { item: folderToConfigureLayout!, event: e })}
          title="More options..."
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
  <WindowControls />
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
    display: inline-block;
    animation: spin 1s linear infinite;
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
