<script lang="ts">
  import type { LibraryItem, MediaFolder, SearchIndexEntry } from '@shared/types'

  import MediaView from '../layout/MediaView.svelte'
  import ViewContextProvider from '../layout/ViewContextProvider.svelte'
  import Icon from '@components/ui/Icon.svelte'
  import Skeleton from '@components/ui/Skeleton.svelte'
  import { viewStateStore, getViewKey } from '@lib/view-state-store.svelte'
  import { scrollPersistence } from '@lib/scroll-persistence.svelte'
  import type { AutocompleteSuggestions, Settings } from '@shared/types'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import { prefersReducedMotion } from 'svelte/motion'
  import { fade } from 'svelte/transition'

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

  const tabGroupId = $props.id()
  const stateKey = getViewKey('tabs')
  const persistentState = viewStateStore.get<{ activeTabId: string | null }>(stateKey, { activeTabId: null })
  const isTvShow = $derived(container?.mediaType === 'tv')
  const nextUpQuery = libraryDataService.getContinueWatchingForShowQuery(() => container?.id, {
    enabled: () => isTvShow && !persistentState.activeTabId
  })
  const navigationIntent = $derived.by(() => {
    const intent = viewStateStore.tabNavigationIntent
    return intent?.targetShowId === container?.id ? intent : null
  })
  const intentFolder = $derived(navigationIntent
    ? folders.find((folder) => folder.seasonNumber === navigationIntent.targetSeasonNumber)
    : undefined)

  const activeTabId = $derived.by(() => {
    if (intentFolder) return intentFolder.id
    if (folders.some((folder) => folder.id === persistentState.activeTabId)) return persistentState.activeTabId
    if (isTvShow && nextUpQuery.isPending) return null

    const info = nextUpQuery.data
    const season = info?.nextEpisode.seasonNumber
    if (isTvShow && season != null && !info?.show.nextUpDismissed) {
      const target = folders.find((folder) => folder.seasonNumber === season)
      if (target) return target.id
    }
    return folders[0]?.id ?? null
  })

  function selectTab(tabId: string) {
    persistentState.activeTabId = tabId
  }

  $effect(() => {
    if (navigationIntent && folders.length > 0) {
      if (intentFolder) selectTab(intentFolder.id)
      viewStateStore.tabNavigationIntent = null
    } else if (isTvShow && !persistentState.activeTabId && activeTabId) {
      // Keep the initial selection when Next Up refetches in the background.
      selectTab(activeTabId)
    }
  })

  import { writable } from 'svelte/store'
  import { horizontalScroller, type HorizontalScrollState } from '@lib/horizontal-scroll'

  let tabListElement: HTMLDivElement | undefined = $state()
  const scrollState = writable<HorizontalScrollState>({
    canScrollLeft: false,
    canScrollRight: false
  })
  const canScrollLeft = $derived($scrollState.canScrollLeft)
  const canScrollRight = $derived($scrollState.canScrollRight)


  // When the active tab changes, scroll it into view.
  $effect(() => {
    if (activeTabId && tabListElement) {
      const activeTabElement = tabListElement.querySelector('.tab.active')
      activeTabElement?.scrollIntoView({ behavior: prefersReducedMotion.current ? 'instant' : 'smooth', block: 'nearest', inline: 'center' })
    }
  })

  function handleTabKeys(event: KeyboardEvent, tabIndex: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

    let index: number
    switch (event.key) {
      case 'ArrowLeft': index = (tabIndex - 1 + folders.length) % folders.length; break
      case 'ArrowRight': index = (tabIndex + 1) % folders.length; break
      case 'Home': index = 0; break
      case 'End': index = folders.length - 1; break
      default: return
    }
    event.preventDefault()
    const tabId = folders[index].id
    selectTab(tabId)
    document.getElementById(`${tabGroupId}-${tabId}`)?.focus({ preventScroll: true })
  }

  function scrollTabs(direction: 'left' | 'right') {
    tabListElement?.dispatchEvent(new CustomEvent('smooth-scroll', { detail: { direction } }))
  }
</script>

<div class="tabs-view">
  {#if folders.length > 0}
    <div class="tabs-view-header">
      <div class="tab-list" role="tablist" aria-label={isTvShow ? 'Seasons' : 'Folders'}
        bind:this={tabListElement} use:horizontalScroller={scrollState}>
        {#each folders as folder, i (folder.id)}
          <button
            type="button"
            role="tab"
            class="tab"
            class:active={activeTabId === folder.id}
            id={`${tabGroupId}-${folder.id}`}
            aria-controls={activeTabId === folder.id ? `${tabGroupId}-panel` : undefined}
            aria-selected={activeTabId === folder.id}
            tabindex={(activeTabId ? activeTabId === folder.id : i === 0) ? 0 : -1}
            onclick={() => selectTab(folder.id)}
            onkeydown={(event) => handleTabKeys(event, i)}
            oncontextmenu={(e) =>
              onShowContextMenu(folder, e, { layout: 'tabs', parentItem: container as LibraryItem })}
          >
            {folder.title ?? (folder.mediaType === 'season' && folder.seasonNumber != null
              ? `Season ${folder.seasonNumber}`
              : folder.name)}
          </button>
        {/each}
      </div>
      {#if canScrollLeft || canScrollRight}
        <div class="scroll-buttons">
          <button type="button" class="icon-button" disabled={!canScrollLeft}
            onclick={() => scrollTabs('left')} aria-label="Scroll left"><Icon name="left" size={16} /></button>
          <button type="button" class="icon-button" disabled={!canScrollRight}
            onclick={() => scrollTabs('right')} aria-label="Scroll right"><Icon name="right" size={16} /></button>
        </div>
      {/if}
    </div>
  {/if}
  <div class="tab-content" use:scrollPersistence={{ key: getViewKey('vertical') }}>
    {#if folders.length > 0 && activeTabId === null}
      <div class="tab-loading" role="status" aria-label="Loading season">
        <Skeleton height="4rem" />
      </div>
    {:else if folders.length > 0}
      {#each folders as folder (folder.id)}
        {#if activeTabId === folder.id}
          {@const childNode = viewNode?.children?.[folder.id]}
          <div class="tab-pane-wrapper" role="tabpanel" id={`${tabGroupId}-panel`}
            aria-labelledby={`${tabGroupId}-${folder.id}`} in:fade={{ duration: prefersReducedMotion.current ? 0 : 130 }}>
            <ViewContextProvider id={folder.id} extend={true}>
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
            </ViewContextProvider>
          </div>
        {/if}
      {/each}
    {:else}
      <p class="empty-message">No folders to display as tabs.</p>
    {/if}
  </div>
</div>

<style>
  .tab-loading, .empty-message { padding: 1.25rem; }
  .empty-message { color: var(--color-text-soft); }

  .tabs-view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .tabs-view-header {
    display: flex;
    align-items: center;
    flex: none;
    width: fit-content;
    max-width: calc(100% - 2rem);
    margin: .4rem auto .8rem;
    border-radius: var(--radius-panel);
    background: var(--color-inset);
    border: 1px solid var(--color-border-soft);
    box-shadow: inset 0 2px 5px #03050866;
  }

  :global(.full-backdrop-mode) .tabs-view-header {
    background: var(--surface-over-artwork);
    border-color: var(--artwork-edge);
    backdrop-filter: blur(14px);
    box-shadow: var(--edge-light);
  }

  .tab-list {
    display: flex;
    overflow-x: auto;
    padding: .35rem;
    gap: .25rem;
    scrollbar-width: none;
  }

  .tab {
    flex: none;
    padding: .45rem .95rem;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    white-space: nowrap;
    color: var(--color-text-soft);
  }

  .tab:hover { color: var(--color-text); background: var(--color-hover); }
  .tab.active {
    color: var(--color-primary-soft);
    background: var(--accent-surface);
    border-color: var(--accent-border);
    box-shadow: var(--edge-light);
  }

  .scroll-buttons { display: flex; padding-right: .25rem; }
  .scroll-buttons button { width: 30px; min-height: 30px; }
  .tab-content { flex: 1; min-height: 0; overflow-y: auto; }
</style>
