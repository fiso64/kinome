<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { fade } from 'svelte/transition'
  import { prefersReducedMotion } from 'svelte/motion'
  import { cubicOut } from 'svelte/easing'
  import MainView from './MainView.svelte'
  import SearchOverlay from './SearchOverlay.svelte'
  import ItemDetail from './ItemDetail.svelte'
  import SettingsView from './SettingsView.svelte'
  import { navStore } from '@lib/navigation-store.svelte'
  import { searchStore } from '@lib/search-store.svelte'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import { getAssetUrl } from '@lib/api'

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
    libraryStatus,
    librarySearchOpen,
    closeLibrarySearch,
    suggestions
  }: {
    settings: Settings | null
    libraryStatus: LibraryStatus | null
    librarySearchOpen: boolean
    closeLibrarySearch: () => void
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
  }>()

  // Derived State
  const selectedItemId = $derived(navStore.selectedItemId)
  const isGlobalSearchActive = $derived(librarySearchOpen || searchStore.isGlobalActive)
  let searchOverlay = $state<SearchOverlay>()

  export function focusLibrarySearch() {
    searchOverlay?.focusSearchInput()
  }
  const isSettingsActive = $derived(navStore.isSettingsActive)

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

  // Backdrop Logic
  let scrollTop = $state(0)
  const continueWatchingQuery = libraryDataService.getContinueWatchingQuery({
    enabled: () => !!settings?.showContinueWatching && libraryStatus?.status === 'ready'
  })
  const continueWatchingItems = $derived(continueWatchingQuery.data ?? [])
  const isHomeView = $derived(
    navStore.isHomeLocation
  )

  const latestBackdrop = $derived(
    isHomeView && settings?.showContinueWatching && !effectivelySearchActive
      ? continueWatchingItems[0]?.show?.backdropPath
      : null
  )
</script>

<div class="view-layers">
  {#if latestBackdrop}
    <div
      class="home-static-backdrop"
      style="transform: translateY(-{scrollTop}px)"
      transition:fade={{ duration: prefersReducedMotion.current ? 0 : 100 }}
    >
      <img src={getAssetUrl(latestBackdrop)} alt="" />
      <div class="home-static-backdrop-overlay"></div>
    </div>
  {/if}

  <!-- Layer 0: Folder Library -->

  <div
    class="view-layer"
    inert={effectivelySearchActive || isSettingsActive || !!selectedItemId}
    class:hidden={effectivelySearchActive || isSettingsActive}
    class:background={!!selectedItemId}
  >
    <MainView
      {continueWatchingItems}
      {libraryStatus}
      {settings}
      {suggestions}
      onScroll={(top) => (scrollTop = top)}
      disabled={!!selectedItemId}
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
      inert={!effectivelySearchActive || isSettingsActive || !!selectedItemId}
      class:hidden={!effectivelySearchActive || isSettingsActive}
      class:background={!!selectedItemId}
    >
      <SearchOverlay
        bind:this={searchOverlay}
        onClose={closeLibrarySearch}
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
    <div class="view-layer detail-layer" inert={isSettingsActive}>
      {#key selectedItemId}
        <div class="detail-switch-container" in:fade={{ duration: prefersReducedMotion.current ? 0 : 145, easing: cubicOut }}>
          <ItemDetail
            item={{ id: selectedItemId, type: 'folder', name: '', path: '' } as LibraryItem}
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
    <div class="view-layer settings-layer">
      <SettingsView {settings} />
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
    inset: 0 0 0 var(--content-inset, 0px);
    display: flex;
    flex-direction: column;
    transition: opacity .2s ease;
  }

  @media (prefers-reduced-motion: reduce) { .view-layer { transition: none; } }

  .view-layer.hidden {
    opacity: 0;
    pointer-events: none;
  }

  .view-layer.background {
    pointer-events: none;
  }

  .detail-layer {
    inset-inline-start: 0;
    z-index: 10;
    background-color: var(--color-background);
  }

  .settings-layer {
    inset-inline-start: 0;
    padding-inline-start: var(--content-inset, 0px);
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

  .home-static-backdrop {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: min(440px, 62dvh);
    z-index: 0;
    pointer-events: none;
    overflow: hidden;
    will-change: transform;
  }

  .home-static-backdrop img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: blur(9px) saturate(.7);
    opacity: .53;
    transform: scale(1.05);
  }

  .home-static-backdrop-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: linear-gradient(0deg, var(--color-background), color-mix(in srgb, var(--color-background) 40%, transparent) 61%, transparent);
  }
</style>
