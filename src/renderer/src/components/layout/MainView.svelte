<script lang="ts">
  import MediaView from './MediaView.svelte'
  import HomeView from './HomeView.svelte'
  import { createEventDispatcher } from 'svelte'
  import { fade } from 'svelte/transition'
  import { prefersReducedMotion } from 'svelte/motion'
  import Skeleton from '@components/ui/Skeleton.svelte'
  import { navStore } from '@lib/navigation-store.svelte'

  import { getAllRequiredFields } from '@lib/view-requirements'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import { scrollPersistence } from '@lib/scroll-persistence.svelte'
  import { getViewKey } from '@lib/view-state-store.svelte'
  import ViewContextProvider from './ViewContextProvider.svelte'
  import { contextMenuStore } from '@lib/context-menu-store.svelte'

  import type {
    Settings,
    AutocompleteSuggestions,
    LibraryItem,
    MediaFolder,
    MediaFile,
    SearchIndexEntry,
    LibraryStatus
  } from '@shared/types'

  let {
    settings,
    continueWatchingItems,
    libraryStatus,
    suggestions,
    disabled = false,
    onScroll
  }: {
    settings: Settings | null
    continueWatchingItems: { show: MediaFolder; nextEpisode: MediaFile }[]
    libraryStatus: LibraryStatus | null
    suggestions: AutocompleteSuggestions
    disabled?: boolean
    onScroll?: (top: number) => void
  } = $props()

  const dispatch = createEventDispatcher<{
    itemClick: { item: LibraryItem | SearchIndexEntry }
    play: { item: LibraryItem }
    dismissContinueWatching: { showId: string }
    showContextMenu: {
      item: LibraryItem | SearchIndexEntry
      event: MouseEvent
      options?: { layout?: string }
    }
    searchByTag: { key: string; value: string }
  }>()

  // --- V2 State ---
  const currentFolderId = $derived(navStore.currentFolderId)

  const currentFolderQuery = libraryDataService.getItemDetailsQuery(() => currentFolderId, {
    enabled: () => libraryStatus?.status === 'ready' && !disabled,
    include: () => ['viewHierarchy']
  })
  const currentFolder = $derived(currentFolderQuery.data as (LibraryItem & MediaFolder) | undefined)

  const requiredFields = $derived.by(() => getAllRequiredFields(currentFolder?.viewHierarchy))

  const childrenQuery = libraryDataService.getChildrenQuery(() => currentFolderId, {
    fields: () => requiredFields,
    enabled: () => libraryStatus?.status === 'ready' && currentFolder != null && !disabled
  })
  const children = $derived((childrenQuery.data as LibraryItem[]) ?? [])

  const isHome = $derived(currentFolderId === 'home')
  const contentsPending = $derived(!!currentFolder && (childrenQuery.isPending || childrenQuery.isPlaceholderData))
  const viewPending = $derived(!disabled && (currentFolderQuery.isPending || contentsPending))
  let placeholderFolderId = $state<string | null>(null)
  const showPlaceholders = $derived(viewPending && placeholderFolderId === currentFolderId)

  $effect(() => {
    const folderId = currentFolderId
    placeholderFolderId = null
    if (!viewPending) return

    const timer = setTimeout(() => { placeholderFolderId = folderId }, 160)
    return () => clearTimeout(timer)
  })

  function handleScroll(e: Event) {
    const target = e.target as HTMLElement
    onScroll?.(target.scrollTop)
  }
</script>

{#snippet placeholders()}
  <div class="loading-posters" role="status" aria-label="Loading library items">
    {#each [1, 2, 3, 4, 5] as index (index)}
      <div><Skeleton height="100%" /></div>
    {/each}
  </div>
{/snippet}

{#snippet folderContents()}
  {#if currentFolder}
    {#if contentsPending}
      {#if showPlaceholders}{@render placeholders()}{/if}
    {:else if childrenQuery.isError && !childrenQuery.data}
      <div class="folder-status" role="status">
        <p>Could not load this folder's contents.</p>
        <button type="button" onclick={() => childrenQuery.refetch()}>Try again</button>
      </div>
    {:else}
      <MediaView parentItem={currentFolder} items={children}
        onItemClick={(item) => dispatch('itemClick', { item })}
        onShowContextMenu={(item, event, options) => dispatch('showContextMenu', { item, event, options })}
        {suggestions} {settings} viewNode={currentFolder.viewHierarchy} />
    {/if}
  {/if}
{/snippet}

<div
  class="view-wrapper"
  aria-busy={viewPending}
  onscroll={handleScroll}
  oncontextmenu={(event) => {
    if (currentFolder) contextMenuStore.openForBackground(currentFolder, event)
    else event.preventDefault()
  }}
  use:scrollPersistence={{ key: `${getViewKey('vertical')}:${currentFolderId}`, disabled }}
>
  {#if currentFolder}
    {#key currentFolder.id}
      <div class="view-transition-inner" in:fade={{ duration: prefersReducedMotion.current ? 0 : 150 }}>
        <ViewContextProvider id={currentFolder.id}>
          {#if isHome}
            <HomeView {continueWatchingItems}
              onItemClick={(item) => dispatch('itemClick', { item })}
              onShowContextMenu={(item, event) => dispatch('showContextMenu', { item, event })}
              on:dismissContinueWatching={(event) => dispatch('dismissContinueWatching', event.detail)}
              {settings}>
              {@render folderContents()}
            </HomeView>
          {:else}
            <div class="folder-content-wrapper">
              <h1 class="folder-header-title">{currentFolder.title ?? currentFolder.name}</h1>
              {@render folderContents()}
            </div>
          {/if}
        </ViewContextProvider>
      </div>
    {/key}
  {:else}
    <div class="folder-content-wrapper">
      {#if isHome}<h1 class="folder-header-title">Library</h1>{/if}
      {#if currentFolderQuery.isError}
        <div class="folder-status" role="status">
          <p>Could not load the library view.</p>
          <button type="button" onclick={() => currentFolderQuery.refetch()}>Try again</button>
        </div>
      {:else if showPlaceholders}
        {#if !isHome}<Skeleton width="35%" height="2.4rem" />{/if}
        {@render placeholders()}
      {/if}
    </div>
  {/if}
</div>

<style>
  .view-wrapper {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-gutter: stable;
    background: transparent;
  }
  .view-transition-inner { position: relative; display: flex; flex-direction: column; min-height: 100%; }
  .folder-content-wrapper {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-content: start;
    min-width: 0;
    width: min(100%, 108rem);
    margin-inline: auto;
    padding: clamp(1.25rem, 3.2vw, 2.75rem) clamp(.9rem, 3.2vw, 3rem) 4rem;
    gap: clamp(1.1rem, 2.4vw, 2rem);
  }
  .folder-header-title {
    padding-inline-start: var(--floating-back-space);
    font-size: clamp(2.1rem, 4vw, 3.5rem);
    font-weight: 720;
    letter-spacing: -.045em;
    line-height: 1.03;
    overflow-wrap: anywhere;
  }
  .loading-posters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 10rem));
    gap: .8rem;
  }
  .loading-posters > div { width: 100%; aspect-ratio: 2 / 3; }
  .folder-status { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: .6rem; color: var(--color-text-soft); }
</style>
