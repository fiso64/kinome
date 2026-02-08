<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { fade } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import MainView from './MainView.svelte'
  import SearchOverlay from './SearchOverlay.svelte'
  import ItemDetail from './ItemDetail.svelte'
  import SettingsView from './SettingsView.svelte'
  import { navStore } from '@lib/navigation-store.svelte'
  import { searchStore } from '@lib/search-store.svelte'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import type {
    Settings,
    LibraryStatus,
    AutocompleteSuggestions,
    LibraryItem,
    MediaFile,
    SearchIndexEntry
  } from '@shared/types'

  let {
    settings = $bindable(),
    isScanning,
    libraryStatus,
    suggestions
  }: {
    settings: Settings | null
    isScanning: boolean
    libraryStatus: LibraryStatus | null
    suggestions: AutocompleteSuggestions
  } = $props()

  const dispatch = createEventDispatcher<{
    itemClick: { item: LibraryItem | SearchIndexEntry }
    play: { item: MediaFile }
    showContextMenu: {
      item: LibraryItem | SearchIndexEntry
      event: MouseEvent
      options?: { layout?: string; parentItem?: LibraryItem }
    }
    searchByTag: { key: string; value: string }
    dismissContinueWatching: { showId: string }
    statusUpdate: void
  }>()

  // Derived State
  const selectedItemId = $derived(navStore.state.selectedItemId)
  const isGlobalSearchActive = $derived(searchStore.isGlobalActive)
  const isSettingsActive = $derived(navStore.state.path === '/settings')

  // Search/Detail Visibility Logic
  let wasSearchActiveWhenDetailOpened = $state(false)
  $effect.pre(() => {
    if (!selectedItemId) {
      wasSearchActiveWhenDetailOpened = isGlobalSearchActive
    }
  })
  const effectivelySearchActive = $derived(
    selectedItemId ? wasSearchActiveWhenDetailOpened : isGlobalSearchActive
  )

  // Data Fetching for Detail View
  const detailItemQuery = libraryDataService.getItemDetailsQuery(() => selectedItemId, {
    enabled: () => !!selectedItemId && libraryStatus?.status === 'ready'
  })
  const selectedItemForDetailView = $derived(detailItemQuery.data as LibraryItem | null | undefined)
</script>

<div class="view-layers">
  <!-- Layer 0: Folder Library -->
  <div
    class="view-layer"
    class:hidden={effectivelySearchActive || isSettingsActive}
    class:background={!!selectedItemId}
  >
    <MainView
      {isScanning}
      {libraryStatus}
      {settings}
      {suggestions}
      disabled={!!selectedItemId}
      onStatusUpdate={() => dispatch('statusUpdate')}
      on:itemClick={(e) => dispatch('itemClick', { item: e.detail.item })}
      on:play={(e) => dispatch('play', { item: e.detail.item as MediaFile })}
      on:showContextMenu={(e) =>
        dispatch('showContextMenu', {
          item: e.detail.item,
          event: e.detail.event,
          options: e.detail.options
        })}
      on:searchByTag={(e) => dispatch('searchByTag', { key: e.detail.key, value: e.detail.value })}
      on:dismissContinueWatching={(e) =>
        dispatch('dismissContinueWatching', { showId: e.detail.showId })}
    />
  </div>

  <!-- Layer 1: Global Search Overlay -->
  {#if isGlobalSearchActive || effectivelySearchActive}
    <div
      class="view-layer search-layer"
      class:hidden={!effectivelySearchActive || isSettingsActive}
      class:background={!!selectedItemId}
    >
      <SearchOverlay
        {settings}
        {suggestions}
        disabled={!!selectedItemId}
        on:itemClick={(e) => dispatch('itemClick', { item: e.detail.item })}
        on:showContextMenu={(e) =>
          dispatch('showContextMenu', {
            item: e.detail.item,
            event: e.detail.event,
            options: e.detail.options
          })}
      />
    </div>
  {/if}

  <!-- Layer 2: Detail View Overlay -->
  {#if selectedItemId && settings}
    <div class="view-layer detail-layer" transition:fade={{ duration: 300, easing: cubicOut }}>
      {#key selectedItemId}
        <div class="detail-switch-container" transition:fade={{ duration: 250, easing: cubicOut }}>
          <ItemDetail
            item={selectedItemForDetailView ||
              ({ id: selectedItemId, type: 'folder', name: '', path: '' } as LibraryItem)}
            onItemClick={(item) => dispatch('itemClick', { item })}
            onPlay={(item) => dispatch('play', { item: item as MediaFile })}
            onSearchByTag={(key, value) => dispatch('searchByTag', { key, value })}
            showContextMenu={(item, event, options) =>
              dispatch('showContextMenu', { item, event, options })}
            {settings}
          />
        </div>
      {/key}
    </div>
  {/if}

  <!-- Layer 3: Settings View -->
  {#if isSettingsActive}
    <div class="view-layer settings-layer" transition:fade={{ duration: 300, easing: cubicOut }}>
      <SettingsView bind:settings />
    </div>
  {/if}
</div>

<style>
  .view-layers {
    position: relative;
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .view-layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    transition:
      opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1),
      transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .view-layer.hidden {
    opacity: 0;
    pointer-events: none;
    transform: scale(0.99);
  }

  .view-layer.background {
    transform: scale(0.98);
    pointer-events: none;
  }

  .detail-layer {
    z-index: 10;
    background-color: var(--color-background);
  }

  .settings-layer {
    z-index: 20;
    background-color: var(--color-background);
  }

  .detail-switch-container {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
  }
</style>
