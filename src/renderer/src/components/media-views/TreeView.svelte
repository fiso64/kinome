<script lang="ts">
  import TreeItem from '../TreeItem.svelte'

  type DisplayableItem = LibraryItem | SearchIndexEntry

  let {
    items,
    onItemClick,
    onShowContextMenu,
    grayOutWatched
  }: {
    items: DisplayableItem[]
    onItemClick: (item: DisplayableItem) => void
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string }
    ) => void
    grayOutWatched: boolean
  } = $props()
</script>

<div class="media-tree">
  {#if items.length > 0}
    {#each items as item (item.id)}
      <TreeItem
        item={item as LibraryItem}
        itemclick={onItemClick as (item: LibraryItem) => void}
        showContextMenu={(treeItem, event) =>
          onShowContextMenu(treeItem, event, { layout: 'tree' })}
        {grayOutWatched}
      />
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
  .media-tree {
    display: flex;
    flex-direction: column;
    padding: 0 0.5rem;
    flex: 1;
  }
</style>
