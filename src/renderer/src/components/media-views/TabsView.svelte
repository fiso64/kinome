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

  $effect(() => {
    const currentFolderIds = folders.map((f) => f.id)
    if (activeTabId === null || !currentFolderIds.includes(activeTabId)) {
      activeTabId = folders[0]?.id ?? null
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
</script>

<div class="tabs-view">
  <div class="tab-list">
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
  <div class="tab-content">
    {#if folders.length > 0}
      {@const calculateLayout = (folder: MediaFolder): 'grid' | 'list' | 'tree' | 'tabs' | 'sections' => {
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
      }}
      {#each folders as folder (folder.id)}
        {#if activeTabId === folder.id}
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
  .tab-list {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    background-color: var(--color-background);
    padding: 1rem 1.5rem;
    flex-shrink: 0;
    gap: 1rem;
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
  .tab-content {
    flex-grow: 1;
    overflow-y: auto;
  }
</style>
