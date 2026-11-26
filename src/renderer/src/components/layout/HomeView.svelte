<script lang="ts">
  import { createEventDispatcher, type Snippet } from 'svelte'
  import type { MediaFolder, MediaFile, LibraryItem, Settings } from '@shared/types'
  import ContinueWatching from './ContinueWatching.svelte'

  let {
    continueWatchingItems,
    onItemClick,
    onShowContextMenu,
    settings,
    children
  }: {
    continueWatchingItems: { show: MediaFolder; nextEpisode: MediaFile }[]
    onItemClick: (item: LibraryItem) => void
    onShowContextMenu: (item: LibraryItem, event: MouseEvent) => void
    settings: Settings | null
    children: Snippet
  } = $props()

  const dispatch = createEventDispatcher<{
    dismissContinueWatching: { showId: string }
  }>()

  const latestBackdrop = $derived(
    settings?.showContinueWatching ? continueWatchingItems[0]?.show?.backdropPath : null
  )

  const isGlassActive = $derived(!!latestBackdrop)

</script>

<div class="home-view-container">
  <h1>Library</h1>
  {#if settings?.showContinueWatching && continueWatchingItems.length > 0}
    <section class="home-section">
      <h2 class="home-section-title">Continue watching</h2>
      <ContinueWatching
        items={continueWatchingItems}
        glass={isGlassActive}
        on:dismiss={(e) => dispatch('dismissContinueWatching', e.detail)}
        on:itemClick={(e) => onItemClick(e.detail.item)}
        on:showContextMenu={(e) => onShowContextMenu(e.detail.item, e.detail.event)}
      />
    </section>
  {/if}

  {@render children()}
</div>

<style>
  .home-view-container {
    position: relative;
    display: grid;
    align-content: start;
    gap: clamp(1.1rem, 2.4vw, 2rem);
    width: min(100%, 108rem);
    margin-inline: auto;
    padding: calc(clamp(1.25rem, 3.2vw, 2.75rem) + env(safe-area-inset-top)) clamp(.9rem, 3.2vw, 3rem) 4rem;
  }

  h1 {
    padding-inline-start: var(--floating-back-space);
    font-size: clamp(2.1rem, 4vw, 3.5rem);
    font-weight: 720;
    letter-spacing: -.045em;
    line-height: 1.03;
    text-shadow: 0 4px 20px #03060ba6;
  }

  .home-section { min-width: 0; }
  .home-section-title {
    margin-bottom: .45rem;
    color: var(--color-text);
    font-size: clamp(1.05rem, 1.7vw, 1.35rem);
    font-weight: 650;
    letter-spacing: -.016em;
  }
</style>
