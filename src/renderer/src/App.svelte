<script lang="ts">
  import MediaGrid from './components/MediaGrid.svelte'
  import SettingsModal from './components/SettingsModal.svelte'
  import WindowControls from './components/WindowControls.svelte'

  // Types are globally available from src/preload/index.d.ts
  let viewStack: MediaFolder[] = $state([])
  let isLoading = $state(true)
  let showSettings = $state(false)
  let searchQuery = $state('')

  const currentFolder = $derived(viewStack.length > 0 ? viewStack[viewStack.length - 1] : null)
  const atRoot = $derived(viewStack.length <= 1)

  const filteredChildren = $derived(
    currentFolder?.children.filter((item) =>
      item.name.toLowerCase().includes(searchQuery.toLowerCase())
    ) ?? []
  )

  $effect(() => {
    window.api.getLibraryRoot().then((root) => {
      if (root) {
        viewStack = [root]
      }
      isLoading = false
    })
  })

  $effect(() => {
    // When the current folder changes, reset the search query.
    // The dependency on currentFolder.id ensures this runs on navigation.
    void currentFolder?.id
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
    isLoading = true
    const newRoot = await window.api.scanLibrary()
    if (newRoot) {
      viewStack = [newRoot]
    } else {
      // If scan is cancelled or fails, reset the stack.
      viewStack = []
    }
    isLoading = false
  }

  async function handleItemClick(item: LibraryItem): Promise<void> {
    if (item.type === 'folder') {
      // Create a deep copy to avoid issues with Svelte's proxy objects
      // when pushing to the view stack.
      viewStack.push(JSON.parse(JSON.stringify(item)))
    } else {
      // De-proxy the item before sending it over IPC by creating a plain object.
      // The $state proxy object cannot be cloned for IPC.
      const plainFile: MediaFile = {
        id: item.id,
        name: item.name,
        path: item.path,
        type: 'file',
        watched: item.watched
      }
      const success = await window.api.playFile(plainFile)
      // Only update the UI if the backend call was processed successfully.
      if (success) {
        // Mutate the original proxied item to trigger UI update
        item.watched = true
      }
    }
  }

  function goBack(): void {
    if (!atRoot) {
      viewStack.pop()
    }
  }
</script>

{#if showSettings}
  <SettingsModal close={() => (showSettings = false)} />
{/if}

<main>
  <header>
    <div class="header-content">
      <div class="header-left">
        <button class="back-button" onclick={goBack} disabled={atRoot} title="Go back"> ← </button>
        <h1>{currentFolder?.name ?? 'Media Browser'}</h1>
      </div>

      <div class="search-container">
        {#if currentFolder}
          <input
            type="search"
            placeholder="Search..."
            bind:value={searchQuery}
            aria-label="Search current folder"
          />
        {/if}
      </div>

      <div class="header-right">
        <button onclick={() => (showSettings = true)} title="Settings">⚙️</button>
        <button onclick={handleScan} disabled={isLoading}>
          {isLoading ? 'Loading...' : 'Scan Library Folder'}
        </button>
      </div>
    </div>
    <WindowControls />
  </header>

  <div class="content">
    {#if isLoading}
      <p class="status-text">Loading library...</p>
    {:else if currentFolder}
      <MediaGrid items={filteredChildren} itemclick={handleItemClick} />
    {:else}
      <div class="welcome-screen">
        <h2>Welcome to Media Browser</h2>
        <p>To get started, scan a folder containing your media.</p>
        <button onclick={handleScan}>Select Media Folder</button>
      </div>
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

  .back-button {
    padding: 0.5rem;
    line-height: 1;
    width: 36px;
    height: 36px;
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
</style>
