<script lang="ts">
  import type { LibraryItem, MediaFolder, SearchIndexEntry } from '@shared/types'

  import TreeItem from '../ui/TreeItem.svelte'

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
    parentItem
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
        {parentItem}
        level={0}
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
