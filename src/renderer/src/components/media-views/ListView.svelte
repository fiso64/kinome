<script lang="ts">
  type DisplayableItem = LibraryItem | SearchIndexEntry

  let {
    items,
    onItemClick,
    onShowContextMenu
  }: {
    items: DisplayableItem[]
    onItemClick: (item: DisplayableItem) => void
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string }
    ) => void
  } = $props()
</script>

<div class="media-list">
  {#if items.length > 0}
    {#each items as item (item.id)}
      {@const title = item.title ?? ('name' in item ? (item as LibraryItem).name : '')}
      {@const overview = 'overview' in item ? item.overview : ''}
      <button
        type="button"
        class="list-item"
        class:watched={'watched' in item && item.watched}
        onclick={() => onItemClick(item)}
        oncontextmenu={(e) => onShowContextMenu(item, e, { layout: 'list' })}
      >
        <div class="poster">
          {#if item.posterPath}
            <img
              src="media-browser-asset://images/{item.posterPath}{item._v ? `?v=${item._v}` : ''}"
              alt={title}
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
            <h3 class="title" {title}>{title}</h3>
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
    width: 80px;
    height: 120px;
    flex-shrink: 0;
    overflow: hidden;
  }
  .poster img {
    width: 100%;
    height: 100%;
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
</style>
