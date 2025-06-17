<script lang="ts">
  import MediaView from './components/MediaView.svelte'
  import SettingsModal from './components/SettingsModal.svelte'
  import SearchInput from './components/SearchInput.svelte'
  import WindowControls from './components/WindowControls.svelte'
  import ItemDetail from './components/ItemDetail.svelte'
  import LayoutSelector from './components/LayoutSelector.svelte'
  import ContextMenu from './components/ContextMenu.svelte'
  import MetadataEditor from './components/MetadataEditor.svelte'
  import FolderSettingsModal from './components/FolderSettingsModal.svelte'
  import ManualSearchModal from './components/ManualSearchModal.svelte'
  import FilterBar from './components/FilterBar.svelte'
  import { initializeShortcuts } from './lib/shortcuts'
  import {
    getLoadedItem,
    updateCachedItem,
    clearItemCache,
    primeCacheWithRoot
  } from './lib/item-store'

  const log = (message: string): void => {
    console.log(`[${new Date().toISOString()}] [Renderer] ${message}`)
  }

  type ActiveModal =
    | { type: 'settings' }
    | { type: 'layoutSelector'; item: MediaFolder; defaultLayout: 'grid' | 'tree' }
    | { type: 'metadataEditor'; item: LibraryItem }
    | { type: 'folderSettings'; item: MediaFolder }
    | { type: 'manualSearch'; item: LibraryItem }

  let viewStack: MediaFolder[] = $state([])
  let lastDetailItem: LibraryItem | null = $state(null)
  let isScanning = $state(true)
  let isRefreshing = $state(false)

  // --- Search & Filter State ---
  let globalSearchText = $state('')
  let globalSearchTags = $state<{ key: string; value: string }[]>([])
  const globalSearchQuery = $derived({ text: globalSearchText, tags: globalSearchTags })
  const isGlobalSearchActive = $derived(
    globalSearchQuery.text.trim() !== '' || globalSearchQuery.tags.length > 0
  )
  let searchResults = $state<SearchIndexEntry[]>([])
  let isPerformingSearch = $state(false)
  let filterQuery = $state<{ text: string; tags: { key: string; value: string }[] }>({
    text: '',
    tags: []
  })
  // --- End Search & Filter State ---

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
  const canGoBack = $derived(
    selectedItemForDetailView !== null || viewStack.length > 1 || isGlobalSearchActive
  )

  const folderToConfigureLayout = $derived(
    selectedItemForDetailView?.type === 'folder'
      ? (selectedItemForDetailView as MediaFolder)
      : currentFolder
  )

  $effect(() => {
    log('App mounted. Requesting library root from main process...')
    window.api.getLibraryRoot().then(async (root) => {
      log('Library root received from main process.')
      if (root) {
        primeCacheWithRoot(root)
        viewStack = [root]
        log('Root view rendered.')
      } else {
        log('No library found. Displaying welcome screen.')
      }
      isScanning = false
    })

    window.api.getAutocompleteSuggestions().then((s) => (allAutocompleteSuggestions = s))
    window.api.getSettings().then((s) => (settings = s))
    const unlistenSuggestions = window.api.onAutocompleteSuggestionsUpdated((s) => {
      allAutocompleteSuggestions = s
    })
    return () => unlistenSuggestions()
  })

  $effect(() => {
    // When navigating away from search results, clear the filter.
    void currentFolder?.id
    if (!isGlobalSearchActive) {
      filterQuery = { text: '', tags: [] }
    }
  })

  // --- Global Search Effect (No Debounce) ---
  $effect(() => {
    const query = globalSearchQuery
    if (isGlobalSearchActive) {
      isPerformingSearch = true
      selectedItemForDetailView = null
      const plainQuery = JSON.parse(JSON.stringify(query))
      window.api.performSearch(plainQuery).then((results) => {
        searchResults = results
        isPerformingSearch = false
      })
    } else {
      searchResults = []
      isPerformingSearch = false
    }
  })

  // Set up a listener for real-time metadata updates from the main process.
  $effect(() => {
    const unlisten = window.api.onLibraryItemUpdated((updatedItem) => {
      updateCachedItem(updatedItem)

      let itemInTree: LibraryItem | null = null
      for (const folder of viewStack) {
        itemInTree = findItemInTree(folder, updatedItem.id)
        if (itemInTree) break
      }
      if (itemInTree) Object.assign(itemInTree, updatedItem)

      if (selectedItemForDetailView?.id === updatedItem.id) {
        Object.assign(selectedItemForDetailView, updatedItem)
      }
      // Update item if it's in the current search results
      const indexInSearch = searchResults.findIndex((i) => i.id === updatedItem.id)
      if (indexInSearch > -1) {
        const itemInSearch = searchResults[indexInSearch]
        // Only update fields that exist on SearchIndexEntry
        itemInSearch.title = updatedItem.title ?? updatedItem.name
        itemInSearch.posterPath = updatedItem.posterPath
        itemInSearch._v = updatedItem._v
        searchResults = [...searchResults]
      }
    })
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
    if (!node || !node.children) return null
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

  function handleContextMenuOpen(item: LibraryItem | SearchIndexEntry) {
    handleItemClick(item)
  }

  async function handleScan(): Promise<void> {
    isScanning = true
    selectedItemForDetailView = null
    lastDetailItem = null
    clearItemCache()
    const newRoot = await window.api.scanLibrary()
    if (newRoot) {
      const loadedRoot = await getLoadedItem(newRoot.id)
      if (loadedRoot) viewStack = [loadedRoot as MediaFolder]
    } else if (!currentFolder) {
      viewStack = []
    }
    isScanning = false
  }

  async function handleRefresh(): Promise<void> {
    if (isRefreshing || isScanning) return
    isRefreshing = true
    lastDetailItem = null
    clearItemCache()
    const refreshedRoot = await window.api.refreshLibrary()
    if (refreshedRoot) {
      const loadedRoot = await getLoadedItem(refreshedRoot.id)
      if (loadedRoot) {
        viewStack = [loadedRoot as MediaFolder]
        selectedItemForDetailView = null
      }
    }
    isRefreshing = false
  }

  async function handlePlayFile(item: MediaFile): Promise<void> {
    const plainFile: MediaFile = {
      id: item.id,
      name: item.name,
      path: item.path,
      type: 'file',
      watched: item.watched
    }
    const success = await window.api.playFile(plainFile)
    if (success) {
      const root = viewStack[0]
      if (root) {
        const itemInTree = findItemInTree(root, item.id)
        if (itemInTree && itemInTree.type === 'file') {
          itemInTree.watched = true
        }
      }
    }
  }

  async function handleItemClick(item: LibraryItem | SearchIndexEntry): Promise<void> {
    const fromSearch = 'staticScore' in item

    const loadedItem = await getLoadedItem(item.id)
    if (!loadedItem) {
      console.error('Failed to load item from store:', item.id)
      return
    }

    if (fromSearch) {
      if (loadedItem.type === 'file' && !loadedItem.opensAsFolder) {
        handlePlayFile(loadedItem)
      } else {
        selectedItemForDetailView = loadedItem
      }
      return
    }

    if (selectedItemForDetailView) {
      const parent = selectedItemForDetailView
      if (loadedItem.type === 'folder') {
        if ((parent as MediaFolder).childrenClickAction === 'navigate') {
          drillDown(loadedItem as MediaFolder)
        } else {
          lastDetailItem = parent
          viewStack.push(parent as MediaFolder)
          selectedItemForDetailView = loadedItem
        }
        return
      }
      if (loadedItem.type === 'file' && loadedItem.opensAsFolder) {
        lastDetailItem = parent
        viewStack.push(parent as MediaFolder)
        selectedItemForDetailView = loadedItem
        return
      }
      if (loadedItem.type === 'file') {
        handlePlayFile(loadedItem)
      }
      return
    }

    lastDetailItem = null
    if (loadedItem.type === 'file' && loadedItem.opensAsFolder) {
      selectedItemForDetailView = loadedItem
      return
    }
    if (loadedItem.type === 'file' && (currentFolder?.layout ?? 'grid') === 'tree') {
      handlePlayFile(loadedItem)
      return
    }
    if (loadedItem.type === 'folder' && currentFolder?.childrenClickAction === 'navigate') {
      handleNavigateFolder(loadedItem as MediaFolder)
      return
    }
    selectedItemForDetailView = loadedItem
  }

  function handleNavigateFolder(folder: MediaFolder): void {
    selectedItemForDetailView = null
    lastDetailItem = null
    viewStack.push(folder)
  }

  function goBack(): void {
    if (!canGoBack) return

    if (isGlobalSearchActive && !selectedItemForDetailView) {
      globalSearchText = ''
      globalSearchTags = []
      return
    }

    if (selectedItemForDetailView) {
      if (lastDetailItem) {
        selectedItemForDetailView = lastDetailItem
        viewStack.pop()
        lastDetailItem = null
      } else {
        selectedItemForDetailView = null
      }
    } else {
      if (lastDetailItem) {
        selectedItemForDetailView = lastDetailItem
        viewStack.pop()
        viewStack.pop()
        lastDetailItem = null
      } else if (viewStack.length > 1) {
        viewStack.pop()
      }
    }
  }

  function goForward(): void {
    // This can be implemented in the future to handle forward navigation.
  }

  function handleSearchByTag(key: string, value: string): void {
    selectedItemForDetailView = null
    globalSearchText = ''
    globalSearchTags = [{ key, value }]
  }

  function handleSearchKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
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
    return () => cleanupShortcuts()
  })

  function openLayoutSelector() {
    if (folderToConfigureLayout) {
      const isDetailViewContext = selectedItemForDetailView?.id === folderToConfigureLayout.id
      activeModal = {
        type: 'layoutSelector',
        item: folderToConfigureLayout,
        defaultLayout: isDetailViewContext ? 'tree' : 'grid'
      }
    }
  }

  async function handleShowContextMenu(
    item: LibraryItem | SearchIndexEntry,
    event: MouseEvent,
    options?: { layout?: string }
  ) {
    event.preventDefault()
    event.stopPropagation()

    // If it's a search result, we only have partial data.
    // Fetch the full LibraryItem before showing the menu.
    if ('staticScore' in item) {
      const fullItem = await getLoadedItem(item.id)
      if (fullItem) {
        contextMenuItem = fullItem
      } else {
        return // Can't show menu if full item fails to load
      }
    } else {
      // It's already a full LibraryItem
      contextMenuItem = item
    }

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
        if (wasSettings) {
          window.api.getSettings().then((s) => (settings = s))
        }
      }}
      scanLibrary={handleScan}
    />
  {:else if activeModal.type === 'layoutSelector'}
    <LayoutSelector
      item={activeModal.item}
      {groupByKeys}
      onClose={() => (activeModal = null)}
      defaultLayout={activeModal.defaultLayout}
    />
  {:else if activeModal.type === 'metadataEditor'}
    <MetadataEditor item={activeModal.item} onClose={() => (activeModal = null)} />
  {:else if activeModal.type === 'folderSettings'}
    <FolderSettingsModal
      item={activeModal.item}
      onClose={() => (activeModal = null)}
      onNeedRefresh={handleRefresh}
    />
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
        const itemToConfigure = contextMenuItem as MediaFolder
        const isDetailViewContext =
          selectedItemForDetailView && selectedItemForDetailView.id === itemToConfigure.id

        activeModal = {
          type: 'layoutSelector',
          item: itemToConfigure,
          defaultLayout: isDetailViewContext ? 'tree' : 'grid'
        }
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
          <h1>
            {#if isGlobalSearchActive}
              Search Results
            {:else}
              {currentFolder?.title ?? currentFolder?.name ?? 'Media Browser'}
            {/if}
          </h1>
        {/if}
      </div>

      <div class="search-container" onkeydown={handleSearchKeyDown}>
        {#if !selectedItemForDetailView}
          <SearchInput
            initialQuery={globalSearchQuery}
            suggestions={allAutocompleteSuggestions}
            onQueryChange={(newQuery) => {
              globalSearchText = newQuery.text
              globalSearchTags = newQuery.tags
            }}
            bind:element={searchInputEl}
          />
        {/if}
      </div>

      <div class="header-right">
        {#if !selectedItemForDetailView}
          <button
            onclick={handleRefresh}
            disabled={isRefreshing || isScanning}
            title="Refresh Library (F5)"
            class="refresh-button"
          >
            <span class:reloading={isRefreshing}>⟳</span>
          </button>
        {/if}
        {#if folderToConfigureLayout}
          <button onclick={openLayoutSelector} title="Set View Layout" class="layout-button">
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
          <button
            onclick={(e) => handleShowContextMenu(folderToConfigureLayout, e)}
            title="More options..."
            class="more-options-button"
          >
            <!-- vertical ellipsis icon -->
            <svg
              width="16"
              height="16"
              viewBox="0 0 4 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              ><path
                d="M2 4C3.10457 4 4 3.10457 4 2C4 0.895431 3.10457 0 2 0C0.895431 0 0 0.895431 0 2C0 3.10457 0.895431 4 2 4Z"
                fill="currentColor"
              /><path
                d="M2 10C3.10457 10 4 9.10457 4 8C4 6.89543 3.10457 6 2 6C0.895431 6 0 6.89543 0 8C0 9.10457 0.895431 10 2 10Z"
                fill="currentColor"
              /><path
                d="M2 16C3.10457 16 4 15.1046 4 14C4 12.8954 3.10457 12 2 12C0.895431 12 0 12.8954 0 14C0 15.1046 0.895431 16 2 16Z"
                fill="currentColor"
              /></svg
            >
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
    {:else if !currentFolder && !isGlobalSearchActive}
      <div class="welcome-screen">
        <h2>Welcome to Media Browser</h2>
        <p>To get started, scan a folder containing your media.</p>
        <button onclick={handleScan}>Select Media Folder</button>
      </div>
    {:else}
      <div class="main-view-container" class:hidden={selectedItemForDetailView}>
        <!-- SEARCH VIEW: Rendered but hidden via CSS unless active -->
        <div class="view-wrapper" class:hidden={!isGlobalSearchActive}>
          <div class="search-header">
            {#if isPerformingSearch}
              <span>Searching...</span>
            {:else}
              <span>Found {searchResults.length} results.</span>
            {/if}
          </div>
          <div class="search-content-wrapper">
            {#if searchResults.length > 0}
              <MediaView
                items={searchResults}
                onItemClick={handleItemClick}
                layout="grid"
                onShowContextMenu={handleShowContextMenu}
                suggestions={allAutocompleteSuggestions}
              />
            {:else if !isPerformingSearch}
              <p class="status-text">No results found.</p>
            {/if}
          </div>
        </div>

        <!-- FOLDER VIEW: Rendered but hidden via CSS unless active -->
        {#if currentFolder}
          <div class="view-wrapper" class:hidden={isGlobalSearchActive}>
            <FilterBar
              suggestions={allAutocompleteSuggestions}
              onQueryChange={(query) => (filterQuery = query)}
            />
            <div class="folder-content-wrapper">
              <MediaView
                parentItem={currentFolder}
                items={currentFolder.children}
                searchQuery={filterQuery}
                onItemClick={handleItemClick}
                layout={currentFolder.layout ?? 'grid'}
                onShowContextMenu={handleShowContextMenu}
                suggestions={allAutocompleteSuggestions}
              />
            </div>
          </div>
        {/if}
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
    -webkit-app-region: drag;
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
  .more-options-button,
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
  .layout-button,
  .more-options-button {
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

  .main-view-container {
    display: flex;
    flex-direction: column;
    flex: 1;
    position: relative; /* For stacking contexts */
  }
  .main-view-container.hidden {
    visibility: hidden;
  }

  .view-wrapper {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .view-wrapper.hidden {
    visibility: hidden;
  }

  .folder-content-wrapper,
  .search-content-wrapper {
    flex-grow: 1;
    overflow-y: auto;
  }

  .search-header {
    padding: 0.5rem 1.5rem;
    font-style: italic;
    color: var(--ev-c-text-2);
    border-bottom: 1px solid var(--color-background-mute);
    flex-shrink: 0;
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
