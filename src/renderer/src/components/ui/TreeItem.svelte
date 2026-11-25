<script module lang="ts">
  import { bluRayMark, codecMarks, type FormatMark } from '../../assets/format-marks'

  const codecLabels = new Map([['mpeg2video', 'MPEG-2'], ['mpeg4', 'MPEG-4'], ['vc1', 'VC-1']])
  const resolutionLabels = new Map([
    [360, '360p'], [480, '480p'], [576, '576p'], [720, '720p'],
    [1080, '1080p'], [1440, '1440p'], [2160, '4K'], [4320, '8K']
  ])
  const landscapeWidths = new Map([[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160], [7680, 4320]])
  const sourceLabels = new Map([
    ['brrip', 'BRRip'],
    ['webdl', 'WEB-DL'], ['webrip', 'WEBRip'], ['hdtv', 'HDTV'], ['dvdrip', 'DVDRip'], ['dvd', 'DVD'],
    ['remux', 'Remux']
  ])
  const bluRayReleases = new Map([['bluray', ''], ['bdrip', 'Rip'], ['bdremux', 'Remux'], ['blurayremux', 'Remux']])
  const releasePattern = /(?:^|[\s._[(\-])(blu[ ._-]?ray(?:[ ._-]+remux)?|bd(?:rip|remux)|brrip|web[ ._-]?(?:dl|rip)|hdtv|dvd(?:rip)?|remux)(?=$|[\s._\])\-])/i
  const treeFields = getRequiredFieldsForLayout('tree')

  function getFileFacts(item: Extract<LibraryItem, { type: 'file' }>) {
    const { width, height, codec, durationSeconds } = item.videoSummary ?? {}
    const duration = durationSeconds != null && durationSeconds > 0 && Number.isFinite(durationSeconds)
      ? formatClockTime(durationSeconds)
      : undefined
    const dimensions = width && height ? `${width} × ${height}` : undefined
    // Keep the resolution tier for encodes cropped to a wider aspect ratio.
    const tierHeight = width && height && width > height ? landscapeWidths.get(width) : undefined
    const resolution = resolutionLabels.get(Math.max(tierHeight ?? 0, height ?? 0))
      ?? dimensions ?? (height ? `${height}p` : undefined)
    const source = releasePattern.exec(item.name)?.[1].toLowerCase().replace(/[ ._-]/g, '')
    const sourceLabel = source ? sourceLabels.get(source) : undefined
    const bluRaySuffix = source ? bluRayReleases.get(source) : undefined
    const codecMark = codec ? codecMarks.get(codec) : undefined
    const codecLabel = codecMark?.label ?? (codec ? codecLabels.get(codec) ?? codec.toUpperCase() : undefined)
    const size = item.size != null && item.size >= 0 ? formatBytes(item.size, 1) : undefined
    return { duration, dimensions, resolution, codecMark, codecLabel, sourceLabel, bluRaySuffix, size }
  }
</script>

<script lang="ts">
  import { displayTitle as itemTitle } from '@lib/view-helpers'
  import WatchedIndicator from '@components/ui/WatchedIndicator.svelte'
  import Icon from '@components/ui/Icon.svelte'
  import { untrack } from 'svelte'
  import { prefersReducedMotion } from 'svelte/motion'
  import { slide } from 'svelte/transition'
  import TreeItem from './TreeItem.svelte'
  import { getAssetUrl } from '@lib/api'
  import { formatBytes, formatClockTime, shouldBeGreyedOut } from '@lib/view-helpers'
  import { getRequiredFieldsForLayout } from '@lib/view-requirements'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import type { LibraryItem, MediaFolder } from '@shared/types'

  let {
    item,
    itemclick,
    showContextMenu,
    level = 0,
    grayOutWatched,
    parentItem
  }: {
    item: LibraryItem
    itemclick: (item: LibraryItem) => void
    showContextMenu: (
      item: LibraryItem,
      event: MouseEvent,
      options?: { parentItem?: LibraryItem }
    ) => void
    level: number
    grayOutWatched: boolean
    parentItem?: MediaFolder
  } = $props()

  let isExpanded = $state(false)

  const displayTitle = $derived(itemTitle(item))

  const facts = $derived(item.type === 'file' ? getFileFacts(item) : undefined)

  // Rows are keyed by item ID, whose kind is stable.
  const childrenQuery = untrack(() => item.type) === 'folder'
    ? libraryDataService.getChildrenQuery(() => item.id, {
        fields: () => treeFields,
        enabled: () => isExpanded
      })
    : undefined

  const effectiveChildren = $derived(childrenQuery?.data ?? (item as MediaFolder).children ?? [])

  async function handleItemClick() {
    if (item.type === 'file') {
      itemclick(item)
      return
    }

    // Toggle expansion state
    isExpanded = !isExpanded
  }

  function handleNavigateClick(e: MouseEvent) {
    // This stops the click from also triggering the main item's click handler
    e.stopPropagation()
    itemclick(item)
  }
</script>

{#snippet formatMark(mark: FormatMark)}
  <svg
    class="format-mark"
    class:av1-mark={mark.label === 'AV1'}
    role="img"
    aria-label={mark.label}
    viewBox={mark.viewBox}
  >
    <title>{mark.label}</title>
    <path d={mark.path} fill="currentColor" fill-rule="evenodd" />
  </svg>
{/snippet}

<div class="tree-item-container">
  <div class="tree-row" data-media-item-id={item.id}>
    <button
      type="button"
      class="tree-item collection-row"
      class:has-watch-toggle={item.mediaType === 'episode'}
      class:thumbnail-action={item.mediaType === 'episode'}
      aria-expanded={item.type === 'folder' ? isExpanded : undefined}
      class:watched={shouldBeGreyedOut(item, parentItem, grayOutWatched)}
      class:missing={item.isMissing}
      onclick={handleItemClick}
      oncontextmenu={(e) => showContextMenu(item, e, { parentItem: parentItem as LibraryItem })}
    >
      <div class="poster" style:--tree-depth={level}>
        {#if item.type === 'folder'}
          <span class="chevron"><Icon name={isExpanded ? 'down' : 'right'} size={15} /></span>
        {/if}
        <div class="icon">
          {#if item.posterPath}
            <img
              src={getAssetUrl(item.posterPath + (item._v ? `?v=${item._v}` : ''))}
              alt="" loading="lazy" decoding="async"
              class="tree-poster"
            />
          {:else}
            <Icon name={item.type === 'folder' ? 'folder' : 'film'} size={20} />
          {/if}
        </div>
      </div>

      <div class="row-label">
        <div class="name" title={displayTitle}>
          {#if item.isMissing}<span class="missing-icon"><Icon name="warning" size={17} /></span>{/if}
          {displayTitle}
        </div>
        {#if facts && (facts.size || facts.duration)}
          <div class="file-size">
            {#if facts.size}<span>{facts.size}</span>{/if}
            {#if facts.duration}
              <span class="file-duration" title="File duration">
                {#if facts.size}<span class="file-detail-dot" aria-hidden="true"></span>{/if}
                {facts.duration}
              </span>
            {/if}
          </div>
        {/if}
      </div>
      {#if facts && (facts.resolution || facts.sourceLabel || facts.bluRaySuffix !== undefined || facts.codecLabel)}
        <div class="media-facts">
          {#if facts.resolution}<span title={facts.dimensions}>{facts.resolution}</span>{/if}
          {#if facts.bluRaySuffix !== undefined}
            <span class="release-source" title="Release source from filename">
              {@render formatMark(bluRayMark)}
              {facts.bluRaySuffix}
            </span>
          {:else if facts.sourceLabel}
            <span title="Release source from filename">{facts.sourceLabel}</span>
          {/if}
          {#if facts.codecMark}
            {@render formatMark(facts.codecMark)}
          {:else if facts.codecLabel}
            <span>{facts.codecLabel}</span>
          {/if}
        </div>
      {/if}
    </button>
    {#if item.mediaType === 'episode'}
      <div class="watch-toggle">
        <WatchedIndicator itemId={item.id} title={displayTitle} watched={item.watched} />
      </div>
    {/if}
  </div>

  {#if item.type === 'folder' && isExpanded}
    <div class="children" in:slide={{ duration: prefersReducedMotion.current ? 0 : 125 }}>
      {#each effectiveChildren as child (child.id)}
        <TreeItem
          item={child}
          {itemclick}
          {showContextMenu}
          level={level + 1}
          {grayOutWatched}
          parentItem={item}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .tree-row { position: relative; }
  .watch-toggle { position: absolute; inset-block-start: 50%; inset-inline-end: .2rem; translate: 0 -50%; }
  .tree-item.has-watch-toggle { padding-inline-end: 2.6rem; }
  .tree-item {
    --row-hover-surface: var(--color-background-soft);
    display: flex;
    align-items: center;
    gap: .65rem;
    width: 100%;
    padding: .42rem;
    border-radius: var(--radius-field);
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .poster {
    margin-inline-start: min(21%, calc(var(--tree-depth, 0) * .95rem));
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
  }
  .chevron {
    width: 1em;
    text-align: center;
    color: var(--ev-c-text-2);
  }
  .icon {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    background-color: var(--color-inset);
    color: var(--color-primary-soft);
    font-size: 1.5rem;
    overflow: hidden; /* To ensure the image respects the border-radius */
  }
  .icon img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .row-label {
    flex-grow: 1;
    min-width: 0;
    text-align: start;
  }
  .name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file-size, .media-facts {
    color: var(--color-text-soft);
    font-size: .73rem;
    line-height: 1.25;
    font-variant-numeric: tabular-nums;
  }
  .file-size {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: .15rem .38rem;
    margin-block-start: .12rem;
  }
  .file-duration {
    display: inline-flex;
    align-items: center;
    gap: .38rem;
  }
  .file-detail-dot {
    flex: none;
    width: .23rem;
    height: .23rem;
    border-radius: 50%;
    background: currentColor;
  }
  .media-facts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: .16rem .48rem;
    max-inline-size: 52%;
    margin-inline-end: .3rem;
    padding: .24rem .45rem;
    border: 1px solid color-mix(in srgb, var(--color-text-soft) 16%, transparent);
    border-radius: calc(var(--radius-field) * .7);
    background: color-mix(in srgb, var(--color-inset) 42%, transparent);
    color: color-mix(in srgb, var(--color-text-dim) 90%, transparent);
    font-size: .81rem;
    font-weight: 600;
  }
  .media-facts span { white-space: nowrap; }
  .release-source {
    display: inline-flex;
    align-items: center;
    gap: .25rem;
  }
  .format-mark {
    flex: none;
    width: auto;
    max-width: 3.1rem;
    height: .69rem;
    opacity: .88;
  }
  .format-mark.av1-mark { height: .88rem; }
  .release-source .format-mark { height: .8rem; }
  .tree-item.watched :is(.poster, .row-label, .media-facts) { transition: opacity var(--row-highlight-motion); }
  .tree-item.watched:not(:is(:hover, :focus-visible)) :is(.poster, .row-label, .media-facts) { opacity: .6; }
  .tree-item.missing {
    opacity: 0.6;
  }
  .tree-item.missing .icon {
    filter: grayscale(1);
  }
  .tree-item.missing .name {
    font-style: italic;
  }
  .tree-item.missing:hover {
    opacity: 0.8;
  }
  .missing-icon {
    display: inline-block;
    margin-right: 0.5rem;
    font-size: 1rem;
  }
  .children {
    overflow: hidden;
  }

  /* --- Full Backdrop Mode Styles --- */
  :global(.full-backdrop-mode) .tree-item {
    --row-hover-surface: var(--collection-row-hover, var(--surface-raised));
    background: var(--collection-row-background, var(--surface-over-artwork));
    border: 1px solid var(--collection-row-border, #ffffff1a);
  }
  :global(.full-backdrop-mode) .tree-item:is(:hover, :focus-visible) {
    border-color: rgba(255, 255, 255, 0.15);
  }
</style>
