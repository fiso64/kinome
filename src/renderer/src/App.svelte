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
  let lastDetailItem: LibraryItem | null = $state(null) // Breadcrumb for "back" from drill-down
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

  const groupByKeys = $derived([
    'folder',
    'mediaType',
    'genre',
    'year',
    ...(settings?.virtualTags?.map((vt) => `vt.${vt.name}`) ?? []),
    ...allAutocompleteSuggestions.tagKeys.map((k) => `tags.${k}`)
  ])
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

    // Fetch initial data
    window.api.getAutocompleteSuggestions().then((suggestions) => {
      allAutocompleteSuggestions = suggestions
    })
    window.api.getSettings().then((s) => (settings = s))

    // Listen for live updates to autocomplete suggestions
    const unlistenSuggestions = window.api.onAutocompleteSuggestionsUpdated((suggestions) => {
      allAutocompleteSuggestions = suggestions
    })

    // Cleanup the listener when the component is destroyed.
    return () => {
      unlistenSuggestions()
    }
  })

  $effect(() => {
    // When the current folder changes, reset search text.
    void currentFolder?.id

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

  function findPathToItem(root: MediaFolder, id: string): MediaFolder[] {
    const path: MediaFolder[] = []
    function find(current: MediaFolder): boolean {
      path.push(current)
      if (current.id === id) return true
      for (const child of current.children) {
        if (child.type === 'folder') {
          if (find(child as MediaFolder)) return true
        }
      }
      path.pop()
      return false
    }
    if (root && find(root)) {
      return path
    }
    return []
  }

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

  function drillDown(childFolder: MediaFolder) {
    const parent = selectedItemForDetailView
    if (!parent) return

    const root = viewStack[0]
    if (!root) return

    const pathToParent = findPathToItem(root, parent.id)
    if (pathToParent.length > 0) {
      lastDetailItem = parent
      selectedItemForDetailView = null
      viewStack = [...pathToParent, childFolder]
    }
  }

  function handleContextMenuOpen(item: LibraryItem) {
    if (selectedItemForDetailView && item.type === 'folder') {
      // In a detail view, right-clicked a child folder.
      // Delegate to the same logic as a regular click.
      handleFolderClickInDetailView(item as MediaFolder)
    } else {
      // Not in a detail view, or clicked a file. Use normal grid logic.
      handleGridItemClick(item)
    }
  }

  async function handleScan(): Promise<void> {
    isScanning = true
    selectedItemForDetailView = null // Go back to grid view
    lastDetailItem = null
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
    lastDetailItem = null
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

  function handleItemClick(item: LibraryItem): void {
    // --- Are we currently in a detail view? ---
    if (selectedItemForDetailView) {
      const parent = selectedItemForDetailView

      // A. Clicked a folder inside the detail view
      if (item.type === 'folder') {
        if ((parent as MediaFolder).childrenClickAction === 'navigate') {
          drillDown(item as MediaFolder)
        } else {
          // 'detail'
          lastDetailItem = parent
          viewStack.push(parent as MediaFolder)
          selectedItemForDetailView = item
        }
        return
      }

      // B. Clicked a file that should open its own detail view
      if (item.type === 'file' && item.opensAsFolder) {
        lastDetailItem = parent
        viewStack.push(parent as MediaFolder) // We are drilling down one level
        selectedItemForDetailView = item
        return
      }

      // C. Clicked a normal, playable file
      if (item.type === 'file') {
        handlePlayFile(item)
      }
      return
    }

    // --- We are in a list/grid view (no detail view open) ---
    lastDetailItem = null // Reset breadcrumb

    // 1. If it's a file that opens as a folder, just open it.
    if (item.type === 'file' && item.opensAsFolder) {
      selectedItemForDetailView = item
      return
    }

    // 2. If it's a regular file in a tree view, play it.
    if (item.type === 'file' && (currentFolder?.layout ?? 'grid') === 'tree') {
      handlePlayFile(item)
      return
    }

    // 3. If it's a folder and parent is set to navigate, navigate.
    if (item.type === 'folder' && currentFolder?.childrenClickAction === 'navigate') {
      handleNavigateFolder(item as MediaFolder)
      return
    }

    // 4. Default action: open detail view for the item.
    selectedItemForDetailView = item
  }

  // Used to navigate to a new folder list view, closing any detail view.
  function handleNavigateFolder(folder: MediaFolder): void {
    selectedItemForDetailView = null
    lastDetailItem = null // Clear breadcrumb on any new grid navigation
    // Pushing the reactive proxy is fine; Svelte 5 handles this efficiently.
    viewStack.push(folder)
  }

  function goBack(): void {
    if (!canGoBack) return

    if (selectedItemForDetailView) {
      // We are in a detail view.
      // Check if we have a breadcrumb to a PREVIOUS detail view.
      if (lastDetailItem) {
        // We came from another detail view. Restore it.
        selectedItemForDetailView = lastDetailItem
        // The view stack for the previous detail view needs to be restored.
        // It was the parent of the previous detail view. So we just need to pop.
        viewStack.pop()
        // Clear the breadcrumb now that we've used it.
        lastDetailItem = null
      } else {
        // No breadcrumb, so we came from a list view. Just close the detail view.
        selectedItemForDetailView = null
      }
    } else {
      // We are in a list view.
      // Check if we got here from a drill-down.
      if (lastDetailItem) {
        selectedItemForDetailView = lastDetailItem
        viewStack.pop() // remove current folder
        viewStack.pop() // remove parent folder (the one we're restoring the detail view OF)
        lastDetailItem = null
      } else if (viewStack.length > 1) {
        // Standard list-to-list back navigation.
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
      groupByKeys={groupByKeys}
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
        handleContextMenuOpen(contextMenuItem)
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
        <button class="back-button" class:hidden={!canGoBack} onclick={goBack} title="Go back">
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
            title="Set View Layout"
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
        The MediaGrid is always rendered to preserve scroll position and perceived performance.
        It is hidden with CSS when the detail view is active to prevent flashing.
      -->
      <div class="media-grid-container" class:hidden={selectedItemForDetailView}>
        <MediaGrid
          parentItem={currentFolder}
          items={currentFolder.children}
          {searchQuery}
          onItemClick={handleItemClick}
          layout={currentFolder.layout ?? 'grid'}
          onShowContextMenu={handleShowContextMenu}
        />
      </div>

      {#if selectedItemForDetailView && settings}
        <ItemDetail
          item={selectedItemForDetailView}
          onItemClick={handleItemClick}
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
    flex-shrink: 0;
  }

  .settings-button,
  .layout-button {
    background-color: var(--ev-button-alt-bg);
    color: var(--ev-c-text-1);
  }

  .back-button.hidden {
    visibility: hidden;
  }

  .welcome-screen button {
    flex-shrink: 0;
  }

  .content {
    flex-grow: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    scrollbar-gutter: stable;
    position: relative; /* Needed for the absolute positioned detail view */
  }

  .media-grid-container {
    display: flex;
    flex-direction: column;
    flex: 1; /* Ensure it fills space so its child MediaGrid can too */
  }

  .media-grid-container.hidden {
    visibility: hidden;
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
