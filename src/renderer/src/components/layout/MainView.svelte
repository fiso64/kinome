<script lang="ts">
  import MediaView from './MediaView.svelte'
  import ItemDetail from './ItemDetail.svelte'
  import HomeView from './HomeView.svelte'
  import SetupScreen from './SetupScreen.svelte'
  import { createEventDispatcher } from 'svelte'

  import { navStore } from '@lib/navigation-store.svelte'
  import { searchStore } from '@lib/search-store.svelte'
  import { api } from '@lib/api'
  import { resolveViewSettings } from '@shared/settings-helpers'
  import { getAllRequiredFields } from '@lib/view-requirements'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import { authStore } from '@lib/auth-store.svelte'

  import type {
    Settings,
    LibraryItem,
    MediaFolder,
    MediaFile,
    SearchIndexEntry,
    LibraryStatus,
    ScanStatus,
    ViewHierarchyNode
  } from '@shared/types'

  let {
    settings,
    isScanning,
    libraryStatus,
    suggestions,
    onStatusUpdate
  }: {
    settings: Settings | null
    isScanning: boolean
    libraryStatus: LibraryStatus | null
    suggestions: any
    onStatusUpdate?: () => void
  } = $props()

  // --- V2 State ---

  // 1. Current Folder & Children
  const currentFolderId = $derived(navStore.state.currentFolderId)

  const currentFolderQuery = libraryDataService.getItemDetailsQuery(() => currentFolderId, {
    enabled: () => libraryStatus?.status === 'ready',
    include: () => ['viewHierarchy']
  })

  const currentFolder = $derived(currentFolderQuery.data as (LibraryItem & MediaFolder) | undefined)

  // 1b. Resolve Layout & View Requirements
  // We need to know the layout to know which fields to fetch (e.g. 'overview' for list view).
  const resolvedSettings = $derived(resolveViewSettings(currentFolder, settings).settings)
  // We need to know the layout to know which fields to fetch.

  const requiredFields = $derived.by(() => {
    return getAllRequiredFields(currentFolder?.viewHierarchy)
  })

  const childrenQuery = libraryDataService.getChildrenQuery(() => currentFolderId, {
    fields: () => requiredFields,
    groupBy: () => resolvedSettings.groupBy,
    enabled: () => libraryStatus?.status === 'ready'
  })

  const children = $derived((childrenQuery.data as LibraryItem[]) ?? [])

  const continueWatchingQuery = libraryDataService.getContinueWatchingQuery({
    enabled: () =>
      !!settings?.showContinueWatching &&
      !!authStore.isAuthenticated &&
      libraryStatus?.status === 'ready'
  })

  const continueWatchingItems = $derived(continueWatchingQuery.data ?? [])

  // 2. Search
  const isGlobalSearchActive = $derived(searchStore.isGlobalActive)
  const isPerformingSearch = $derived(searchStore.isPerformingGlobalSearch)
  const searchResults = $derived(searchStore.searchResults)
  const highlightedSearchItemIndex = $derived(searchStore.highlightedGlobalIndex)
  const filterQuery = $derived(searchStore.filterQuery)

  // 3. Detail View
  const selectedItemId = $derived(navStore.state.selectedItemId)
  const detailItemQuery = libraryDataService.getItemDetailsQuery(() => selectedItemId, {
    enabled: () => !!selectedItemId && libraryStatus?.status === 'ready'
  })
  const selectedItemForDetailView = $derived(detailItemQuery.data as LibraryItem | null | undefined) // Can be undefined while loading

  const dispatch = createEventDispatcher<{
    scanLibrary: void
    openLibrary: void
    itemClick: { item: LibraryItem | SearchIndexEntry }
    play: { item: LibraryItem }
    dismissContinueWatching: { showId: string }
    showContextMenu: {
      item: LibraryItem | SearchIndexEntry
      event: MouseEvent
      options?: { layout?: string }
    }
    searchByTag: { key: string; value: string }
  }>()

  const searchParentItem = $derived(
    settings
      ? ({
          id: 'search-view',
          name: 'Search',
          type: 'folder',
          path: '',
          children: [],
          viewSettings: settings.searchResultView // This is correct: nest view settings under viewSettings
        } as MediaFolder)
      : undefined
  )

  let setupCompleted = $state(false)

  const isRoot = $derived(
    !isGlobalSearchActive && (currentFolderId === 'root' || currentFolder?.path === '.')
  )

  // Handle navigation errors when URL contains non-existent item IDs (e.g. from previous library)
  $effect(() => {
    if (selectedItemId && detailItemQuery.isError) {
      console.log(`[MainView] Item ${selectedItemId} not found (404). Closing detail view.`)
      navStore.closeDetail()
    }
  })

  $effect(() => {
    // Basic root check using the stable 'root' identifier
  })
</script>

<div class="content">
  {#if !setupCompleted && ((libraryStatus && libraryStatus.status !== 'ready') || (settings && !settings.libraryLocation) || (!currentFolder && !currentFolderId && !isGlobalSearchActive))}
    <SetupScreen
      onComplete={() => {
        setupCompleted = true
      }}
      {onStatusUpdate}
    />
  {:else}
    <div class="main-view-container" class:hidden={!!selectedItemForDetailView}>
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
              parentItem={searchParentItem}
              onShowContextMenu={(item, e, options) =>
                dispatch('showContextMenu', { item, event: e, options })}
              {suggestions}
              highlightedIndex={highlightedSearchItemIndex}
              isPreSorted={true}
              {settings}
              listFixedAspectRatio={true}
            />
          {:else if !isPerformingSearch}
            <p class="status-text">No results found.</p>
          {/if}
        </div>
      </div>

      <!-- FOLDER VIEW: Rendered but hidden via CSS unless active -->
      {#if currentFolder}
        <div class="view-wrapper" class:hidden={isGlobalSearchActive}>
          {#if isRoot}
            <HomeView
              {continueWatchingItems}
              parentItem={currentFolder}
              items={children}
              onItemClick={(item) => dispatch('itemClick', { item })}
              onShowContextMenu={(item, event, options) =>
                dispatch('showContextMenu', { item, event, options })}
              on:dismissContinueWatching={(e) =>
                dispatch('dismissContinueWatching', { showId: e.detail.showId })}
              {suggestions}
              {settings}
              on:scanLibrary={() => dispatch('scanLibrary')}
              on:openLibrary={() => dispatch('openLibrary')}
            />
          {:else}
            <div class="folder-content-wrapper">
              <h2 class="folder-header-title">{currentFolder.title ?? currentFolder.name}</h2>
              <MediaView
                parentItem={currentFolder}
                items={children}
                searchQuery={filterQuery}
                onItemClick={(item) => dispatch('itemClick', { item })}
                onShowContextMenu={(item, e, options) =>
                  dispatch('showContextMenu', { item, event: e, options })}
                {suggestions}
                {settings}
                viewNode={currentFolder.viewHierarchy}
              />
            </div>
          {/if}
        </div>
      {/if}
    </div>

    {#if selectedItemForDetailView && settings}
      <ItemDetail
        item={selectedItemForDetailView}
        onItemClick={(item) => dispatch('itemClick', { item })}
        onPlay={(item) => dispatch('play', { item })}
        onSearchByTag={(key, value) => dispatch('searchByTag', { key, value })}
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

  .search-content-wrapper {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  .folder-content-wrapper {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
    overflow-y: auto;
    scrollbar-gutter: stable;
    padding-top: 1.5rem;
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

  .folder-header-title {
    font-size: 1.8rem;
    font-weight: bold;
    padding: 0 1.5rem;
    margin-bottom: 1rem;
    flex-shrink: 0;
  }

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
</style>
