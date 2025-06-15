<script lang="ts">
  import { slide } from 'svelte/transition'
  import TreeItem from './TreeItem.svelte'
  // Types are globally available from src/preload/index.d.ts
  let {
    item,
    itemclick,
    showContextMenu,
    level = 0
  }: {
    item: LibraryItem
    itemclick: (item: LibraryItem) => void
    showContextMenu: (item: LibraryItem, event: MouseEvent) => void
    level: number
  } = $props()

  let isExpanded = $state(false)

  function handleItemClick() {
    // Files are played, folders are expanded/collapsed
    if (item.type === 'file') {
      itemclick(item)
    } else {
      isExpanded = !isExpanded
    }
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
    onclick={handleItemClick}
    oncontextmenu={(e) => showContextMenu(item, e)}
  >
    <div class="poster" style:margin-left={`${level * 24}px`}>
      {#if item.type === 'folder'}
        <span class="chevron">{isExpanded ? '▾' : '▸'}</span>
      {/if}
      <div
        class="icon"
        style:background-image={item.posterPath
          ? `url(media-browser-asset://images/${item.posterPath})`
          : 'none'}
      >
        {#if !item.posterPath}
          {item.type === 'folder' ? '📁' : '📄'}
        {/if}
      </div>
    </div>

    <div class="name" title={item.title ?? item.name}>
      {item.title ?? item.name}
    </div>

    {#if item.type === 'file' && item.watched}
      <div class="watched-indicator" title="Watched">✔</div>
    {/if}
  </button>

  {#if item.type === 'folder' && isExpanded}
    <div class="children" transition:slide={{ duration: 200 }}>
      {#each item.children as child (child.id)}
        <TreeItem item={child} {itemclick} {showContextMenu} level={level + 1} />
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
    background-size: cover;
    background-position: center;
    border-radius: 4px;
    background-color: var(--color-background-soft);
    font-size: 1.5rem;
  }
  .name {
    flex-grow: 1;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .watched-indicator {
    background-color: #4caf50;
    color: white;
    border-radius: 50%;
    width: 20px;
    height: 20px;
    font-size: 12px;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-left: auto;
    margin-right: 0.5rem;
  }
  .children {
    overflow: hidden;
  }
</style>
