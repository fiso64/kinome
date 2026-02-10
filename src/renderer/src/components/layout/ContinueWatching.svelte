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
    <ContinueWatchingItem
      {item}
      {glass}
      on:dismiss={(e) => dispatch('dismiss', e.detail)}
      on:itemClick={(e) => dispatch('itemClick', e.detail)}
      on:showContextMenu={(e) => dispatch('showContextMenu', e.detail)}
    />
  {/each}
</div>

<style>
  .continue-watching-list {
    display: flex;
    overflow-x: auto;
    overflow-y: visible; /* Allow popups to be visible outside the list's initial bounds */
    gap: 1.5rem;
    /* Increase bottom padding to make space for the popup to appear without being clipped */
    padding: 0.5rem 0 1rem 0;
    align-items: flex-start;
  }

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
