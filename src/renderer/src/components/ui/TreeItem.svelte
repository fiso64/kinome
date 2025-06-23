<script lang="ts">
  import { slide } from 'svelte/transition'
  import TreeItem from './TreeItem.svelte'
  import { getLoadedItem, triggerSeasonEpisodeFetch } from '../../lib/item-store'
  import { shouldBeGreyedOut } from '../../lib/view-helpers'
  // Types are globally available from src/preload/index.d.ts
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
    showContextMenu: (item: LibraryItem, event: MouseEvent) => void
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

  async function handleItemClick() {
    if (item.type === 'file') {
      itemclick(item)
      return
    }

    // --- Lazy loading logic for folders ---
    // This is now essential as the backend only sends shallow data.
    if (item.type === 'folder' && !isExpanded) {
      // If children are null, it means they have not been loaded yet.
      // This check is now reliable because the backend consistently sends shallow objects.
      if (item.children === null) {
        // This will now correctly log a "Cache MISS" on the first expand,
        // then fetch the children.
        const loadedItem = await getLoadedItem(item.id)
        // By re-assigning the properties of the item from the now-loaded
        // version in the cache, we update our local `item` prop.
        if (loadedItem) {
          Object.assign(item, loadedItem)
        }
      }
      // If it's a season folder that hasn't had its episode data fetched yet,
      // trigger the detail fetch.
      triggerSeasonEpisodeFetch(item)
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
  <button
    type="button"
    class="tree-item"
    class:watched={shouldBeGreyedOut(item, parentItem, grayOutWatched)}
    class:missing={item.isMissing}
    onclick={handleItemClick}
    oncontextmenu={(e) => showContextMenu(item, e)}
  >
    <div class="poster" style:margin-left={`${level * 24}px`}>
      {#if item.type === 'folder'}
        <span class="chevron">{isExpanded ? '▾' : '▸'}</span>
      {/if}
      <div class="icon">
        {#if item.posterPath}
          <img
            src="media-browser-asset://images/{item.posterPath}{item._v ? `?v=${item._v}` : ''}"
            alt={item.title ?? item.name}
            loading="lazy"
          />
        {:else}
          {item.type === 'folder' ? '📁' : '🎬'}
        {/if}
      </div>
    </div>

    <div class="name" title={displayTitle}>
      {#if item.isMissing}<span class="missing-icon">⚠️</span>{/if}
      {displayTitle}
    </div>
  </button>

  {#if item.type === 'folder' && isExpanded}
    <div class="children" transition:slide={{ duration: 200 }}>
      {#each item.children as child (child.id)}
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
  .tree-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem;
    border-radius: 6px;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .tree-item:hover {
    background-color: var(--color-background-soft);
  }
  .poster {
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
    background-color: var(--color-background-soft);
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
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tree-item.watched {
    opacity: 0.6;
    transition: opacity 0.2s ease;
  }
  .tree-item.watched:hover {
    opacity: 1;
  }
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
</style>
