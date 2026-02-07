<script lang="ts">
  import MediaView from './MediaView.svelte'
  import ItemDetail from './ItemDetail.svelte'
  import HomeView from './HomeView.svelte'
  import SetupScreen from './SetupScreen.svelte'
  import { createEventDispatcher } from 'svelte'
  import { fade, fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'

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
    LibraryStatus
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
  const currentFolderId = $derived(navStore.state.currentFolderId)
  const currentFolderQuery = libraryDataService.getItemDetailsQuery(() => currentFolderId, {
    enabled: () => libraryStatus?.status === 'ready',
    include: () => ['viewHierarchy']
  })
  const currentFolder = $derived(currentFolderQuery.data as (LibraryItem & MediaFolder) | undefined)

  const resolvedSettings = $derived(resolveViewSettings(currentFolder, settings).settings)
  const requiredFields = $derived.by(() => getAllRequiredFields(currentFolder?.viewHierarchy))

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
  const selectedItemForDetailView = $derived(detailItemQuery.data as LibraryItem | null | undefined)

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
          viewSettings: settings.searchResultView
        } as MediaFolder)
      : undefined
  )

  let setupCompleted = $state(false)
  const isRoot = $derived(
    !isGlobalSearchActive && (currentFolderId === 'root' || currentFolder?.path === '.')
  )

  $effect(() => {
    if (selectedItemId && detailItemQuery.isError) {
      navStore.closeDetail()
    }
  })

  // Freeze the background view state when the detail view is active
  // This prevents the "flash" of the main library when opening/closing results
  let wasSearchActiveWhenDetailOpened = $state(false)
  $effect(() => {
    if (!selectedItemId) {
      wasSearchActiveWhenDetailOpened = isGlobalSearchActive
    }
  })
  const effectivelySearchActive = $derived(
    selectedItemId ? wasSearchActiveWhenDetailOpened : isGlobalSearchActive
  )
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
    <div class="main-view-container" class:detail-active={!!selectedItemId}>
      <!-- SEARCH VIEW -->
      <div class="view-wrapper" class:hidden={!effectivelySearchActive}>
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

      <!-- FOLDER VIEW -->
      {#if currentFolder}
        <div class="view-wrapper" class:hidden={effectivelySearchActive}>
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

    {#if selectedItemId && settings}
      <div class="detail-transition-wrapper" transition:fade={{ duration: 200 }}>
        {#key selectedItemId}
          <div class="detail-switch-container" transition:fade={{ duration: 200 }}>
            <ItemDetail
              item={selectedItemForDetailView ||
                ({ id: selectedItemId, type: 'folder', name: '', path: '' } as LibraryItem)}
              onItemClick={(item) => dispatch('itemClick', { item })}
              onPlay={(item) => dispatch('play', { item })}
              onSearchByTag={(key, value) => dispatch('searchByTag', { key, value })}
              showContextMenu={(item, event, options) =>
                dispatch('showContextMenu', { item, event, options })}
              {settings}
            />
          </div>
        {/key}
      </div>
    {/if}
  {/if}
</div>

<style>
  .content {
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden; /* Hide outer overflow to fix zoom origin */
  }

  .main-view-container {
    display: flex;
    flex-direction: column;
    flex: 1;
    position: relative;
    overflow-y: auto; /* Scroll internally to fix zoom origin */
    scrollbar-gutter: stable;
    /* Transition opacity and scale for a premium feel */
    transition:
      opacity 0.16s cubic-bezier(0.4, 0, 0.2, 1),
      transform 0.16s cubic-bezier(0.4, 0, 0.2, 1);
    transform-origin: center center;
  }

  .main-view-container.detail-active {
    opacity: 0;
    pointer-events: none;
    transform: scale(0.97);
  }

  .detail-transition-wrapper {
    position: fixed;
    top: var(--header-height);
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 5;
    background-color: var(--color-background);
  }

  .detail-switch-container {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
  }

  .view-wrapper {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    min-height: 100%;
    display: flex;
    flex-direction: column;
  }

  .view-wrapper.hidden {
    display: none; /* Fully remove from flow when hidden */
  }

  .search-content-wrapper {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
    width: 100%;
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 4rem;
  }

  .folder-content-wrapper {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
    padding-top: 1.5rem;
    width: 100%;
    max-width: 1800px;
    margin: 0 auto;
    padding-left: 2.5rem;
    padding-right: 2.5rem;
  }

  .search-header {
    width: 100%;
    max-width: 1000px;
    margin: 0 auto;
    padding: 1.5rem 4rem;
    font-size: 1.2rem;
    font-weight: 600;
    color: var(--ev-c-text-1);
    border-bottom: 1px solid var(--color-background-mute);
    flex-shrink: 0;
  }

  .folder-header-title {
    width: 100%;
    max-width: 1800px;
    margin: 0 auto;
    font-size: 1.8rem;
    font-weight: bold;
    padding: 0 2.5rem;
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
