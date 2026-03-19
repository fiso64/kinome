<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { searchStore } from '@lib/search-store.svelte'
  import { scrollPersistence } from '@lib/scroll-persistence.svelte'
  import { getViewKey } from '@lib/view-state-store.svelte'
  import ViewContextProvider from './ViewContextProvider.svelte'
  import MediaView from './MediaView.svelte'
  import type { Settings, LibraryItem, SearchIndexEntry, MediaFolder } from '@shared/types'

  let {
    settings,
    suggestions,
    disabled = false
  }: {
    settings: Settings | null
    suggestions: any
    disabled?: boolean
  } = $props()

  const dispatch = createEventDispatcher<{
    itemClick: { item: LibraryItem | SearchIndexEntry }
    showContextMenu: {
      item: LibraryItem | SearchIndexEntry
      event: MouseEvent
      options?: { layout?: string }
    }
  }>()

  const searchResults = $derived(searchStore.searchResults)
  const isPerformingSearch = $derived(searchStore.isPerformingGlobalSearch)
  const highlightedSearchItemIndex = $derived(searchStore.highlightedGlobalIndex)

  const searchParentItem = $derived(
    settings
      ? ({
          id: 'search-view',
          name: 'Search',
          type: 'folder',
          path: '',
          children: [],
          viewSettings: settings.searchResultView
        } as MediaFolder)
      : undefined
  )
</script>

<ViewContextProvider id="search">
  <div
    class="view-wrapper"
    use:scrollPersistence={{
      key: getViewKey('vertical'),
      resetOn: searchStore.globalQuery.text,
      disabled
    }}
  >
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
          parentItem={searchParentItem}
          onShowContextMenu={(item, e, options) =>
            dispatch('showContextMenu', { item, event: e, options })}
          {suggestions}
          highlightedIndex={highlightedSearchItemIndex}
          {settings}
          listFixedAspectRatio={true}
        />
      {:else if !isPerformingSearch}
        <div class="status-text">
          <p>No results found for "{searchStore.globalQuery.text}"</p>
        </div>
      {/if}
    </div>
  </div>
</ViewContextProvider>

<style>
  .view-wrapper {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    scrollbar-gutter: stable;
    background-color: var(--color-background);
    z-index: 2;
  }

  .search-content-wrapper {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
    width: 100%;
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 4rem 4rem 4rem;
  }

  .search-header {
    width: 100%;
    max-width: 1200px;
    margin: 0 auto;
    padding: 1.5rem 4rem;
    font-size: 1.2rem;
    font-weight: 600;
    color: var(--ev-c-text-1);
    border-bottom: 1px solid var(--color-background-mute);
    margin-bottom: 2rem;
    flex-shrink: 0;
  }

  .status-text {
    flex-grow: 1;
    display: flex;
    justify-content: center;
    align-items: center;
    color: var(--ev-c-text-2);
    font-size: 1.1rem;
  }
</style>
