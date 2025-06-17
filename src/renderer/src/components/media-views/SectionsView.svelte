<script lang="ts">
  import MediaView from '../MediaView.svelte'

  type VirtualFolder = MediaFolder & {
    isVirtual: boolean
    physicalParentId: string
    groupByKey: string
    groupByValue: string
  }
  type DisplayableItem = LibraryItem | SearchIndexEntry

  let {
    folders,
    onItemClick,
    onShowContextMenu,
    suggestions
  }: {
    folders: (MediaFolder | VirtualFolder)[]
    onItemClick: (item: DisplayableItem) => void
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string }
    ) => void
    suggestions?: AutocompleteSuggestions
  } = $props()
</script>

<div class="sections-view">
  {#if folders.length > 0}
    {#each folders as folder (folder.id)}
      <section class="content-section">
        <h2
          class="section-title"
          onclick={() => onItemClick(folder)}
          oncontextmenu={(e) => onShowContextMenu(folder, e, { layout: 'sections' })}
        >
          {folder.title ?? folder.name}
        </h2>
        <MediaView
          parentItem={folder}
          items={folder.children}
          {onItemClick}
          layout={folder.layout ?? 'grid'}
          {onShowContextMenu}
          {suggestions}
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
