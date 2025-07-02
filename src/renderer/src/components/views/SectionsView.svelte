<script lang="ts">
  import MediaView from '../layout/MediaView.svelte'
  import { triggerSeasonEpisodeFetch } from '../../lib/item-store'

  type VirtualFolder = MediaFolder & {
    isVirtual: boolean
    physicalParentId: string
    groupByKey: string
    groupByValue: string
  }
  type DisplayableItem = LibraryItem | SearchIndexEntry

  let {
    container,
    folders,
    onItemClick,
    onShowContextMenu,
    suggestions,
    settings
  }: {
    container?: MediaFolder | VirtualFolder
    folders: (MediaFolder | VirtualFolder)[]
    onItemClick: (item: DisplayableItem) => void
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string }
    ) => void
    suggestions?: AutocompleteSuggestions
    settings?: Settings | null
  } = $props()

  // When the view is rendered, trigger fetches for all visible season folders.
  $effect(() => {
    for (const folder of folders) {
      triggerSeasonEpisodeFetch(folder)
    }
  })
</script>

<div class="sections-view">
  {#if folders.length > 0}
    {#each folders as folder (folder.id)}
      {@const parentForMediaView = { ...folder, ...(container?.childViewSettings ?? {}) }}
      <section class="content-section">
        <h2
          class="section-title"
          onclick={() => onItemClick(folder)}
          oncontextmenu={(e) => onShowContextMenu(folder, e, { layout: 'sections' })}
        >
          {folder.title ?? folder.name}
        </h2>
        <MediaView
          parentItem={parentForMediaView}
          items={folder.children}
          {onItemClick}
          {onShowContextMenu}
          {suggestions}
          {settings}
        />
      </section>
    {/each}
  {:else}
    <p class="empty-message">No folders to display as sections.</p>
  {/if}
</div>

<style>
  .empty-message {
    padding: 1.5rem;
    color: var(--ev-c-text-2);
  }
  .sections-view {
    padding: 1rem 0;
    flex: 1;
  }
  .content-section {
    margin-bottom: 2rem;
  }
  .section-title {
    font-size: 1.5rem;
    font-weight: bold;
    margin: 0 1.5rem 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--color-background-mute);
    cursor: pointer;
  }
  .section-title:hover {
    color: var(--ev-c-white-soft);
  }
</style>
