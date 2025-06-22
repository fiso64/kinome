<script lang="ts">
  import ContinueWatching from './ContinueWatching.svelte'
  import MediaView from './MediaView.svelte'
  import { createEventDispatcher } from 'svelte'

  type ContinueWatchingItem = {
    show: MediaFolder
    nextEpisode: MediaFile
  }
  type DisplayableItem = LibraryItem | SearchIndexEntry

  let {
    continueWatchingItems,
    parentItem,
    onItemClick,
    onShowContextMenu,
    suggestions,
    settings
  }: {
    continueWatchingItems: ContinueWatchingItem[]
    parentItem: MediaFolder
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

  // NOTE: The Continue Watching section below uses native horizontal scrolling.
  // We are deliberately not intercepting the vertical mouse wheel to scroll horizontally,
  // as it can feel jarring and interfere with page scrolling. A visible scrollbar is used instead.
</script>

<div class="home-view-container">
  {#if settings?.showContinueWatching && continueWatchingItems.length > 0}
    <section class="home-section">
      <h2 class="home-section-title">Continue Watching</h2>
      <ContinueWatching
        items={continueWatchingItems}
        on:dismiss={(e) => dispatch('dismissContinueWatching', e.detail)}
        on:itemClick={(e) => onItemClick(e.detail.item)}
      />
    </section>
  {/if}

  <section class="home-section">
    <h2 class="home-section-title">Library</h2>
    <MediaView
      parentItem={parentItem}
      items={parentItem.children}
      {onItemClick}
      {onShowContextMenu}
      {suggestions}
      {settings}
    />
  </section>
</div>

<style>
  .home-view-container {
    padding-top: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .home-section-title {
    font-size: 1.5rem;
    font-weight: bold;
    padding: 0 1.5rem;
    margin-bottom: 1rem;
  }
</style>