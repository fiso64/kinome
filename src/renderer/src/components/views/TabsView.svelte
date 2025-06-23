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

  let activeTabId = $state<string | null>(null)
  let tabListElement = $state<HTMLDivElement | undefined>()
  let canScrollLeft = $state(false)
  let canScrollRight = $state(false)
  let isOverflowing = $derived(canScrollLeft || canScrollRight)

  $effect(() => {
    const currentFolderIds = folders.map((f) => f.id)
    if (activeTabId === null || !currentFolderIds.includes(activeTabId)) {
      activeTabId = folders[0]?.id ?? null
    }

    // When the active tab is determined (or changes), check if its
    // corresponding folder needs episode data to be fetched.
    const activeFolder = folders.find((f) => f.id === activeTabId)
    if (activeFolder) {
      triggerSeasonEpisodeFetch(activeFolder)
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

        activeTabId = folders[nextIndex].id
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  })

  $effect(() => {
    const el = tabListElement
    if (!el) return

    const checkScrollability = () => {
      // A small buffer helps prevent floating point inaccuracies
      canScrollLeft = el.scrollLeft > 1
      canScrollRight = el.scrollLeft < el.scrollWidth - el.clientWidth - 1
    }

    checkScrollability() // Initial check

    // Re-check on scroll and resize events
    const observer = new ResizeObserver(checkScrollability)
    observer.observe(el)
    el.addEventListener('scroll', checkScrollability)

    // A one-time check after images in the child MediaView might load
    const timeoutId = setTimeout(checkScrollability, 500)

    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', checkScrollability)
      clearTimeout(timeoutId)
    }
  })

  function scrollTabs(direction: 'left' | 'right') {
    if (!tabListElement) return
    const scrollAmount = tabListElement.clientWidth * 0.8
    tabListElement.scrollTo({
      left: tabListElement.scrollLeft + (direction === 'left' ? -scrollAmount : scrollAmount),
      behavior: 'smooth'
    })
  }

  function handleWheel(event: WheelEvent) {
    if (!tabListElement) return
    // If there's no horizontal overflow, do nothing.
    if (tabListElement.scrollWidth <= tabListElement.clientWidth) return

    // If there is horizontal scroll, prevent vertical page scroll and scroll tabs instead.
    // This handles both vertical mouse wheel (deltaY) and horizontal trackpad swipes (deltaX).
    if (event.deltaY !== 0 || event.deltaX !== 0) {
      event.preventDefault()
      tabListElement.scrollLeft += event.deltaY + event.deltaX
    }
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
        /></svg
      >
    </button>
    <div
      class="tab-list"
      class:overflowing={isOverflowing}
      bind:this={tabListElement}
      onwheel={handleWheel}
    >
      {#each folders as folder (folder.id)}
        <button
          class="tab"
          class:active={activeTabId === folder.id}
          onclick={() => (activeTabId = folder.id)}
          oncontextmenu={(e) => onShowContextMenu(folder, e, { layout: 'tabs' })}
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
        /></svg
      >
    </button>
  </div>
  <div class="tab-content">
    {#if folders.length > 0}
      {#each folders as folder (folder.id)}
        {#if activeTabId === folder.id}
          <MediaView
            parentItem={folder}
            items={folder.children}
            {onItemClick}
            {onShowContextMenu}
            {suggestions}
            {grayOutWatched}
            {settings}
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
    background-color: var(--color-background);
    flex-shrink: 0;
  }

  .tab-list {
    display: flex;
    justify-content: center;
    flex-wrap: nowrap;
    overflow-x: auto;
    padding: 1rem 1.5rem;
    margin: 0 1rem;
    gap: 1rem;
    -ms-overflow-style: none; /* for Internet Explorer, Edge */
    scrollbar-width: none; /* for Firefox */
    /* scroll-behavior: smooth is removed to fix jittery wheel scroll */
    flex-grow: 1;
  }
  .tab-list.overflowing {
    justify-content: flex-start;
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

  .tabs-view-header::before,
  .tabs-view-header::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 60px;
    z-index: 1; /* Below buttons, above tabs */
    pointer-events: none;
    transition: opacity 0.3s;
    opacity: 0;
  }
  .tabs-view-header::before {
    left: 0;
    background: linear-gradient(to right, var(--color-background) 30%, transparent);
  }
  .tabs-view-header::after {
    right: 0;
    background: linear-gradient(to left, var(--color-background) 30%, transparent);
  }
  .tabs-view-header.can-scroll-left::before,
  .tabs-view-header.can-scroll-right::after {
    opacity: 1;
  }

  .tab-content {
    flex-grow: 1;
    overflow-y: auto;
  }
</style>
