<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from '@lib/api'
  import { modalStore } from '@lib/modal-store.svelte'
  import { useQueryClient } from '@tanstack/svelte-query'
  import FilesystemTreeBrowser from '../setup/FilesystemTreeBrowser.svelte'

  let { onComplete, onStatusUpdate }: { onComplete: () => void; onStatusUpdate?: () => void } =
    $props()
  const queryClient = useQueryClient()

  let step: 'library' | 'media' = $state('library')
  let libraryLocation = $state('')
  let mediaSourcePath = $state('')
  let mediaSourcePathIsRelative = $state(false)
  let isSaving = $state(false)
  let error = $state('')
  let resolvedPath = $state('')
  let pathExists = $state(true)
  let folderSettings = $state<Record<string, any>>({})
  let setupCompleted = $state(false)

  $effect(() => {
    // Capture reactive values synchronously to ensure Svelte tracks them as dependencies
    const path = mediaSourcePath
    const isRelative = mediaSourcePathIsRelative
    const libLoc = libraryLocation

    if (step === 'media' && path.trim()) {
      const timeout = setTimeout(async () => {
        try {
          const result = await api.resolveMediaSourcePath({
            path,
            isRelative,
            libraryLocation: libLoc
          })
          resolvedPath = result.path
          pathExists = result.exists
        } catch {
          resolvedPath = 'Error resolving path'
          pathExists = false
        }
      }, 100)
      return () => clearTimeout(timeout)
    } else {
      resolvedPath = ''
      pathExists = true
    }
  })

  const isAbsolute = $derived(
    resolvedPath.startsWith('/') ||
      resolvedPath.startsWith('\\') ||
      /^[a-zA-Z]:/.test(resolvedPath) ||
      resolvedPath.startsWith('http')
  )

  onMount(async () => {
    // Check current settings to see if we have a location but no DB
    try {
      const settings = await api.getSettings()
      if (settings.libraryLocation) {
        libraryLocation = settings.libraryLocation
        await checkStateAndNavigate(libraryLocation)
      }
    } catch (err) {
      // Ignore if settings fetch fails during setup
    }
  })

  async function checkStateAndNavigate(path: string) {
    isSaving = true
    try {
      const result = await api.getLibraryRoot(path)

      // If settings exist, always pre-fill them
      if (result.settings) {
        mediaSourcePath = result.settings.mediaSourcePath || ''
        mediaSourcePathIsRelative = result.settings.mediaSourcePathIsRelative || false
      }

      if (result.status === 'ready') {
        // Full library exists (JSON + DB)!
        if (step === 'library') {
          // If we are at the first step and everything is there, just save location and finish
          await api.saveSettings({ libraryLocation: path })
          onComplete()
        }
      } else if (result.status === 'db_missing') {
        // Library settings exist but DB is missing (or JSON exists but no DB)
        // Proceed to Step 2 to (re)configure media source and scan
        step = 'media'
      } else {
        // Nothing exists at this path (no_settings or no_location)
        if (step === 'library') {
          step = 'media'
        }
      }
    } catch (err: any) {
      error = err.message || 'Failed to check library location.'
    } finally {
      isSaving = false
    }
  }

  async function handleLibraryContinue() {
    if (!libraryLocation.trim()) {
      error = 'Library Location is required.'
      return
    }
    error = ''
    await checkStateAndNavigate(libraryLocation)
  }

  async function handleMediaSave() {
    if (!mediaSourcePath.trim()) {
      error = 'Media Source Path is required.'
      return
    }
    error = ''
    isSaving = true
    try {
      // 1. Resolve path for initial scan (use provided libraryLocation if step is currently being set up)
      const result = await api.resolveMediaSourcePath({
        path: mediaSourcePath,
        isRelative: mediaSourcePathIsRelative,
        libraryLocation: libraryLocation
      })
      const resolved = result.path

      if (!mediaSourcePathIsRelative && !isAbsolute) {
        error = 'An absolute path is required.'
        isSaving = false
        return
      }

      // 3. Save all settings
      await api.saveSettings({
        libraryLocation,
        mediaSourcePath,
        mediaSourcePathIsRelative
      })

      // 4. Initiate Scan (awaited until root creation is confirmed)
      await api.performScan({ path: resolved, initialFolderSettings: folderSettings })

      // 5. Invalidate queries and finalize
      queryClient.invalidateQueries()

      // Notify parent to refresh libraryStatus state (which now definitely has a root ID)
      if (onStatusUpdate) onStatusUpdate()

      setupCompleted = true
      onComplete()
    } catch (err: any) {
      error = err.message || 'Failed to save settings.'
      sessionStorage.removeItem('showInitialFolderSettingsAfterScan')
    } finally {
      isSaving = false
    }
  }
</script>

<div class="setup-screen">
  <div class="setup-container">
    <header>
      <h1>Welcome to Kinome</h1>
      <p>
        {#if step === 'library'}
          Set up your library data location.
        {:else}
          Configure your media source directory.
        {/if}
      </p>
    </header>

    <div class="setup-content">
      {#if step === 'library'}
        <div class="form-group">
          <label for="library-data-location">Library Data Location</label>
          <input
            type="text"
            id="library-data-location"
            bind:value={libraryLocation}
            placeholder="Path or URL"
            autofocus
          />
          <p class="help-text">
            The local directory (or server URL) where metadata, images, and the database are stored.
          </p>
        </div>

        {#if error}
          <p class="error-message">{error}</p>
        {/if}

        <div class="actions">
          <button
            class="primary"
            onclick={handleLibraryContinue}
            disabled={isSaving || !libraryLocation.trim()}
          >
            {#if isSaving}Checking...{:else}Continue{/if}
          </button>
        </div>
      {:else}
        <div class="form-group">
          <label for="media-source-path">Media Source Path</label>
          <input
            type="text"
            id="media-source-path"
            bind:value={mediaSourcePath}
            placeholder="Enter local path (e.g., C:/Movies)"
            autofocus
          />
          <p class="help-text">
            The root directory where your media files are stored.
            {#if resolvedPath}
              <br />
              Current resolved path: <code>{resolvedPath}</code>
              {#if !pathExists && !resolvedPath.includes('Error')}
                {#if !mediaSourcePathIsRelative && !isAbsolute}
                  <span class="path-error">Absolute path required</span>
                {:else}
                  <span class="path-warning">(Will be created)</span>
                {/if}
              {/if}
            {/if}
          </p>
        </div>

        <div class="form-group checkbox-group">
          <label class="checkbox-label" for="path-is-relative">
            <input type="checkbox" id="path-is-relative" bind:checked={mediaSourcePathIsRelative} />
            <span>Path is relative to library data parent</span>
          </label>
        </div>

        {#if isAbsolute && pathExists && !resolvedPath.includes('Error')}
          <div class="form-group folder-setup">
            <label>Configure Folders</label>
            <p class="help-text">
              Select which folders should have metadata (posters, overviews, etc.) automatically
              fetched for their children.
            </p>
            <FilesystemTreeBrowser
              rootPath={resolvedPath}
              onSettingsChange={(settings) => (folderSettings = settings)}
            />
          </div>
        {/if}

        {#if error}
          <p class="error-message">{error}</p>
        {/if}

        <div class="actions">
          <button class="secondary" onclick={() => (step = 'library')} disabled={isSaving}>
            Change Data Location
          </button>
          <button
            class="primary"
            onclick={handleMediaSave}
            disabled={isSaving ||
              !mediaSourcePath.trim() ||
              (!mediaSourcePathIsRelative && !isAbsolute)}
          >
            {#if isSaving}Saving...{:else}Save & Scan{/if}
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .setup-screen {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: var(--color-background);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 50;
  }

  .setup-container {
    width: 100%;
    max-width: 800px;
    background-color: var(--color-background-soft);
    padding: 2rem;
    border-radius: 12px;
    box-shadow: var(--shadow-standard);
    border: 1px solid var(--color-border);
    max-height: 90vh;
    overflow-y: auto;
  }

  header {
    margin-bottom: 2rem;
    text-align: center;
  }

  header h1 {
    font-size: 2rem;
    margin: 0 0 0.5rem;
  }

  header p {
    color: var(--color-text-soft);
    margin: 0;
  }

  .setup-content {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .form-group label {
    font-weight: 600;
    font-size: 0.9rem;
  }

  input[type='text'] {
    padding: 0.75rem;
    background-color: var(--color-background-mute);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text);
    font-size: 1rem;
    width: 100%;
  }

  .help-text {
    font-size: 0.85rem;
    color: var(--color-text-dim);
    margin: 0;
  }

  .checkbox-group {
    gap: 1rem;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    cursor: pointer;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    margin-top: 1rem;
  }

  /* Note: button styles are inherited from base.css, 
     adding minor overrides for size/padding if needed */
  button {
    padding: 0.8rem 2rem;
    border-radius: 8px;
    font-size: 1rem;
  }

  .error-message {
    color: var(--color-danger);
    font-size: 0.9rem;
    background-color: rgba(239, 68, 68, 0.1);
    padding: 0.75rem;
    border-radius: 6px;
    border: 1px solid rgba(239, 68, 68, 0.2);
    margin: 0;
  }

  code {
    background-color: var(--color-background-mute);
    padding: 0.1rem 0.3rem;
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.9em;
    color: var(--color-text-dim);
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: bottom;
  }
  .path-warning {
    color: var(--color-primary);
    font-size: 0.8rem;
    font-weight: 500;
    margin-left: 0.5rem;
  }

  .path-error {
    color: var(--color-danger);
    font-size: 0.8rem;
    font-weight: 500;
    margin-left: 0.5rem;
  }
</style>
