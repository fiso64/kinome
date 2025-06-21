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
      options?: { layout?: string }
    ) => void
    highlightedIndex?: number | null
    grayOutWatched: boolean
    parentItem?: MediaFolder | VirtualFolder
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
      {@const displayTitle =
        'episodeNumber' in item && item.mediaType === 'episode' && item.episodeNumber != null
          ? `${item.episodeNumber}. ${baseTitle}`
          : baseTitle}
      {@const overview = 'overview' in item ? item.overview : ''}
      <button
        type="button"
        class="list-item"
        style:height={fixedAspectRatio ? 'auto' : itemHeightRem}
        class:watched={shouldBeGreyedOut(item, parentItem, grayOutWatched)}
        class:highlighted={highlightedIndex === i}
        onclick={() => onItemClick(item)}
        oncontextmenu={(e) => onShowContextMenu(item, e, { layout: 'list' })}
      >
        <div
          class="poster"
          class:has-image={!!item.posterPath}
          class:fixed-aspect-ratio={fixedAspectRatio || !item.posterPath}
        >
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
          {#if overview && listDescriptionRows > 0}
            <p class="overview" style="--description-rows: {listDescriptionRows}">{overview}</p>
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
      align-items: flex-start; /* Align children (poster, info) to the top */
    }
    .list-item:hover {
      background-color: var(--color-background-mute);
      transform: translateY(-2px);
    }
  
    /* --- Base Poster & Image Styles --- */
    .poster {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      background-color: var(--color-background);
      border-radius: 4px;
      flex-shrink: 0;
      overflow: hidden;
      align-self: stretch; /* Take full height of the parent row */
      max-height: 100%;
    }
    .poster img {
      display: block;
      height: 100%;
      width: 100%;
      object-fit: contain;
    }
    /* By default, poster with image has auto width to respect aspect ratio */
    .poster.has-image {
      width: auto;
    }
    .poster.has-image img {
      width: auto;
    }
    /* Placeholder icon has a fixed width */
    .poster:not(.has-image) {
      width: 80px;
    }
  
    /* --- Fixed Aspect Ratio Mode (for Search Results and Icons) --- */
    .poster.fixed-aspect-ratio {
      height: 100%;
      width: auto;
      aspect-ratio: 2 / 3;
      align-self: center;
      container-type: size; /* Enable container queries */
    }
    .poster.fixed-aspect-ratio img {
      object-fit: cover; /* Fill the 2:3 container */
    }
  
    /* --- Icon Specific Styles --- */
    .icon {
      font-size: 2.5rem; /* Fallback font size */
    }
    /* Only apply container query scaling to icons inside the fixed-ratio box */
    .poster.fixed-aspect-ratio .icon {
      font-size: 40cqh;
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
      line-height: 1.5;
      max-height: calc(var(--description-rows, 3) * 1.5em);
      display: -webkit-box;
      -webkit-line-clamp: var(--description-rows, 3);
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
  
    /* --- State-based Styles --- */
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
