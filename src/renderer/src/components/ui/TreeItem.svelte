<script lang="ts">
  import WatchedIndicator from '@components/ui/WatchedIndicator.svelte'
  import Icon from '@components/ui/Icon.svelte'
  import { prefersReducedMotion } from 'svelte/motion'
  import { slide } from 'svelte/transition'
  import TreeItem from './TreeItem.svelte'
  import { getAssetUrl } from '@lib/api'
  import { shouldBeGreyedOut } from '@lib/view-helpers'
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

  const displayTitle = $derived(
    item.mediaType === 'episode' && item.episodeNumber != null
      ? `${item.episodeNumber}. ${item.title ?? item.name}`
      : (item.title ?? item.name)
  )

  const childrenQuery = libraryDataService.getChildrenQuery(() => item.id, {
    enabled: () => item.type === 'folder' && isExpanded
  })

  const effectiveChildren = $derived(childrenQuery.data ?? (item as MediaFolder).children ?? [])

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

      <div class="name" title={displayTitle}>
        {#if item.isMissing}<span class="missing-icon"><Icon name="warning" size={17} /></span>{/if}
        {displayTitle}
      </div>
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
  .name {
    flex-grow: 1;
    min-width: 0;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tree-item.watched :is(.poster, .name) { transition: opacity var(--row-highlight-motion); }
  .tree-item.watched:not(:is(:hover, :focus-visible)) :is(.poster, .name) { opacity: .6; }
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
