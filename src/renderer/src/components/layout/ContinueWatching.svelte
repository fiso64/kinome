<script lang="ts">
  import type { MediaFolder, MediaFile, LibraryItem } from '@shared/types'
  import { createEventDispatcher } from 'svelte'
  import ContinueWatchingItem from './ContinueWatchingItem.svelte'

  type ContinueWatchingData = {
    show: MediaFolder
    nextEpisode: MediaFile
  }

  let {
    items,
    glass = false
  }: {
    items: ContinueWatchingData[]
    glass?: boolean
  } = $props()

  const dispatch = createEventDispatcher<{
    dismiss: { showId: string }
    itemClick: { item: LibraryItem }
    showContextMenu: { item: LibraryItem; event: MouseEvent }
  }>()
</script>

<div class="continue-watching-list">
  {#each items as item (item.show.id)}
    <div class="card-hover-area">
      <ContinueWatchingItem
        {item}
        {glass}
        on:dismiss={(e) => dispatch('dismiss', e.detail)}
        on:itemClick={(e) => dispatch('itemClick', e.detail)}
        on:showContextMenu={(e) => dispatch('showContextMenu', e.detail)}
      />
    </div>
  {/each}
</div>

<style>
  .continue-watching-list {
    display: flex;
    overflow-x: auto;
    gap: .85rem;
    padding: var(--card-hover-gutter);
    align-items: flex-start;
  }

  .card-hover-area { flex: none; }

  .continue-watching-list::-webkit-scrollbar {
    height: 8px;
  }
  .continue-watching-list::-webkit-scrollbar-track {
    background: transparent;
  }
  .continue-watching-list::-webkit-scrollbar-thumb {
    background-color: var(--ev-c-gray-3);
    border-radius: 4px;
  }
  .continue-watching-list::-webkit-scrollbar-thumb:hover {
    background-color: var(--ev-c-gray-2);
  }
</style>
