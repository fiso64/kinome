<script lang="ts">
  import type { LibraryItem, MediaFolder, SearchIndexEntry } from '@shared/types'

  import MediaView from '../layout/MediaView.svelte'
  import ViewContextProvider from '../layout/ViewContextProvider.svelte'
  // import { triggerSeasonEpisodeFetch } from '@lib/item-store'
  import type { AutocompleteSuggestions, Settings } from '@shared/types'

  type DisplayableItem = LibraryItem | SearchIndexEntry

  let {
    container,
    folders,
    onItemClick,
    onShowContextMenu,
    suggestions,
    settings,
    viewNode
  }: {
    container?: MediaFolder
    folders: (MediaFolder)[]
    onItemClick: (item: DisplayableItem) => void
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string; parentItem?: LibraryItem }
    ) => void
    suggestions?: AutocompleteSuggestions
    settings?: Settings | null
    viewNode?: import('@shared/types').ViewHierarchyNode
  } = $props()

  // When the view is rendered, trigger fetches for all visible season folders.
  $effect(() => {
    for (const folder of folders) {
      // triggerSeasonEpisodeFetch(folder)
    }
  })
</script>

<div class="sections-view">
  {#if folders.length > 0}
    {#each folders as folder (folder.id)}
      {@const childNode = viewNode?.children?.[folder.id]}
      <ViewContextProvider id={folder.id} extend={true}>
        <section class="content-section">
          <h2
            class="section-title"
            onclick={() => onItemClick(folder)}
            oncontextmenu={(e) =>
              onShowContextMenu(folder, e, {
                layout: 'sections',
                parentItem: container as LibraryItem
              })}
          >
            {folder.title ?? folder.name}
          </h2>
          <MediaView
            parentItem={folder}
            items={folder.children ?? []}
            {onItemClick}
            {onShowContextMenu}
            {suggestions}
            {settings}
            viewNode={childNode}
            contextParent={container as LibraryItem}
          />
        </section>
      </ViewContextProvider>
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
  .section-title:hover {
    color: var(--ev-c-white-soft);
  }
  :global(.full-backdrop-mode) .section-title {
    background-color: rgba(30, 30, 33, 0.7);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-color: rgba(255, 255, 255, 0.1);
    padding-left: 1rem;
    padding-right: 1rem;
    padding-top: 0.5rem;
    margin-left: 0.5rem;
    margin-right: 0.5rem;
    border-radius: 6px;
    border-bottom-style: solid;
  }
</style>
