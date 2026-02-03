<script lang="ts">
  import type { LibraryItem, MediaFolder, SearchIndexEntry } from '../../../../shared/types'

  import { shouldBeGreyedOut } from '../../lib/view-helpers'
  import { getAssetUrl } from '../../lib/api'
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
    gridPosterSize
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
  } = $props()
</script>

<div
  class="media-grid"
  style={gridPosterSize ? `--local-grid-poster-size: ${gridPosterSize}px` : ''}
>
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
        class:watched={shouldBeGreyedOut(item, parentItem, grayOutWatched)}
        class:missing={item.isMissing}
        onclick={() => onItemClick(item)}
        oncontextmenu={(e) => onShowContextMenu(item, e, { layout: 'grid' })}
      >
        <div class="poster">
          {#if item.posterPath}
            <img
              src={getAssetUrl(item.posterPath + (item._v ? `?v=${item._v}` : ''))}
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
    /* Use the local variable if it exists, otherwise fall back to the global one. */
    grid-template-columns: repeat(
      auto-fill,
      minmax(var(--local-grid-poster-size, var(--grid-poster-size)), 1fr)
    );
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
</style>
