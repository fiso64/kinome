<script lang="ts">
  type DisplayableItem = LibraryItem | SearchIndexEntry

  let {
    items,
    onItemClick,
    onShowContextMenu,
    grayOutWatched
  }: {
    items: DisplayableItem[]
    onItemClick: (item: DisplayableItem) => void
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string }
    ) => void
    grayOutWatched: boolean
  } = $props()
</script>

<div class="media-grid">
  {#if items.length > 0}
    {#each items as item (item.id)}
      {@const baseTitle = item.title ?? ('name' in item ? (item as LibraryItem).name : '')}
      {@const displayTitle =
        'episodeNumber' in item && item.mediaType === 'episode' && item.episodeNumber != null
          ? `${item.episodeNumber}. ${baseTitle}`
          : baseTitle}
      <button
        type="button"
        class="grid-item"
        class:watched={grayOutWatched && 'watched' in item && item.watched}
        onclick={() => onItemClick(item)}
        oncontextmenu={(e) => onShowContextMenu(item, e, { layout: 'grid' })}
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
        </div>
        <div class="name" title={displayTitle}>
          {displayTitle}
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
  .media-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--grid-poster-size, 200px), 1fr));
    gap: 1.8rem;
    padding: 1.5rem;
    width: 100%;
    align-content: start;
    flex: 1;
  }
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
</style>
