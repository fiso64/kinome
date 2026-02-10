<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import type {
    MediaFolder,
    MediaFile,
    LibraryItem,
    SearchIndexEntry,
    AutocompleteSuggestions,
    Settings
  } from '@shared/types'
  import ContinueWatching from './ContinueWatching.svelte'
  import MediaView from './MediaView.svelte'

  type ContinueWatchingItem = {
    show: MediaFolder
    nextEpisode: MediaFile
  }
  type DisplayableItem = LibraryItem | SearchIndexEntry

  let {
    continueWatchingItems,
    parentItem,
    items = [],
    onItemClick,
    onShowContextMenu,
    suggestions,
    settings
  }: {
    continueWatchingItems: ContinueWatchingItem[]
    parentItem: (LibraryItem & MediaFolder) | undefined
    items: DisplayableItem[]
    onItemClick: (item: DisplayableItem) => void
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string }
    ) => void
    suggestions: AutocompleteSuggestions
    settings: Settings | null
  } = $props()

  const dispatch = createEventDispatcher<{
    dismissContinueWatching: { showId: string }
  }>()

  const latestBackdrop = $derived(
    settings?.showContinueWatching ? continueWatchingItems[0]?.show?.backdropPath : null
  )

  const isGlassActive = $derived(!!latestBackdrop)

  // NOTE: The Continue Watching section below uses native horizontal scrolling.

  // We are deliberately not intercepting the vertical mouse wheel to scroll horizontally,
  // as it can feel jarring and interfere with page scrolling. A visible scrollbar is used instead.

  $effect(() => {
    console.log(`[HomeView] parentItem:`, parentItem?.name, `items:`, items.length)
  })
</script>

<div class="home-view-container">
  {#if settings?.showContinueWatching && continueWatchingItems.length > 0}
    <section class="home-section">
      <h2 class="home-section-title">Continue Watching</h2>
      <ContinueWatching
        items={continueWatchingItems}
        glass={isGlassActive}
        on:dismiss={(e) => dispatch('dismissContinueWatching', e.detail)}
        on:itemClick={(e) => onItemClick(e.detail.item)}
        on:showContextMenu={(e) => onShowContextMenu(e.detail.item, e.detail.event)}
      />
    </section>
  {/if}

  {#if parentItem}
    <section class="home-section">
      <h2 class="home-section-title">Library</h2>
      <MediaView
        {parentItem}
        {items}
        {onItemClick}
        {onShowContextMenu}
        {suggestions}
        {settings}
        viewNode={parentItem.viewHierarchy}
      />
    </section>
  {/if}
</div>

<style>
  .home-view-container {
    position: relative;
    padding-top: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    width: 100%;
    max-width: 1800px;
    margin: 0 auto;
    padding-left: 2.5rem;
    padding-right: 2.5rem;
  }

  .home-section {
    position: relative;
    z-index: 1;
  }

  .home-section-title {
    font-size: 1.8rem;
    font-weight: bold;
    padding: 0;
    margin-bottom: 1rem;
  }
</style>
