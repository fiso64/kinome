<script lang="ts">
  import MediaGrid from './components/MediaGrid.svelte'
  import SettingsModal from './components/SettingsModal.svelte'
  import SearchInput from './components/SearchInput.svelte'
  import WindowControls from './components/WindowControls.svelte'
  import ItemDetail from './components/ItemDetail.svelte'
  import LayoutSelector from './components/LayoutSelector.svelte'
  import ContextMenu from './components/ContextMenu.svelte'
  import MetadataEditor from './components/MetadataEditor.svelte'
  import FolderSettingsModal from './components/FolderSettingsModal.svelte'
  import ManualSearchModal from './components/ManualSearchModal.svelte'
  import { initializeShortcuts } from './lib/shortcuts'

  // Types are globally available from src/preload/index.d.ts
  type ActiveModal =
    | { type: 'settings' }
    | { type: 'layoutSelector'; item: MediaFolder }
    | { type: 'metadataEditor'; item: LibraryItem }
    | { type: 'folderSettings'; item: MediaFolder }
    | { type: 'manualSearch'; item: LibraryItem }

  let viewStack: MediaFolder[] = $state([])
  let isScanning = $state(true) // For initial load or changing library folder
  let isRefreshing = $state(false) // For updating the current library
  let searchText = $state('')
  let searchTags = $state<{ key: string; value: string }[]>([])
  const searchQuery = $derived({ text: searchText, tags: searchTags })
  let allAutocompleteSuggestions = $state<AutocompleteSuggestions>({
    genres: [],
    tagKeys: [],
    tagValues: {}
  })
  let selectedItemForDetailView: LibraryItem | null = $state(null)
  let searchInputEl = $state<HTMLInputElement | undefined>(undefined)
  let activeModal = $state<ActiveModal | null>(null)
  let settings = $state<{ playerCommand: string; tmdbApiKey: string; useLogos: boolean } | null>(
    null
  )

  // Global Context Menu State
  let contextMenuItem = $state<LibraryItem | null>(null)
  let contextMenuPosition = $state({ top: 0, left: 0 })
  let contextMenuLayout = $state<string | undefined>(undefined)

  const currentFolder = $derived(viewStack.length > 0 ? viewStack[viewStack.length - 1] : null)
  // Back button is disabled if we are at the root grid view.
  // It should be enabled if we are in a detail view.
  const canGoBack = $derived(selectedItemForDetailView !== null || viewStack.length > 1)

  $effect(() => {
    window.api.getLibraryRoot().then((root) => {
      if (root) {
        viewStack = [root]
      }
      isScanning = false
    })

    window.api.getAutocompleteSuggestions().then((suggestions) => {
      allAutocompleteSuggestions = suggestions
    })

    window.api.getSettings().then((s) => (settings = s))
  })

  $effect(() => {
    // When the current folder changes, or we enter/exit detail view, reset search text.
    void currentFolder?.id
    void selectedItemForDetailView

    // This effect does not depend on `searchText`, so it only runs on navigation changes.
    searchText = ''
  })

  // Set up a listener for real-time metadata updates from the main process.
  $effect(() => {
    const unlisten = window.api.onLibraryItemUpdated((updatedItem) => {
      // Find the item in the root of the library and update its properties.
      // Svelte's reactivity will handle the rest.
      const root = viewStack[0]
      if (root) {
        const itemInTree = findItemInTree(root, updatedItem.id)
        if (itemInTree) {
          // Mutate the object to trigger reactivity.
          Object.assign(itemInTree, updatedItem)
        }
      }
      // If the updated item is the one in the detail view, update it too
      if (selectedItemForDetailView?.id === updatedItem.id) {
        Object.assign(selectedItemForDetailView, updatedItem)
      }
    })

    // Cleanup the listener when the component is destroyed.
    return () => unlisten()
  })

  function findItemInTree(node: MediaFolder, id: string): LibraryItem | null {
    if (node.id === id) {
      return node
    }
    for (const child of node.children) {
      if (child.id === id) {
        return child
      }
      if (child.type === 'folder') {
        const found = findItemInTree(child, id)
        if (found) return found
      }
    }
    return null
  }

  async function handleScan(): Promise<void> {
    isScanning = true
    selectedItemForDetailView = null // Go back to grid view
    const newRoot = await window.api.scanLibrary()
    if (newRoot) {
      viewStack = [newRoot]
    } else if (!currentFolder) {
      // If scan is cancelled or fails on welcome screen, reset the stack.
      viewStack = []
    }
    isScanning = false
  }

  async function handleRefresh(): Promise<void> {
    if (isRefreshing || isScanning) return
    isRefreshing = true
    const refreshedRoot = await window.api.refreshLibrary()
    if (refreshedRoot) {
      // This resets navigation to the root, which is the simplest approach.
      viewStack = [refreshedRoot]
      selectedItemForDetailView = null
    }
    isRefreshing = false
  }

  async function handlePlayFile(item: MediaFile): Promise<void> {
    // De-proxy the item before sending it over IPC by creating a plain object.
    const plainFile: MediaFile = {
      id: item.id,
      name: item.name,
      path: item.path,
      type: 'file',
      watched: item.watched
    }
    const success = await window.api.playFile(plainFile)
    if (success) {
      // Find the item in the main tree and update its watched state.
      const root = viewStack[0]
      if (root) {
        const itemInTree = findItemInTree(root, item.id)
        if (itemInTree && itemInTree.type === 'file') {
          itemInTree.watched = true
        }
      }
    }
  }

  // Used by the main MediaGrid.
  function handleGridItemClick(item: LibraryItem): void {
    // In tree view, files should be played directly.
    if ((currentFolder?.layout ?? 'grid') === 'tree' && item.type === 'file') {
      handlePlayFile(item as MediaFile)
      return
    }

    // If the setting is 'navigate', push folder to stack. Otherwise, show detail view.
    if (
      currentFolder &&
      currentFolder.childrenClickAction === 'navigate' &&
      item.type === 'folder'
    ) {
      handleNavigateFolder(item as MediaFolder)
    } else {
      selectedItemForDetailView = item
    }
  }

  // Used by ItemDetail when a child folder is clicked.
  function handleFolderClickInDetailView(folder: MediaFolder): void {
    const parent = selectedItemForDetailView
    if (parent && parent.type === 'folder' && parent.childrenClickAction === 'navigate') {
      handleNavigateFolder(folder)
    } else {
      // Default to opening detail view for the child
      selectedItemForDetailView = folder
    }
  }

  // Used to navigate to a new folder list view, closing any detail view.
  function handleNavigateFolder(folder: MediaFolder): void {
    selectedItemForDetailView = null
    // Pushing the reactive proxy is fine; Svelte 5 handles this efficiently.
    viewStack.push(folder)
  }

  function goBack(): void {
    if (canGoBack) {
      if (selectedItemForDetailView) {
        selectedItemForDetailView = null
      } else if (viewStack.length > 1) {
        viewStack.pop()
      }
    }
  }

  function goForward(): void {
    // This can be implemented in the future to handle forward navigation.
  }

  function handleSearchByTag(key: string, value: string): void {
    selectedItemForDetailView = null // Exit detail view to see the search results
    // Clicking a genre tag starts a new search for that genre, clearing other tags.
    searchText = ''
    searchTags = [{ key, value }]
  }

  function handleSearchKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      // Query for the first interactive element in the currently visible media list.
      const firstItem = document.querySelector<HTMLElement>(
        '.media-grid .grid-item, .media-tree .tree-item'
      )
      firstItem?.focus()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const firstItem = document.querySelector<HTMLElement>(
        '.media-grid .grid-item, .media-tree .tree-item'
      )
      firstItem?.click()
    }
  }

  $effect(() => {
    const cleanupShortcuts = initializeShortcuts({
      openSettings: () => (activeModal = { type: 'settings' }),
      focusSearch: () => {
        searchInputEl?.focus()
        searchInputEl?.select()
      },
      navigateBack: goBack,
      navigateForward: goForward,
      reloadLibrary: handleRefresh
    })

    // Cleanup the listeners when the component is destroyed.
    return () => cleanupShortcuts()
  })

  function handleShowContextMenu(
    item: LibraryItem,
    event: MouseEvent,
    options?: { layout?: string }
  ) {
    event.preventDefault()
    event.stopPropagation()
    contextMenuItem = item
    contextMenuLayout = options?.layout
    contextMenuPosition = { top: event.clientY, left: event.clientX }
  }
</script>

{#if activeModal}
  {#if activeModal.type === 'settings'}
    <SettingsModal
      close={() => {
        const wasSettings = activeModal?.type === 'settings'
        activeModal = null
        // Refetch settings after modal closes, as they might have changed
        if (wasSettings) {
          window.api.getSettings().then((s) => (settings = s))
        }
      }}
      scanLibrary={handleScan}
    />
  {:else if activeModal.type === 'layoutSelector'}
    <LayoutSelector
      item={activeModal.item}
      currentLayout={activeModal.item.layout ??
        (activeModal.item.id === currentFolder?.id ? 'grid' : 'tree')}
      onClose={() => (activeModal = null)}
    />
  {:else if activeModal.type === 'metadataEditor'}
    <MetadataEditor item={activeModal.item} onClose={() => (activeModal = null)} />
  {:else if activeModal.type === 'folderSettings'}
    <FolderSettingsModal item={activeModal.item} onClose={() => (activeModal = null)} />
  {:else if activeModal.type === 'manualSearch'}
    <ManualSearchModal item={activeModal.item} onClose={() => (activeModal = null)} />
  {/if}
{/if}

{#if contextMenuItem}
  <ContextMenu
    item={contextMenuItem}
    position={contextMenuPosition}
    isTreeView={contextMenuLayout === 'tree'}
    onClose={() => (contextMenuItem = null)}
    onOpen={() => {
      if (contextMenuItem) {
        handleGridItemClick(contextMenuItem)
      }
    }}
    onEditMetadata={() => {
      if (contextMenuItem) {
        activeModal = { type: 'metadataEditor', item: contextMenuItem }
      }
    }}
    onSetLayout={() => {
      if (contextMenuItem?.type === 'folder') {
        activeModal = { type: 'layoutSelector', item: contextMenuItem }
      }
    }}
    onOpenFolderSettings={() => {
      if (contextMenuItem?.type === 'folder') {
        activeModal = { type: 'folderSettings', item: contextMenuItem }
      }
    }}
    onManualSearch={() => {
      if (contextMenuItem) {
        activeModal = { type: 'manualSearch', item: contextMenuItem }
      }
    }}
  />
{/if}

<main>
  <header class:in-detail-view={selectedItemForDetailView}>
    <div class="header-content">
      <div class="header-left">
        <button class="back-button" onclick={goBack} disabled={!canGoBack} title="Go back">
          ←
        </button>
        <!-- In detail view, the title is handled by the component itself -->
        {#if !selectedItemForDetailView}
          <h1>{currentFolder?.title ?? currentFolder?.name ?? 'Media Browser'}</h1>
        {/if}
      </div>

      <div class="search-container" onkeydown={handleSearchKeyDown}>
        {#if currentFolder && !selectedItemForDetailView}
          <SearchInput
            initialQuery={searchQuery}
            suggestions={allAutocompleteSuggestions}
            onQueryChange={(newQuery) => {
              searchText = newQuery.text
              searchTags = newQuery.tags
            }}
            bind:element={searchInputEl}
          />
        {/if}
      </div>

      <div class="header-right">
        <button
          onclick={handleRefresh}
          disabled={isRefreshing || isScanning}
          title="Refresh Library (F5)"
          class="refresh-button"
        >
          <span class:reloading={isRefreshing}>⟳</span>
        </button>
        {#if currentFolder}
          <button
            onclick={() => (activeModal = { type: 'layoutSelector', item: currentFolder })}
            title="Set Children View Layout"
            class="layout-button"
          >
            <!-- A simple layout icon -->
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
              ></rect>
              <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
              ></rect>
              <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
              ></rect>
              <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
              ></rect>
            </svg>
          </button>
        {/if}
        <button
          onclick={() => (activeModal = { type: 'settings' })}
          title="Settings"
          class="settings-button">⚙️</button
        >
      </div>
    </div>
    <WindowControls />
  </header>

  <div class="content">
    {#if isScanning}
      <p class="status-text">Loading library...</p>
    {:else if !currentFolder}
      <div class="welcome-screen">
        <h2>Welcome to Media Browser</h2>
        <p>To get started, scan a folder containing your media.</p>
        <button onclick={handleScan}>Select Media Folder</button>
      </div>
    {:else}
      <!-- 
        The MediaGrid is always rendered to preserve scroll position.
        The ItemDetail view will be rendered as an overlay on top of it.
      -->
      <div>
        <MediaGrid
          parentItem={currentFolder}
          items={currentFolder.children}
          {searchQuery}
          onItemClick={handleGridItemClick}
          layout={currentFolder.layout ?? 'grid'}
          onShowContextMenu={handleShowContextMenu}
        />
      </div>

      {#if selectedItemForDetailView && settings}
        <ItemDetail
          item={selectedItemForDetailView}
          onPlayFile={handlePlayFile}
          onNavigateFolder={handleFolderClickInDetailView}
          onSearchByTag={handleSearchByTag}
          showContextMenu={handleShowContextMenu}
          useLogos={settings.useLogos ?? true}
        />
      {/if}
    {/if}
  </div>
</main>

<style>
  .search-container {
    flex-grow: 1;
    display: flex;
    justify-content: center;
    min-width: 150px;
  }

  main {
    --header-height: 54px;
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }

  header {
    display: flex;
    border-bottom: 1px solid var(--color-background-mute);
    -webkit-app-region: drag;
    height: var(--header-height);
    flex-shrink: 0;
    transition: background-color 0.3s ease;
    position: relative;
    z-index: 10;
  }

  header.in-detail-view {
    background-color: transparent;
    border-bottom: none;
  }

  .header-content {
    flex-grow: 1;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1.5rem;
    padding: 0 1.5rem;
  }

  .header-left,
  .header-right {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .header-left {
    overflow: hidden; /* For long folder names */
    flex-shrink: 0;
  }

  h1 {
    font-size: 1.2rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  button {
    background-color: var(--ev-button-alt-bg);
    color: var(--ev-c-text-1);
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 5px;
    cursor: pointer;
    font-weight: 600;
    -webkit-app-region: no-drag;
    flex-shrink: 0; /* Prevent scan button from shrinking */
  }

  .back-button,
  .refresh-button,
  .layout-button,
  .settings-button {
    width: 36px;
    height: 36px;
    padding: 0;
    font-size: 1.2rem;
    line-height: 1;
    display: inline-flex;
    justify-content: center;
    align-items: center;
  }

  button:hover {
    background-color: var(--ev-c-gray-2);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .content {
    flex-grow: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    scrollbar-gutter: stable;
    position: relative; /* Needed for the absolute positioned detail view */
  }

  .welcome-screen,
  .status-text {
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 1rem;
    padding: 2rem;
    text-align: center;
  }

  /* --- Refresh Button Animation --- */
  .refresh-button {
    /* Sizing is now handled by the unified button style above */
  }
  .reloading {
    display: inline-block;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
