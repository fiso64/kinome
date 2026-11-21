<script lang="ts">
  import WatchedIndicator from '@components/ui/WatchedIndicator.svelte'
  import Icon from '@components/ui/Icon.svelte'
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

</script>

<ScrollableGrid stateKey="button-grid" hasItems={items.length > 0} columnWidth={gridPosterSize}
  showScrollbar={showHorizontalScrollbar} horizontal={scrollHorizontally ?? false} fill>
  {#each items as item (item.id)}
    {@const baseTitle = item.title ?? ('name' in item ? (item as LibraryItem).name : '')}
    {@const displayTitle = 'episodeNumber' in item && item.mediaType === 'episode' && item.episodeNumber != null ? `${item.episodeNumber}. ${baseTitle}` : baseTitle}
    {@const bgImage = ('backdropPath' in item && item.backdropPath) ? item.backdropPath : item.posterPath}
    {@const hasImage = !!bgImage}
    <div class="category-card-shell interactive-card" class:episode={item.mediaType === 'episode'} data-media-item-id={item.id}>
      <button
        type="button"
        class="category-card"
        class:artwork-free={!hasImage}
        class:thumbnail-action={item.mediaType === 'episode'}
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
          <div class="artwork">
            <img
              src={getAssetUrl(bgImage + (item._v ? `?v=${item._v}` : ''))}
              alt=""
              loading="lazy"
            />
            <div class="overlay"></div>
          </div>
        {/if}

        <div class="name" title={displayTitle}>
          {displayTitle}
        </div>

        {#if item.isMissing}
          <div class="missing-overlay">
            <span class="missing-icon"><Icon name="warning" size={17} /></span>
          </div>
        {/if}
      </button>
      {#if item.mediaType === 'episode'}
        <div class="watched-mark"><WatchedIndicator itemId={item.id} title={displayTitle} watched={item.watched} /></div>
      {/if}
    </div>
  {/each}
</ScrollableGrid>

<style>
  .category-card-shell { position: relative; min-width: 0; }
  .category-card {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    container-type: inline-size;
    min-width: 0;
    width: 100%;
    min-height: 44px;
    aspect-ratio: 2.5 / 1;
    overflow: hidden;
    padding: .65rem clamp(.95rem, 2.7vw, 2.05rem);
    color: var(--color-text);
    text-align: center;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--control-face);
    box-shadow: var(--control-shadow), 0 4px 12px #0005;
  }
  .category-card.artwork-free {
    background:
      radial-gradient(ellipse at 12% 0%, color-mix(in srgb, var(--color-primary-soft) 9%, transparent), transparent 72%),
      var(--control-face);
    border-color: color-mix(in srgb, var(--accent-border) 38%, var(--color-border));
  }
  .category-card:hover:not(:disabled) { border-color: #9a8773; }
  .category-card:active:not(:disabled) { box-shadow: var(--control-pressed); }
  .artwork, .overlay { position: absolute; inset: 0; pointer-events: none; }
  .artwork img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .overlay { background: linear-gradient(90deg, #0a0a0de3, #0d0d13a6); }
  .name {
    position: relative;
    width: 100%;
    min-width: 0;
    font-size: clamp(.86rem, calc(.75rem + 4cqi), 1.6rem);
    line-height: 1.2;
    font-weight: 680;
    overflow-wrap: anywhere;
  }
  .missing-overlay { position: absolute; inset-inline-end: .55rem; top: 50%; transform: translateY(-50%); display: flex; }
  .watched-mark { position: absolute; inset-inline-end: .2rem; inset-block-start: .2rem; }
  .category-card-shell.episode .missing-overlay { inset-inline: .55rem auto; }
  .category-card.watched:not(:is(:hover, :focus-visible)) :is(.artwork, .name) { opacity: .66; }
  .category-card.missing .artwork { filter: grayscale(1); }
  .missing-overlay { color: var(--color-danger-soft); }
  .missing-icon { display: flex; }
</style>
