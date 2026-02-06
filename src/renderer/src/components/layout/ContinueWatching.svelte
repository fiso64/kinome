<script lang="ts">
  import type { MediaFolder, MediaFile, LibraryItem } from '@shared/types'
  import { createEventDispatcher } from 'svelte'
  import ContinueWatchingItem from './ContinueWatchingItem.svelte'

  type ContinueWatchingData = {
    show: MediaFolder
    nextEpisode: MediaFile
  }

  let {
    items
  }: {
    items: ContinueWatchingData[]
  } = $props()

  const dispatch = createEventDispatcher<{
    dismiss: { showId: string }
    itemClick: { item: LibraryItem }
  }>()
</script>

<div class="continue-watching-list">
  {#each items as item (item.show.id)}
    <ContinueWatchingItem
      {item}
      on:dismiss={(e) => dispatch('dismiss', e.detail)}
      on:itemClick={(e) => dispatch('itemClick', e.detail)}
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
    padding: 0.5rem 1.5rem 8rem 1.5rem;
    align-items: flex-start; /* Prevents items from stretching to match hovered item's height */
    /* Add negative bottom margin to pull the following content back up, counteracting the padding */
    margin-bottom: -6.5rem;
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
