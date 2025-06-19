<script lang="ts">
  type DisplayableItem = LibraryItem | SearchIndexEntry

  let {
    items,
    onItemClick,
    onShowContextMenu,
    highlightedIndex,
    grayOutWatched,
    fixedAspectRatio = false
  }: {
    items: DisplayableItem[]
    onItemClick: (item: DisplayableItem) => void
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string }
    ) => void
    highlightedIndex?: number | null
    grayOutWatched: boolean
    fixedAspectRatio?: boolean
  } = $props()

  let listElement: HTMLDivElement | undefined = $state()

  $effect(() => {
    if (
      listElement &&
      highlightedIndex !== null &&
      highlightedIndex >= 0 &&
      items.length > highlightedIndex && // Check against items length
      listElement.children.length > highlightedIndex // Check against actual rendered children
    ) {
      const itemElement = listElement.children[highlightedIndex] as HTMLElement
      itemElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  })
</script>

<div class="media-list" bind:this={listElement}>
  {#if items.length > 0}
    {#each items as item, i (item.id)}
      {@const baseTitle = item.title ?? ('name' in item ? (item as LibraryItem).name : '')}
      {@const displayTitle = 'episodeNumber' in item && item.mediaType === 'episode' && item.episodeNumber != null ? `${item.episodeNumber}. ${baseTitle}` : baseTitle}
      {@const overview = 'overview' in item ? item.overview : ''}
      <button
        type="button"
        class="list-item"
        class:watched={grayOutWatched && 'watched' in item && item.watched}
        class:highlighted={highlightedIndex === i}
        onclick={() => onItemClick(item)}
        oncontextmenu={(e) => onShowContextMenu(item, e, { layout: 'list' })}
      >
        <div class="poster" class:has-image={!!item.posterPath} class:fixed-aspect-ratio={fixedAspectRatio}>
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
</div>
        <div class="info">
          <div class="title-line">
            <h3 class="title" title={displayTitle}>{displayTitle}</h3>
            {#if item.year}
              <span class="year">({item.year})</span>
            {/if}
          </div>
          {#if overview}
            <p class="overview">{overview}</p>
          {/if}
        </div>
      </button>
    {/each}
  {:else}
    <p class="empty-message">No items match your filter.</p>
  {/if}
</div>

<style>
  .empty-message {
    padding: 1.5rem;
    color: var(--ev-c-text-2);
  }
  .media-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.5rem;
    width: 100%;
    align-content: start;
    flex: 1;
  }
  .list-item {
    background-color: var(--color-background-soft);
    border: 1px solid var(--color-background-mute);
    padding: 0.75rem;
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: left;
    display: flex;
    gap: 1rem;
    width: 100%;
    border-radius: 8px;
    transition:
      background-color 0.2s ease,
      transform 0.2s ease;
  }
  .list-item:hover {
    background-color: var(--color-background-mute);
    transform: translateY(-2px);
  }
.poster {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--color-background);
    border-radius: 4px;
    height: 120px;
    flex-shrink: 0;
    overflow: hidden;
    /* Default is variable aspect, width comes from content */
    width: auto;
  }

  .poster img {
    display: block;
    height: 100%;
    width: auto;
  }

  /* --- Overrides --- */

  /* Give placeholder a fixed 2:3 width */
  .poster:not(.has-image) {
    width: 80px;
  }

  /* Force fixed 2:3 aspect ratio for search results etc. */
  .poster.fixed-aspect-ratio {
    width: 80px;
  }

  .poster.fixed-aspect-ratio img {
    width: 100%;
    object-fit: cover;
  }
  .icon {
    font-size: 2.5rem;
  }
  .info {
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    overflow: hidden;
  }
  .title-line {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .title {
    font-size: 1.2rem;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .year {
    color: var(--ev-c-text-2);
    font-size: 1rem;
    flex-shrink: 0;
  }
  .overview {
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.5;
  }
  .list-item.watched {
    opacity: 0.6;
    transition: opacity 0.2s ease;
  }
  .list-item.watched:hover {
    opacity: 1;
  }
  .list-item.highlighted {
    background-color: var(--ev-c-gray-2);
    border-color: var(--ev-c-gray-1);
    transform: translateY(-2px) scale(1.01);
  }
</style>
