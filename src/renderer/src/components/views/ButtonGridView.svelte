<script lang="ts">
  import type { LibraryItem, MediaFolder, SearchIndexEntry } from '@shared/types'

  import { shouldBeGreyedOut } from '@lib/view-helpers'
  import { getAssetUrl } from '@lib/api'
  import { writable } from 'svelte/store'
  import { horizontalScroller, type HorizontalScrollState } from '@lib/horizontal-scroll'
  import { viewStateStore, getViewKey } from '@lib/view-state-store.svelte'

  type DisplayableItem = LibraryItem | SearchIndexEntry

  let {
    items,
    onItemClick,
    onShowContextMenu,
    grayOutWatched,
    parentItem,
    gridPosterSize,
    showHorizontalScrollbar,
    scrollHorizontally
  }: {
    items: DisplayableItem[]
    onItemClick: (item: DisplayableItem) => void
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string; parentItem?: LibraryItem }
    ) => void
    grayOutWatched: boolean
    parentItem?: MediaFolder
    gridPosterSize?: number | null
    showHorizontalScrollbar?: boolean
    scrollHorizontally?: boolean
  } = $props()

  let listElement: HTMLDivElement | undefined = $state()

  // --- Persistent Scroll State (only used if horizontal) ---
  const stateKey = getViewKey('button-grid')
  const persistentState = viewStateStore.get(stateKey, { scrollX: 0 })

  $effect(() => {
    if (scrollHorizontally && listElement && persistentState.scrollX > 0) {
      const timeout = setTimeout(() => {
        if (listElement) listElement.scrollLeft = persistentState.scrollX
      }, 0)
      return () => clearTimeout(timeout)
    }
  })

  function handleScroll(e: Event) {
    if (scrollHorizontally) {
      const target = e.target as HTMLElement
      persistentState.scrollX = target.scrollLeft
    }
  }

  const scrollState = writable<HorizontalScrollState>({
    canScrollLeft: false,
    canScrollRight: false
  })
  const canScrollLeft = $derived($scrollState.canScrollLeft)
  const canScrollRight = $derived($scrollState.canScrollRight)

  function scroll(direction: 'left' | 'right') {
    listElement?.dispatchEvent(new CustomEvent('smooth-scroll', { detail: { direction } }))
  }

  function itemHue(str: string): number {
    if (str === 'Uncategorized') return 210
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash)
    }
    return Math.abs(hash) % 360
  }
</script>

<div
  class="button-grid-container"
  class:horizontal={scrollHorizontally}
  class:can-scroll-left={scrollHorizontally && canScrollLeft}
  class:can-scroll-right={scrollHorizontally && canScrollRight}
>
  {#if items.length > 0}
    {#if scrollHorizontally}
      <button
        class="scroll-button left"
        class:visible={canScrollLeft}
        onclick={() => scroll('left')}
        aria-label="Scroll left"
      >
        <svg width="8" height="13" viewBox="0 0 10 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8.5 15L1.5 8L8.5 1" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    {/if}

    <div
      bind:this={listElement}
      class="media-grid"
      class:horizontal={scrollHorizontally}
      class:with-scrollbar={showHorizontalScrollbar}
      style={gridPosterSize ? (scrollHorizontally ? `grid-auto-columns: ${gridPosterSize}px;` : `--local-grid-poster-size: ${gridPosterSize}px`) : ''}
      use:horizontalScroller={scrollHorizontally ? scrollState : undefined}
      onscroll={handleScroll}
    >
      {#each items as item (item.id)}
        {@const baseTitle = item.title ?? ('name' in item ? (item as LibraryItem).name : '')}
        {@const displayTitle = 'episodeNumber' in item && item.mediaType === 'episode' && item.episodeNumber != null ? `${item.episodeNumber}. ${baseTitle}` : baseTitle}
        {@const bgImage = ('backdropPath' in item && item.backdropPath) ? item.backdropPath : item.posterPath}
        {@const hasImage = !!bgImage}
        {@const hue = itemHue(displayTitle)}
        {@const accentColor = `hsl(${hue}, 50%, 62%)`}
        {@const loadingGradient = `linear-gradient(135deg, hsl(${hue}, 70%, 40%), hsl(${(hue + 40) % 360}, 80%, 25%))`}

        <button
          type="button"
          class="grid-item"
          class:has-image={hasImage}
          class:watched={shouldBeGreyedOut(item, parentItem, grayOutWatched)}
          class:missing={item.isMissing}
          onclick={() => onItemClick(item)}
          oncontextmenu={(e) =>
            onShowContextMenu(item, e, {
              layout: 'button-grid',
              parentItem: parentItem as LibraryItem
            })}
        >
          {#if hasImage}
            <div class="button-background" style="background: {loadingGradient};">
              <img
                src={getAssetUrl(bgImage + (item._v ? `?v=${item._v}` : ''))}
                alt=""
                loading="lazy"
              />
              <div class="overlay"></div>
            </div>
          {:else}
            <div class="accent-strip" style="background: {accentColor};"></div>
          {/if}
          
          <div class="name" title={displayTitle}>
            {displayTitle}
          </div>
          
          {#if item.isMissing}
            <div class="missing-overlay">
              <span class="missing-icon">⚠️</span>
            </div>
          {/if}
        </button>
      {/each}
    </div>

    {#if scrollHorizontally}
      <button
        class="scroll-button right"
        class:visible={canScrollRight}
        onclick={() => scroll('right')}
        aria-label="Scroll right"
      >
        <svg width="8" height="13" viewBox="0 0 10 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M1.5 1L8.5 8L1.5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    {/if}
  {:else}
    <p class="empty-message">No items match your filter.</p>
  {/if}
</div>

<style>
  .empty-message {
    padding: 1.5rem;
    color: var(--ev-c-text-2);
  }
  
  .button-grid-container {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
  }
  .button-grid-container.horizontal {
    flex-direction: row;
    align-items: center;
    padding: 1.5rem 0;
  }

  .media-grid {
    display: grid;
    gap: 1.5rem;
    width: 100%;
  }
  
  /* Vertical (Wrapped) Grid */
  .media-grid:not(.horizontal) {
    grid-template-columns: repeat(
      auto-fill,
      minmax(var(--local-grid-poster-size, var(--grid-poster-size)), 1fr)
    );
    padding: 1.5rem;
    align-content: start;
    flex: 1;
  }

  /* Horizontal Scrolling Grid */
  .media-grid.horizontal {
    grid-auto-flow: column;
    grid-auto-columns: 250px; /* Overridden by inline style */
    padding: 0.5rem 1.5rem;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
    padding-bottom: 1rem;
  }
  .media-grid.horizontal::-webkit-scrollbar {
    display: none;
  }
  .media-grid.horizontal.with-scrollbar {
    scrollbar-width: thin;
  }
  .media-grid.horizontal.with-scrollbar::-webkit-scrollbar {
    display: block;
    height: 8px;
  }
  .media-grid.horizontal.with-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .media-grid.horizontal.with-scrollbar::-webkit-scrollbar-thumb {
    background-color: var(--ev-c-gray-3);
    border-radius: 4px;
  }
  .media-grid.horizontal.with-scrollbar::-webkit-scrollbar-thumb:hover {
    background-color: var(--ev-c-gray-2);
  }

  /* Grid Item (Button) */
  .grid-item {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    position: relative;
    width: 100%;
    aspect-ratio: 2.5 / 1;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    container-type: inline-size;
    transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 4px 12px rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.05);
  }
  
  .grid-item:hover {
    transform: scale(1.05);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 8px 24px rgba(0, 0, 0, 0.5);
    z-index: 1;
    border-color: rgba(255, 255, 255, 0.15);
  }

  .button-background {
    position: absolute;
    inset: 0;
    z-index: 0;
  }
  
  .button-background img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.5); /* Darken image/color so text is readable */
    transition: background 0.2s ease;
  }
  .grid-item:hover .overlay {
    background: rgba(0, 0, 0, 0.3);
  }

  .name {
    position: relative;
    z-index: 1;
    font-size: clamp(0.9rem, 9cqi, 1.4rem);
    font-weight: 700;
    color: white;
    text-shadow: 0 2px 6px rgba(0, 0, 0, 0.6);
    text-align: center;
    padding: 1rem;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }

  /* No-image flat style */
  .grid-item:not(.has-image) {
    background: var(--color-background-soft);
    justify-content: flex-start;
  }
  .grid-item:not(.has-image):hover {
    background: var(--color-background-mute);
  }
  .grid-item:not(.has-image) .name {
    text-align: left;
    padding-left: clamp(1rem, calc(2cqi + 0.75rem), calc(14px + 0.75rem));
  }

  .accent-strip {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: clamp(5px, 3.5cqi, 14px);
    z-index: 0;
  }

  .grid-item.watched {
    opacity: 0.6;
    transition: opacity 0.2s ease;
  }
  .grid-item.watched:hover {
    opacity: 1;
  }
  .grid-item.missing .button-background {
    filter: grayscale(1);
  }
  .grid-item.missing .name {
    font-style: italic;
    opacity: 0.7;
  }
  
  .missing-overlay {
    position: absolute;
    inset: 0;
    background: rgba(20, 20, 20, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(2px);
    z-index: 2;
  }
  .missing-icon {
    font-size: 2rem;
    opacity: 0.8;
    filter: drop-shadow(0 0 5px black);
  }

  /* Scroll Buttons */
  .scroll-button {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 3;
    background-color: rgba(30, 30, 30, 0.9);
    backdrop-filter: blur(2px);
    color: var(--ev-c-text-2);
    border: 1px solid var(--color-background-mute);
    border-radius: 50%;
    width: 40px;
    height: 40px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    line-height: 1;
    padding: 0;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.2s ease, visibility 0.2s ease, color 0.2s ease;
  }
  .scroll-button.left {
    left: 1rem;
  }
  .scroll-button.right {
    right: 1rem;
  }
  .button-grid-container.horizontal:hover .scroll-button.visible {
    opacity: 1;
    visibility: visible;
  }
  .scroll-button:hover {
    background-color: var(--ev-c-gray-2);
    color: var(--ev-c-text-1);
  }
  .scroll-button:active {
    transform: translateY(-50%) scale(0.95);
  }

  /* Fade Gradients */
  .button-grid-container.horizontal::before,
  .button-grid-container.horizontal::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 80px;
    z-index: 2; /* Below buttons, above grid */
    pointer-events: none;
    opacity: 0;
  }

  .button-grid-container.horizontal::before {
    left: 0;
    background: linear-gradient(to right, var(--color-background) 20%, transparent);
  }
  .button-grid-container.horizontal::after {
    right: 0;
    background: linear-gradient(to left, var(--color-background) 20%, transparent);
  }
  .button-grid-container.can-scroll-left::before,
  .button-grid-container.can-scroll-right::after {
    opacity: 1;
  }
</style>