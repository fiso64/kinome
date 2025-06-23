<script lang="ts">
  import { shouldBeGreyedOut } from '../../lib/view-helpers'
  type DisplayableItem = LibraryItem | SearchIndexEntry
  type VirtualFolder = MediaFolder & {
    isVirtual: boolean
    physicalParentId: string
    groupByKey: string
    groupByValue: string
  }

  let {
    items,
    onItemClick,
    onShowContextMenu,
    grayOutWatched,
    parentItem,
    gridPosterSize,
    showHorizontalScrollbar
  }: {
    items: DisplayableItem[]
    onItemClick: (item: DisplayableItem) => void
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string }
    ) => void
    grayOutWatched: boolean
    parentItem?: MediaFolder | VirtualFolder
    gridPosterSize?: number | null
    showHorizontalScrollbar?: boolean
  } = $props()

  let listElement = $state<HTMLDivElement | undefined>()
  let canScrollLeft = $state(false)
  let canScrollRight = $state(false)

  $effect(() => {
    const el = listElement
    if (!el) return

    const checkScrollability = () => {
      // A small buffer helps prevent floating point inaccuracies
      canScrollLeft = el.scrollLeft > 1
      canScrollRight = el.scrollLeft < el.scrollWidth - el.clientWidth - 1
    }

    checkScrollability() // Initial check

    // Re-check on scroll and resize events
    const observer = new ResizeObserver(checkScrollability)
    observer.observe(el)
    el.addEventListener('scroll', checkScrollability)

    // A one-time check after images might load
    const timeoutId = setTimeout(checkScrollability, 500)

    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', checkScrollability)
      clearTimeout(timeoutId)
    }
  })

  function scroll(direction: 'left' | 'right') {
    if (!listElement) return
    const scrollAmount = listElement.clientWidth * 0.8
    listElement.scrollTo({
      left: listElement.scrollLeft + (direction === 'left' ? -scrollAmount : scrollAmount),
      behavior: 'smooth'
    })
  }
</script>

<div
  class="horizontal-grid-container"
  class:can-scroll-left={canScrollLeft}
  class:can-scroll-right={canScrollRight}
>
  {#if items.length > 0}
    <button
      class="scroll-button left"
      class:visible={canScrollLeft}
      onclick={() => scroll('left')}
      aria-label="Scroll left"
    >
      <svg width="8" height="13" viewBox="0 0 10 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M8.5 15L1.5 8L8.5 1"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <div
      bind:this={listElement}
      class="media-grid"
      class:with-scrollbar={showHorizontalScrollbar}
      style={gridPosterSize ? `grid-auto-columns: ${gridPosterSize}px;` : ''}
    >
      {#each items as item (item.id)}
        {@const baseTitle = item.title ?? ('name' in item ? (item as LibraryItem).name : '')}
        {@const displayTitle =
          'episodeNumber' in item && item.mediaType === 'episode' && item.episodeNumber != null
            ? `${item.episodeNumber}. ${baseTitle}`
            : baseTitle}
        <button
          type="button"
          class="grid-item"
          class:watched={shouldBeGreyedOut(item, parentItem, grayOutWatched)}
          class:missing={item.isMissing}
          onclick={() => onItemClick(item)}
          oncontextmenu={(e) => onShowContextMenu(item, e, { layout: 'horizontal-grid' })}
        >
          <div class="poster">
            {#if item.posterPath}
              <img
                src="media-browser-asset://images/{item.posterPath}{item._v ? `?v=${item._v}` : ''}"
                alt={displayTitle}
                loading="lazy"
              />
            {:else}
              <div class="icon">
                {item.type === 'folder' ? '📁' : '🎬'}
              </div>
            {/if}
            {#if item.isMissing}
              <div class="missing-overlay">
                <span class="missing-icon">⚠️</span>
              </div>
            {/if}
          </div>
          <div class="name" title={displayTitle}>
            {displayTitle}
          </div>
        </button>
      {/each}
    </div>
    <button
      class="scroll-button right"
      class:visible={canScrollRight}
      onclick={() => scroll('right')}
      aria-label="Scroll right"
    >
      <svg width="8" height="13" viewBox="0 0 10 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M1.5 1L8.5 8L1.5 15"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  {:else}
    <p class="empty-message">No items match your filter.</p>
  {/if}
</div>

<style>
  .empty-message {
    padding: 1.5rem;
    color: var(--ev-c-text-2);
  }
  .horizontal-grid-container {
    position: relative;
    display: flex;
    align-items: center;
    padding: 1.5rem 0;
  }
  .media-grid {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 250px; /* Default value */
    gap: 1.5rem;
    padding: 0.5rem 1.5rem; /* Add vertical padding for hover scale */
    width: 100%;
    overflow-x: auto;
    -ms-overflow-style: none; /* for Internet Explorer, Edge */
    scrollbar-width: none; /* for Firefox */
  }
  .media-grid::-webkit-scrollbar {
    display: none;
  }
  .media-grid.with-scrollbar {
    scrollbar-width: thin; /* for Firefox */
    padding-bottom: 1rem;
  }
  .media-grid.with-scrollbar::-webkit-scrollbar {
    display: block;
    height: 8px;
  }
  .media-grid.with-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .media-grid.with-scrollbar::-webkit-scrollbar-thumb {
    background-color: var(--ev-c-gray-3);
    border-radius: 4px;
  }
  .media-grid.with-scrollbar::-webkit-scrollbar-thumb:hover {
    background-color: var(--ev-c-gray-2);
  }

  /* Grid Item styles copied from GridView.svelte */
  .grid-item {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
  }
  .grid-item:hover {
    background-color: transparent;
  }
  .grid-item:hover .poster {
    transform: scale(1.05);
    background-color: var(--color-background-mute);
  }
  .poster {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background-color: var(--color-background-soft);
    border-radius: 8px;
    width: 100%;
    aspect-ratio: 2 / 3;
    overflow: hidden;
    transition:
      transform 0.2s ease,
      background-color 0.2s ease;
  }
  .poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .icon {
    font-size: 4rem;
  }
  .name {
    font-size: 0.9rem;
    font-weight: 600;
    width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .grid-item.watched {
    opacity: 0.6;
    transition: opacity 0.2s ease;
  }
  .grid-item.watched:hover {
    opacity: 1;
  }
  .grid-item.missing .poster {
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
  }
  .missing-icon {
    font-size: 3rem;
    opacity: 0.8;
    filter: drop-shadow(0 0 5px black);
  }

  /* Scroll button styles copied from TabsView.svelte */
  .scroll-button {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 2;
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
    transition:
      opacity 0.2s ease,
      visibility 0.2s ease,
      color 0.2s ease;
  }
  .scroll-button.left {
    left: 1rem;
  }
  .scroll-button.right {
    right: 1rem;
  }
  .horizontal-grid-container:hover .scroll-button.visible {
    opacity: 1;
    visibility: visible;
  }
  .scroll-button:hover {
    background-color: var(--ev-c-gray-2);
    color: var(--ev-c-text-1);
  }

  /* Fade Gradients */
  .horizontal-grid-container::before,
  .horizontal-grid-container::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 80px;
    z-index: 1; /* Below buttons, above grid */
    pointer-events: none;
    transition: opacity 0.3s;
    opacity: 0;
  }
  .horizontal-grid-container::before {
    left: 0;
    background: linear-gradient(to right, var(--color-background) 20%, transparent);
  }
  .horizontal-grid-container::after {
    right: 0;
    background: linear-gradient(to left, var(--color-background) 20%, transparent);
  }
  .horizontal-grid-container.can-scroll-left::before,
  .horizontal-grid-container.can-scroll-right::after {
    opacity: 1;
  }
</style>
