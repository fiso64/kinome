<script lang="ts">
  import type { LibraryItem, MediaFolder, SearchIndexEntry } from '@shared/types'

  import MediaView from '../layout/MediaView.svelte'
  // import { triggerSeasonEpisodeFetch } from '@lib/item-store'
  import { activeTabState, tabNavigationIntent } from '@lib/view-state-store'
  import type { AutocompleteSuggestions, Settings } from '@shared/types'
  import { api } from '@lib/api'
  import { get } from 'svelte/store'

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
    settings,
    viewNode
  }: {
    container?: MediaFolder | VirtualFolder
    folders: (MediaFolder | VirtualFolder)[]
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

  let lastProcessedContainerId: string | undefined = undefined

  $effect(() => {
    if (!container) return

    // Check for a specific navigation intent first. This logic runs before
    // the "last processed container" check, allowing it to override sticky tab behavior.
    const intent = get(tabNavigationIntent)
    if (intent && intent.targetShowId === container.id) {
      const nextUpSeasonFolder = folders.find(
        (f) => (f as MediaFolder).seasonNumber === intent.targetSeasonNumber
      )
      if (nextUpSeasonFolder) {
        selectTab(nextUpSeasonFolder.id)
      }
      // IMPORTANT: Consume the intent so it doesn't fire again.
      tabNavigationIntent.set(null)
    }

    // This effect runs when the component is (re)created with a container.
    // It's designed to set an intelligent default tab for a TV show *only if*
    // a tab hasn't already been selected by the user for this container.
    if (container.id === lastProcessedContainerId) return

    lastProcessedContainerId = container.id

    // Check if a tab has already been set for this container in the global state.
    // If so, the user has likely interacted with it, and we should respect their choice.
    if ($activeTabState.has(container.id)) {
      return
    }

    // Only apply this logic to TV show folders.
    const isTvShowContainer = container.type === 'folder' && container.mediaType === 'tv'
    if (!isTvShowContainer) return

    // Asynchronously fetch the "Next Up" episode to determine the default tab.
    api.getContinueWatchingForShow(container.id).then((info) => {
      // It's possible for the user to have clicked a tab while we were fetching.
      // Double-check that no tab has been set before we override it.
      if ($activeTabState.has(container.id)) return

      if (info && !info.show.nextUpDismissed) {
        const nextEpisodeSeasonNumber = info.nextEpisode.seasonNumber
        const nextUpSeasonFolder = folders.find(
          (f) => (f as MediaFolder).seasonNumber === nextEpisodeSeasonNumber
        )

        if (nextUpSeasonFolder) {
          selectTab(nextUpSeasonFolder.id)
        }
      }
    })
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

  const activeTabId = $derived.by(() => {
    if (!container) return folders[0]?.id ?? null
    const lastActive = $activeTabState.get(container.id)
    const currentFolderIds = folders.map((f) => f.id)
    if (lastActive && currentFolderIds.includes(lastActive)) {
      return lastActive
    }
    return folders[0]?.id ?? null
  })

  function selectTab(tabId: string) {
    if (!container) return
    activeTabState.update((map) => map.set(container.id, tabId))
  }

  // Effect to trigger data fetching when the active tab changes
  $effect(() => {
    if (activeTabId) {
      const activeFolder = folders.find((f) => f.id === activeTabId)
      if (activeFolder) {
        // triggerSeasonEpisodeFetch(activeFolder)
      }
    }
  })

  $effect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const isInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (isInput) return

      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        if (!folders || folders.length < 2) return

        const currentIndex = folders.findIndex((f) => f.id === activeTabId)
        if (currentIndex === -1) return

        const nextIndex = event.shiftKey
          ? (currentIndex - 1 + folders.length) % folders.length
          : (currentIndex + 1) % folders.length

        selectTab(folders[nextIndex].id)
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  })

  // When the active tab changes, scroll it into view.
  $effect(() => {
    if (activeTabId && tabListElement) {
      const activeTabElement = tabListElement.querySelector('.tab.active')
      activeTabElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    }
  })

  function scrollTabs(direction: 'left' | 'right') {
    tabListElement?.dispatchEvent(new CustomEvent('smooth-scroll', { detail: { direction } }))
  }
</script>

<div class="tabs-view">
  <div
    class="tabs-view-header"
    class:can-scroll-left={canScrollLeft}
    class:can-scroll-right={canScrollRight}
  >
    <button
      class="scroll-button left"
      class:visible={canScrollLeft}
      onclick={() => scrollTabs('left')}
      aria-label="Scroll left"
    >
      <svg width="8" height="13" viewBox="0 0 10 16" fill="none" xmlns="http://www.w3.org/2000/svg"
        ><path
          d="M8.5 15L1.5 8L8.5 1"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          fill="none"
        /></svg
      >
    </button>
    <div class="tab-list" bind:this={tabListElement} use:horizontalScroller={scrollState}>
      {#each folders as folder (folder.id)}
        <button
          class="tab"
          class:active={activeTabId === folder.id}
          onclick={() => selectTab(folder.id)}
          oncontextmenu={(e) =>
            onShowContextMenu(folder, e, { layout: 'tabs', parentItem: container as LibraryItem })}
        >
          {folder.title ?? folder.name}
        </button>
      {/each}
    </div>
    <button
      class="scroll-button right"
      class:visible={canScrollRight}
      onclick={() => scrollTabs('right')}
      aria-label="Scroll right"
    >
      <svg width="8" height="13" viewBox="0 0 10 16" fill="none" xmlns="http://www.w3.org/2000/svg"
        ><path
          d="M1.5 1L8.5 8L1.5 15"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          fill="none"
        /></svg
      >
    </button>
  </div>
  <div class="tab-content">
    {#if folders.length > 0}
      {#each folders as folder (folder.id)}
        {#if activeTabId === folder.id}
          {@const childNode = viewNode?.children?.[folder.id]}
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
        {/if}
      {/each}
    {:else}
      <p class="empty-message">No folders to display as tabs.</p>
    {/if}
  </div>
</div>

<style>
  .empty-message {
    padding: 1.5rem;
    color: var(--ev-c-text-2);
  }
  .tabs-view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .tabs-view-header {
    position: relative;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .tab-list {
    display: flex;
    flex-wrap: nowrap;
    overflow-x: auto;
    padding: 1rem 1.5rem;
    margin: 0 1rem;
    gap: 1rem;
    -ms-overflow-style: none; /* for Internet Explorer, Edge */
    scrollbar-width: none; /* for Firefox */
    flex-grow: 1;
  }

  .tab-list::before,
  .tab-list::after {
    content: '';
    flex: 1;
  }

  .tab-list::-webkit-scrollbar {
    display: none; /* for Chrome, Safari, and Opera */
  }

  .tab {
    padding: 0.75rem 1.5rem;
    cursor: pointer;
    background-color: var(--color-background-soft);
    border: 1px solid transparent;
    border-radius: 20px;
    color: var(--ev-c-text-2);
    font-size: 0.9rem;
    font-weight: 600;
    transition:
      color 0.2s,
      background-color 0.2s,
      border-color 0.2s;
    white-space: nowrap; /* Prevent tab text from wrapping */
  }
  .tab:hover {
    color: var(--ev-c-text-1);
    background-color: var(--ev-c-gray-3);
  }
  .tab.active {
    color: var(--ev-c-text-1);
    background-color: var(--ev-c-gray-2);
    border-color: var(--ev-c-gray-1);
  }

  .scroll-button {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 2;
    background-color: rgba(30, 30, 30, 0.9);
    backdrop-filter: blur(2px);
    color: var(--ev-c-text-2);
    border: 1px solid var(--color-background-mute);
    border-radius: 50%;
    width: 32px;
    height: 32px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    line-height: 1;
    padding: 0;
    opacity: 0;
    visibility: hidden;
    transition:
      opacity 0.2s ease,
      visibility 0.2s ease,
      color 0.2s ease;
  }
  .scroll-button.left {
    left: 1rem;
  }
  .scroll-button.right {
    right: 1rem;
  }
  .tabs-view-header:hover .scroll-button.visible {
    opacity: 1;
    visibility: visible;
  }
  .scroll-button:hover {
    background-color: var(--ev-c-gray-2);
    color: var(--ev-c-text-1);
  }

  .tabs-view-header.can-scroll-left .tab-list {
    -webkit-mask-image: linear-gradient(to right, transparent, black 40px);
    mask-image: linear-gradient(to right, transparent, black 40px);
  }
  .tabs-view-header.can-scroll-right .tab-list {
    -webkit-mask-image: linear-gradient(to left, transparent, black 40px);
    mask-image: linear-gradient(to left, transparent, black 40px);
  }
  .tabs-view-header.can-scroll-left.can-scroll-right .tab-list {
    -webkit-mask-image: linear-gradient(
      to right,
      transparent,
      black 40px,
      black calc(100% - 40px),
      transparent
    );
    mask-image: linear-gradient(
      to right,
      transparent,
      black 40px,
      black calc(100% - 40px),
      transparent
    );
  }

  .tab-content {
    flex-grow: 1;
    overflow-y: auto;
  }

  /* --- Full Backdrop Mode Styles --- */
  :global(.full-backdrop-mode) .tab {
    background-color: rgba(30, 30, 33, 0.7);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-color: rgba(255, 255, 255, 0.1);
  }
  :global(.full-backdrop-mode) .tab:hover {
    background-color: rgba(50, 50, 55, 0.8);
    border-color: rgba(255, 255, 255, 0.15);
  }
  :global(.full-backdrop-mode) .tab.active {
    background-color: rgba(80, 80, 85, 0.85);
    border-color: rgba(255, 255, 255, 0.2);
  }
</style>
