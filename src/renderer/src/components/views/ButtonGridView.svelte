<script lang="ts">
  import ScrollableGrid from './ScrollableGrid.svelte'
  import type { LibraryItem, MediaFolder, SearchIndexEntry } from '@shared/types'

  import { shouldBeGreyedOut } from '@lib/view-helpers'
  import { getAssetUrl } from '@lib/api'

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

  function itemHue(str: string): number {
    if (str === 'Uncategorized') return 210
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash)
    }
    return Math.abs(hash) % 360
  }
</script>

<ScrollableGrid stateKey="button-grid" hasItems={items.length > 0} columnWidth={gridPosterSize}
  showScrollbar={showHorizontalScrollbar} horizontal={scrollHorizontally ?? false} fill>
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
</ScrollableGrid>

<style>
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
</style>
