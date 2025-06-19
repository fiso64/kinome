<script lang="ts">
  import MediaView from '../MediaView.svelte'
  import { triggerSeasonEpisodeFetch } from '../../lib/item-store'

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
    suggestions,
    grayOutWatched,
    settings
  }: {
    folders: (MediaFolder | VirtualFolder)[]
    onItemClick: (item: DisplayableItem) => void
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string }
    ) => void
    suggestions?: AutocompleteSuggestions
    grayOutWatched: boolean
    settings?: Settings | null
  } = $props()

  // When the view is rendered, trigger fetches for all visible season folders.
  $effect(() => {
    for (const folder of folders) {
      triggerSeasonEpisodeFetch(folder)
    }
  })

  function calculateLayout(folder: MediaFolder): 'grid' | 'list' | 'tree' | 'tabs' | 'sections' {
    if (folder.layout) return folder.layout
    if (settings) {
      switch (folder.mediaType) {
        case 'movie':
          return settings.defaultMovieFolderLayout ?? 'tree'
        case 'tv':
          return settings.defaultTvShowFolderLayout ?? 'list'
        case 'season':
          return settings.defaultSeasonFolderLayout ?? 'list'
      }
      if (settings.defaultFolderLayout) return settings.defaultFolderLayout
    }
    return 'grid'
  }
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
          layout={calculateLayout(folder)}
          {onShowContextMenu}
          {suggestions}
          {grayOutWatched}
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
