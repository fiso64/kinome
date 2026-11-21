<script lang="ts">
  import Icon from '@components/ui/Icon.svelte'
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

  const visibleFolders = $derived(folders.filter((folder) => folder.children?.length))
</script>

<div class="sections-view">
  {#if visibleFolders.length > 0}
    {#each visibleFolders as folder (folder.id)}
      {@const childNode = viewNode?.children?.[folder.id]}
      <ViewContextProvider id={folder.id} extend={true}>
        <section class="content-section">
          <h2 class="section-title">
            <button type="button" onclick={() => onItemClick(folder)}
              oncontextmenu={(event) => onShowContextMenu(folder, event, { layout: 'sections', parentItem: container })}>
              <span>{folder.title ?? folder.name}</span>
              <Icon name="right" size={17} />
            </button>
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
  .sections-view { display: grid; flex: 1; gap: clamp(1.3rem, 2.5vw, 2.15rem); min-width: 0; }
  .content-section { min-width: 0; padding-top: .65rem; background: var(--section-rule) 0 0 / 100% 1px no-repeat; }
  .section-title { margin-bottom: .45rem; }
  .section-title button {
    max-width: 100%;
    display: inline-flex;
    align-items: center;
    gap: .46rem;
    padding: .16rem .32rem .16rem 0;
    border: 0;
    color: var(--color-text);
    background: transparent;
    text-align: start;
    font-size: clamp(1.2rem, 1.8vw, 1.5rem);
    font-weight: 660;
    line-height: 1.25;
  }
  .section-title button:is(:hover, :focus-visible) { color: var(--color-primary-soft); background: transparent; }
  .section-title button span { overflow-wrap: anywhere; }
  .section-title button :global(svg) { flex: none; color: var(--color-text-dim); }
  .empty-message { padding: .75rem 0; color: var(--color-text-soft); font-size: .875rem; }
</style>
