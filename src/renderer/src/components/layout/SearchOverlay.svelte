<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { searchStore } from '@lib/search-store.svelte'
  import { scrollPersistence } from '@lib/scroll-persistence.svelte'
  import { getViewKey } from '@lib/view-state-store.svelte'
  import ViewContextProvider from './ViewContextProvider.svelte'
  import MediaView from './MediaView.svelte'
  import Icon from '@components/ui/Icon.svelte'
  import SearchInput from '@components/ui/SearchInput.svelte'
  import Skeleton from '@components/ui/Skeleton.svelte'
  import type { AutocompleteSuggestions, Settings, LibraryItem, SearchIndexEntry, MediaFolder } from '@shared/types'

  let {
    settings,
    suggestions,
    onClose,
    disabled = false
  }: {
    settings: Settings | null
    suggestions: AutocompleteSuggestions
    onClose: () => void
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

  let inputElement = $state<HTMLInputElement>()

  export function focusSearchInput() {
    inputElement?.focus({ preventScroll: true })
    inputElement?.select()
  }

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
    id="library-search"
    use:scrollPersistence={{
      key: getViewKey('vertical'),
      resetOn: searchStore.globalQuery.text,
      disabled
    }}
  >
    <header class="search-header">
      <div class="search-heading">
        <h1>Search library</h1>
        <button class="icon-button" type="button" aria-label="Close search" title="Close search" onclick={onClose}>
          <Icon name="close" size={20} />
        </button>
      </div>
      <div class="search-field" role="search"
        onkeydown={(event) => searchStore.handleResultKeys(event, 'library', (item) => dispatch('itemClick', { item }))}>
        <SearchInput bind:query={searchStore.globalQuery} {suggestions} bind:element={inputElement} />
      </div>
      {#if searchStore.isGlobalActive}
        <span class="result-count" role="status">
          {#if isPerformingSearch}
            Searching...
          {:else if searchStore.globalSearchError}
            Search failed
          {:else}
            {searchResults.length} {searchResults.length === 1 ? 'result' : 'results'}
          {/if}
        </span>
      {/if}
    </header>
    <div class="search-content-wrapper" aria-busy={isPerformingSearch}>
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
      {:else if isPerformingSearch}
        <div class="skeleton-list">
          {#each [0.6, 0.8, 0.5, 0.75, 0.65] as widthRatio}
            <div class="skeleton-row">
              <Skeleton width="60px" height="90px" radius="4px" />
              <div class="skeleton-text">
                <Skeleton width="{widthRatio * 100}%" height="1.2rem" />
                <Skeleton width="40%" height="0.9rem" />
              </div>
            </div>
          {/each}
        </div>
      {:else if searchStore.globalSearchError}
        <p class="status-text">Could not load results. Edit the search to try again.</p>
      {:else if searchStore.isGlobalActive}
        <div class="status-text">
          <p>{searchStore.globalQuery.text.trim() ? `No results for "${searchStore.globalQuery.text}"` : 'No results match these filters.'}</p>
        </div>
      {/if}
    </div>
  </div>
</ViewContextProvider>

<style>
  .view-wrapper {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-gutter: stable;
    background: var(--color-background);
    z-index: 2;
    padding: clamp(1.1rem, 3vw, 2.6rem) clamp(.9rem, 3.2vw, 3rem) 4rem;
  }
  .search-header, .search-content-wrapper { width: min(100%, 70rem); margin-inline: auto; }
  .search-header {
    display: grid;
    gap: .8rem;
    border-bottom: 1px solid var(--color-border-soft);
    padding-bottom: .8rem;
    margin-bottom: .9rem;
  }
  .search-heading { display: flex; align-items: center; justify-content: space-between; gap: .7rem; }
  .search-heading h1 { font-size: clamp(1.55rem, 3.7vw, 2.85rem); font-weight: 710; letter-spacing: -.04em; line-height: 1.1; }
  .result-count, .status-text { color: var(--color-text-soft); font-size: .875rem; }
  .status-text { padding: 2rem 0; overflow-wrap: anywhere; }
  .skeleton-list { display: grid; gap: .5rem; }
  .skeleton-row { display: flex; gap: .9rem; align-items: flex-start; padding: .7rem; background: var(--surface-raised); border: 1px solid var(--color-border-soft); border-radius: 11px; }
  .skeleton-text { display: grid; align-content: start; flex: 1; gap: .55rem; padding-top: .3rem; }
</style>
