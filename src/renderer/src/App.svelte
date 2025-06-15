<script lang="ts">
  import MediaGrid from './components/MediaGrid.svelte'
  import SettingsModal from './components/SettingsModal.svelte'

  // Types are globally available from src/preload/index.d.ts
  let viewStack: MediaFolder[] = $state([])
  let isLoading = $state(true)
  let showSettings = $state(false)

  const currentFolder = $derived(viewStack.length > 0 ? viewStack[viewStack.length - 1] : null)
  const atRoot = $derived(viewStack.length <= 1)

  $effect(() => {
    window.api.getLibraryRoot().then((root) => {
      if (root) {
        viewStack = [root]
      }
      isLoading = false
    })
  })

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
      viewStack.push(item)
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
    <div class="header-left">
      <button class="back-button" onclick={goBack} disabled={atRoot} title="Go back"> ← </button>
      <h1>{currentFolder?.name ?? 'Media Browser'}</h1>
    </div>
    <div class="header-right">
      <button onclick={() => (showSettings = true)} title="Settings">⚙️</button>
      <button onclick={handleScan} disabled={isLoading}>
        {isLoading ? 'Loading...' : 'Scan Library Folder'}
      </button>
    </div>
  </header>

  <div class="content">
    {#if isLoading}
      <p class="status-text">Loading library...</p>
    {:else if currentFolder}
      <MediaGrid items={currentFolder.children} itemclick={handleItemClick} />
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
  main {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--color-background-mute);
    flex-shrink: 0;
    -webkit-app-region: drag;
    gap: 1.5rem;
  }

  .header-left,
  .header-right {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .header-left {
    overflow: hidden; /* For long folder names */
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
