<script lang="ts">
  import MediaGrid from './components/MediaGrid.svelte'
  import SettingsModal from './components/SettingsModal.svelte'
  import WindowControls from './components/WindowControls.svelte'
  import ItemDetail from './components/ItemDetail.svelte'
  import { initializeShortcuts } from './lib/shortcuts'

  // Types are globally available from src/preload/index.d.ts
  let viewStack: MediaFolder[] = $state([])
  let isScanning = $state(true) // For initial load or changing library folder
  let isRefreshing = $state(false) // For updating the current library
  let showSettings = $state(false)
  let searchQuery = $state('')
  let selectedItemForDetailView: LibraryItem | null = $state(null)
  let searchInputEl: HTMLInputElement

  const currentFolder = $derived(viewStack.length > 0 ? viewStack[viewStack.length - 1] : null)
  // Back button is disabled if we are at the root grid view.
  // It should be enabled if we are in a detail view.
  const canGoBack = $derived(selectedItemForDetailView !== null || viewStack.length > 1)

  const filteredChildren = $derived(
    currentFolder?.children.filter((item) =>
      (item.title ?? item.name).toLowerCase().includes(searchQuery.toLowerCase())
    ) ?? []
  )

  $effect(() => {
    window.api.getLibraryRoot().then((root) => {
      if (root) {
        viewStack = [root]
      }
      isScanning = false
    })
  })

  $effect(() => {
    // When the current folder changes, or we enter/exit detail view, reset search.
    void currentFolder?.id
    void selectedItemForDetailView
    searchQuery = ''
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

  // Used by the main MediaGrid. Always opens the detail view.
  function handleGridItemClick(item: LibraryItem): void {
    selectedItemForDetailView = JSON.parse(JSON.stringify(item))
  }

  // Used by ItemDetail when a child folder is clicked.
  function handleNavigateFolder(folder: MediaFolder): void {
    selectedItemForDetailView = null
    // Create a deep copy to avoid issues with Svelte's proxy objects
    viewStack.push(JSON.parse(JSON.stringify(folder)))
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

  $effect(() => {
    const cleanupShortcuts = initializeShortcuts({
      openSettings: () => (showSettings = true),
      focusSearch: () => searchInputEl?.focus(),
      navigateBack: goBack,
      navigateForward: goForward,
      reloadLibrary: handleRefresh
    })

    // Cleanup the listeners when the component is destroyed.
    return () => cleanupShortcuts()
  })
</script>

{#if showSettings}
  <SettingsModal close={() => (showSettings = false)} scanLibrary={handleScan} />
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

      <div class="search-container">
        {#if currentFolder && !selectedItemForDetailView}
          <input
            bind:this={searchInputEl}
            type="search"
            placeholder="Search..."
            bind:value={searchQuery}
            aria-label="Search current folder"
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
        <button onclick={() => (showSettings = true)} title="Settings" class="settings-button">⚙️</button>
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
        Keep MediaGrid mounted but hidden when showing ItemDetail.
        This makes navigating "back" from the detail view instant.
      -->
      <div hidden={selectedItemForDetailView !== null}>
        <MediaGrid items={filteredChildren} itemclick={handleGridItemClick} />
      </div>

      {#if selectedItemForDetailView}
        <ItemDetail
          item={selectedItemForDetailView}
          onPlayFile={handlePlayFile}
          onNavigateFolder={handleNavigateFolder}
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

  .search-container input {
    -webkit-app-region: no-drag;
    width: 100%;
    max-width: 400px;
    padding: 0.5rem 0.9rem;
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    color: var(--color-text);
    border-radius: 5px;
    font-size: 1rem;
    font-weight: 600;
  }

  main {
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
    height: 56px;
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
    background-color: var(--ev-c-gray-3);
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
