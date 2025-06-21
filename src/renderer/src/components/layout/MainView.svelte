<script lang="ts">
  import MediaView from './MediaView.svelte'
  import ItemDetail from './ItemDetail.svelte'
  import { createEventDispatcher } from 'svelte'

  let {
    isScanning,
    currentFolder,
    isGlobalSearchActive,
    searchResults,
    isPerformingSearch,
    highlightedSearchItemIndex,
    selectedItemForDetailView,
    filterQuery,
    suggestions,
    settings
  }: {
    isScanning: boolean
    currentFolder: MediaFolder | null
    isGlobalSearchActive: boolean
    searchResults: SearchIndexEntry[]
    isPerformingSearch: boolean
    highlightedSearchItemIndex: number | null
    selectedItemForDetailView: LibraryItem | null
    filterQuery: { text: string; tags: { key: string; value: string }[] }
    suggestions: AutocompleteSuggestions
    settings: Settings | null
  } = $props()

  const dispatch = createEventDispatcher<{
    scanLibrary: void
    itemClick: { item: LibraryItem | SearchIndexEntry }
    showContextMenu: {
      item: LibraryItem | SearchIndexEntry
      event: MouseEvent
      options?: { layout?: string }
    }
    searchByTag: { key: string; value: string }
  }>()
</script>

<div class="content">
  {#if isScanning}
    <!-- Loading state is now implicitly handled by App.svelte's logic -->
  {:else if !currentFolder && !isGlobalSearchActive}
    <div class="welcome-screen">
      <h2>Welcome to Media Browser</h2>
      <p>To get started, scan a folder containing your media.</p>
      <button onclick={() => dispatch('scanLibrary')}>Select Media Folder</button>
    </div>
  {:else}
    <div class="main-view-container" class:hidden={selectedItemForDetailView}>
      <!-- SEARCH VIEW: Rendered but hidden via CSS unless active -->
      <div class="view-wrapper" class:hidden={!isGlobalSearchActive}>
        <div class="search-header">
          {#if isPerformingSearch}
            <span>Searching...</span>
          {:else}
            <span>Found {searchResults.length} results.</span>
          {/if}
        </div>
        <div class="search-content-wrapper">
          {#if searchResults.length > 0}
            <MediaView
              items={searchResults}
              onItemClick={(item) => dispatch('itemClick', { item })}
              layout="list"
              onShowContextMenu={(item, e, options) =>
                dispatch('showContextMenu', { item, event: e, options })}
              suggestions={suggestions}
              highlightedIndex={highlightedSearchItemIndex}
              isPreSorted={true}
              grayOutWatched={false}
            />
          {:else if !isPerformingSearch}
            <p class="status-text">No results found.</p>
          {/if}
        </div>
      </div>

      <!-- FOLDER VIEW: Rendered but hidden via CSS unless active -->
      {#if currentFolder}
        <div class="view-wrapper" class:hidden={isGlobalSearchActive}>
          <div class="folder-content-wrapper">
            <MediaView
              parentItem={currentFolder}
              items={currentFolder.children}
              searchQuery={filterQuery}
              onItemClick={(item) => dispatch('itemClick', { item })}
              onShowContextMenu={(item, e, options) =>
                dispatch('showContextMenu', { item, event: e, options })}
              suggestions={suggestions}
              {settings}
            />
          </div>
        </div>
      {/if}
    </div>

    {#if selectedItemForDetailView && settings}
      <ItemDetail
        item={selectedItemForDetailView}
        onItemClick={(item) => dispatch('itemClick', { item })}
        onSearchByTag={({ key, value }) => dispatch('searchByTag', { key, value })}
        showContextMenu={(item, event, options) =>
          dispatch('showContextMenu', { item, event, options })}
        {settings}
      />
    {/if}
  {/if}
</div>

<style>
  .content {
    flex-grow: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    scrollbar-gutter: stable;
    position: relative; /* Needed for the absolute positioned detail view */
  }

  .main-view-container {
    display: flex;
    flex-direction: column;
    flex: 1;
    position: relative; /* For stacking contexts */
  }
  .main-view-container.hidden {
    visibility: hidden;
  }

  .view-wrapper {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .view-wrapper.hidden {
    visibility: hidden;
  }

  .folder-content-wrapper,
  .search-content-wrapper {
    flex-grow: 1;
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  .search-content-wrapper :global(.media-list) {
    max-width: 1000px;
    margin: 0 auto;
  }

  .search-header {
    padding: 0.5rem 1.5rem;
    font-style: italic;
    color: var(--ev-c-text-2);
    border-bottom: 1px solid var(--color-background-mute);
    flex-shrink: 0;
  }

  .welcome-screen,
  .status-text {
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 1rem;
    padding: 2rem;
    text-align: center;
  }

  .welcome-screen button {
    flex-shrink: 0;
  }
</style>