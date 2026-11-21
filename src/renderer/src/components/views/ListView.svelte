<script lang="ts">
  import { prefersReducedMotion } from 'svelte/motion'
  import WatchedIndicator from '@components/ui/WatchedIndicator.svelte'
  import Icon from '@components/ui/Icon.svelte'
  import { shouldBeGreyedOut } from '@lib/view-helpers'
  import { getAssetUrl } from '@lib/api'
  import type { LibraryItem, MediaFolder, SearchIndexEntry } from '@shared/types'
  type DisplayableItem = LibraryItem | SearchIndexEntry

  let {
    items,
    onItemClick,
    onShowContextMenu,
    highlightedIndex,
    grayOutWatched,
    parentItem,
    listDescriptionRows,
    fixedAspectRatio = false
  }: {
    items: DisplayableItem[]
    onItemClick: (item: DisplayableItem) => void
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string; parentItem?: LibraryItem }
    ) => void
    highlightedIndex?: number | null
    grayOutWatched: boolean
    parentItem?: MediaFolder
    listDescriptionRows?: number | null
    fixedAspectRatio?: boolean
  } = $props()

  const itemHeightRem = $derived.by(() => {
    // If setting is not defined, let height be auto.
    if (listDescriptionRows == null) return 'auto'

    // Constants based on CSS (in rem units)
    const PADDING_V = 1.5 // 0.75rem top + 0.75rem bottom
    const TITLE_LINE_HEIGHT = 1.92 // 1.2rem font-size * 1.6 body line-height
    const INFO_GAP = 0.5
    const DESC_LINE_HEIGHT = 1.35 // 0.9rem font-size * 1.5 line-height

    const descriptionHeight = listDescriptionRows * DESC_LINE_HEIGHT
    // The gap is only present if there are description rows to be separated from the title.
    const gapHeight = listDescriptionRows > 0 ? INFO_GAP : 0

    const totalHeight = PADDING_V + TITLE_LINE_HEIGHT + gapHeight + descriptionHeight
    return `${totalHeight}rem`
  })

  let listElement: HTMLDivElement | undefined = $state()
  let lastHighlightedIndex = $state<number | null>(highlightedIndex ?? null)

  $effect(() => {
    // Only scroll into view if the highlight actually MOVED while the component is active.
    // This prevents the "scroll to top" glitch on mount when ScrollPersistence is trying to restore.
    const hasMoved = highlightedIndex !== lastHighlightedIndex
    lastHighlightedIndex = highlightedIndex ?? null

    if (
      hasMoved &&
      listElement &&
      highlightedIndex !== null &&
      highlightedIndex >= 0 &&
      items.length > highlightedIndex &&
      listElement.children.length > highlightedIndex
    ) {
      const itemElement = listElement.children[highlightedIndex] as HTMLElement
      itemElement?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion.current ? 'instant' : 'smooth' })
    }
  })
</script>

<div class="media-list" bind:this={listElement}>
  {#if items.length > 0}
    {#each items as item, i (item.id)}
      {@const baseTitle = item.title ?? ('name' in item ? (item as LibraryItem).name : '')}
      {@const displayTitle =
        'episodeNumber' in item && item.mediaType === 'episode' && item.episodeNumber != null
          ? `${item.episodeNumber}. ${baseTitle}`
          : baseTitle}
      {@const overview = 'overview' in item ? item.overview : ''}
      <div class="list-row">
        <button
          type="button"
          class="list-item collection-row"
          class:thumbnail-action={item.mediaType === 'episode'}
          class:single-line={listDescriptionRows === 0}
          style:--row-height={itemHeightRem}
          class:watched={shouldBeGreyedOut(item, parentItem, grayOutWatched)}
          class:highlighted={highlightedIndex === i}
          class:missing={item.isMissing}
          onclick={() => onItemClick(item)}
          oncontextmenu={(e) =>
            onShowContextMenu(item, e, { layout: 'list', parentItem: parentItem as LibraryItem })}
          class:has-watch-toggle={item.mediaType === 'episode'}
        >
          {#if !item.posterPath && listDescriptionRows === 0}
            <div class="icon-only">
              <Icon name={item.type === 'folder' ? 'folder' : 'film'} size={20} />
            </div>
          {:else}
            <div
              class="poster"
              class:has-image={!!item.posterPath}
              class:landscape={item.mediaType === 'episode'}
              class:fixed-aspect-ratio={fixedAspectRatio || !item.posterPath}
            >
              {#if item.posterPath}
                <img
                  src={getAssetUrl(item.posterPath + (item._v ? `?v=${item._v}` : ''))}
                  alt=""
                  loading="lazy"
                />
              {:else}
                <div class="icon">
                  <Icon name={item.type === 'folder' ? 'folder' : 'film'} size={20} />
                </div>
              {/if}
            </div>
          {/if}
          <div class="info">
            <div class="title-line">
              <h3 class="title" title={displayTitle}>
                {#if item.isMissing}<span class="missing-icon"><Icon name="warning" size={17} /></span>{/if}
                {displayTitle}
              </h3>
              {#if item.year}
                <span class="year">({item.year})</span>
              {/if}
              {#if item.type === 'folder' && 'matchingFiles' in item && item.matchingFiles?.length}
                <span class="matching-files">{item.matchingFiles.length} matching {item.matchingFiles.length === 1 ? 'file' : 'files'}</span>
              {/if}
            </div>
            {#if overview && listDescriptionRows > 0}
              <p class="overview" style="--description-rows: {listDescriptionRows}">{overview}</p>
            {/if}
          </div>
        </button>
        {#if item.mediaType === 'episode'}
          <div class="watch-toggle">
            <WatchedIndicator itemId={item.id} title={displayTitle} watched={item.watched} />
          </div>
        {/if}
      </div>
    {/each}
  {:else}
    <p class="empty-message">No items match your filter.</p>
  {/if}
</div>

<style>
  .matching-files {
    flex: none;
    font-size: 0.8rem;
    color: var(--color-text-soft);
  }

  .empty-message {
    padding: 1.5rem;
    color: var(--ev-c-text-2);
  }
  .media-list {
    display: flex;
    flex-direction: column;
    gap: .5rem;
    padding: .3rem 0;
    width: 100%;
    align-content: start;
    flex: 1;
  }
  .list-row { position: relative; min-width: 0; }
  .watch-toggle { position: absolute; inset-block-start: .5rem; inset-inline-end: .4rem; }
  .list-item.single-line + .watch-toggle { inset-block-start: 50%; translate: 0 -50%; }
  .list-item {
    --row-hover-surface: var(--collection-row-hover, color-mix(in srgb, var(--color-hover) 25%, transparent));
    background: var(--collection-row-background, var(--surface-raised));
    border: 1px solid var(--collection-row-border, var(--color-border-soft));
    box-shadow: var(--collection-row-shadow, var(--edge-light));
    padding: 0.75rem;
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: left;
    display: flex;
    gap: 1rem;
    width: 100%;
    border-radius: 11px;
    align-items: flex-start;
    height: var(--row-height, auto);
  }
  .list-item.has-watch-toggle { padding-inline-end: 2.7rem; }
  .list-item.single-line {
    align-items: center;
  }
  .list-item:is(:hover, :focus-visible) {
    border-color: #907c6c;
  }
  .list-item::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: var(--accent-surface);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--row-highlight-motion);
  }
  .list-item.highlighted::after { opacity: 1; }

  /* --- Base Poster & Image Styles --- */
  .poster {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-inset);
    border-radius: var(--radius-field);
    flex-shrink: 0;
    overflow: hidden;
    align-self: stretch; /* Take full height of the parent row */
    max-height: 100%;
  }
  .poster img {
    display: block;
    max-width: 100%;
    max-height: 100%;
    border-radius: inherit;
  }
  /* By default, poster with image has explicit aspect ratio based on content type */
  .poster.has-image {
    width: auto;
    height: 100%;
    aspect-ratio: 2 / 3; /* Default to vertical */
    background-color: transparent;
  }
  .poster.has-image.landscape {
    aspect-ratio: 16 / 9;
  }

  /* Placeholder icon has a fixed width */
  .poster:not(.has-image) {
    width: 80px;
  }

  /* --- Fixed Aspect Ratio Mode (for Search Results and Icons) --- */
  .poster.fixed-aspect-ratio {
    height: 100%;
    width: auto;
    aspect-ratio: 2 / 3 !important;
    align-self: center;
    display: flex;
    background-color: var(--color-background);
  }
  .poster.fixed-aspect-ratio img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .icon { display: grid; place-items: center; color: var(--color-text-dim); }
  .icon-only {
    font-size: 1.2rem; /* Match title font size */
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  /* --- Info & Text Styles --- */
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
    font-size: clamp(.9rem, 2vw, 1.1rem);
    font-weight: 670;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .year {
    color: var(--ev-c-text-2);
    font-size: .8rem;
    flex-shrink: 0;
  }
  .overview {
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
    line-height: 1.5;
    max-height: calc(var(--description-rows, 3) * 1.5em);
    display: -webkit-box;
    line-clamp: var(--description-rows, 3);
    -webkit-line-clamp: var(--description-rows, 3);
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* --- State-based Styles --- */
  .list-item.watched :is(.poster, .title, .overview, .year, .icon-only) {
    transition: opacity var(--row-highlight-motion);
  }
  .list-item.watched:not(:is(:hover, :focus-visible)) :is(.poster, .title, .overview, .year, .icon-only) {
    opacity: .6;
  }
  .list-item.highlighted {
    border-color: var(--accent-border);
  }
  .list-item.missing {
    opacity: 0.6;
  }
  .list-item.missing .poster {
    filter: grayscale(1);
  }
  .list-item.missing .title {
    font-style: italic;
  }
  .list-item.missing:hover {
    opacity: 0.8;
  }
  .missing-icon {
    display: inline-flex;
    margin-inline-end: .4rem;
    color: var(--color-danger-soft);
    vertical-align: middle;
  }

  /* --- Full Backdrop Mode Styles --- */
  :global(.full-backdrop-mode) .list-item {
    --row-hover-surface: var(--surface-raised);
    background: var(--collection-row-background, var(--surface-over-artwork));
    border-color: var(--collection-row-border, rgba(255, 255, 255, 0.1));
  }
  :global(.full-backdrop-mode) .list-item:is(:hover, :focus-visible) {
    border-color: rgba(255, 255, 255, 0.2);
  }
  :global(.full-backdrop-mode) .list-item.highlighted {
    border-color: rgba(255, 255, 255, 0.25);
  }
  @media (max-width: 620px) {
    .list-item { height: auto; padding: .55rem; gap: .65rem; align-items: center; }
    .list-item.has-watch-toggle { padding-inline-end: 2.55rem; }
    .watch-toggle { inset-block-start: .25rem; inset-inline-end: .25rem; }
    .poster, .poster.has-image, .poster.fixed-aspect-ratio { width: clamp(48px, 17vw, 72px); height: auto; align-self: start; }
    .poster:not(.has-image) { aspect-ratio: 2 / 3; }
    .poster.has-image.landscape:not(.fixed-aspect-ratio) { width: clamp(60px, 24vw, 112px); }
    .single-line .poster, .single-line .poster.has-image { width: 29px; }
    .title-line { flex-wrap: wrap; gap: .15rem .4rem; }
    .title { white-space: normal; overflow-wrap: anywhere; }
    .info { gap: .25rem; }
    .overview { font-size: .82rem; }
  }
</style>
