<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from '@lib/api'
  import { useDragSort } from '@lib/drag-sort.svelte'
  import { modalStore } from '@lib/modal-store.svelte'
  import { useQueryClient } from '@tanstack/svelte-query'
  import FilesystemTreeBrowser from '../setup/FilesystemTreeBrowser.svelte'

  let { onComplete, onStatusUpdate }: { onComplete?: () => void; onStatusUpdate?: () => void } =
    $props()
  const queryClient = useQueryClient()

  type SourceEntry = { id: ReturnType<typeof crypto.randomUUID>; path: string; isRelative: boolean }

  let step: 'library' | 'media' = $state('library')
  let libraryLocation = $state('')
  let sources = $state<SourceEntry[]>([{ id: crypto.randomUUID(), path: '', isRelative: false }])
  let resolvedPaths = $state<Record<string, { path: string; exists: boolean }>>({})
  let folderSettings = $state<Record<string, Record<string, any>>>({})
  let isSaving = $state(false)
  let error = $state('')
  let setupCompleted = $state(false)
  let deduplicateSources = $state(false)
  let deduplicateMinDepth = $state(1)
  const drag = useDragSort(
    () => sources,
    (items) => (sources = items)
  )

  $effect(() => {
    const snapshot = sources.map((s) => ({ id: s.id, path: s.path, isRelative: s.isRelative }))
    const libLoc = libraryLocation

    if (step !== 'media') return

    const timeout = setTimeout(async () => {
      const updates: Record<string, { path: string; exists: boolean }> = {}
      for (const s of snapshot) {
        if (!s.path.trim()) {
          updates[s.id] = { path: '', exists: true }
          continue
        }
        try {
          const result = await api.resolveMediaSourcePath({
            path: s.path,
            isRelative: s.isRelative,
            libraryLocation: libLoc
          })
          updates[s.id] = { path: result.path, exists: result.exists }
        } catch {
          updates[s.id] = { path: 'Error resolving path', exists: false }
        }
      }
      resolvedPaths = updates
    }, 100)

    return () => clearTimeout(timeout)
  })

  function isAbsolutePath(p: string): boolean {
    return (
      p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p) || p.startsWith('http')
    )
  }

  function addSource() {
    sources = [...sources, { id: crypto.randomUUID(), path: '', isRelative: false }]
  }

  function removeSource(id: string) {
    sources = sources.filter((s) => s.id !== id)
  }

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
      if (result.settings?.mediaSources?.length) {
        sources = result.settings.mediaSources.map((s) => ({ ...s })) as SourceEntry[]
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
    if (sources.some((s) => !s.path.trim())) {
      error = 'All media source paths are required.'
      return
    }
    for (const source of sources) {
      const resolved = resolvedPaths[source.id]
      if (resolved && !source.isRelative && !isAbsolutePath(resolved.path)) {
        error = 'All media source paths must be absolute.'
        return
      }
    }

    error = ''
    isSaving = true
    try {
      await api.saveSettings({ libraryLocation, deduplicateSources, deduplicateMinDepth })

      for (const source of sources) {
        await api.saveSource(source)
      }
      await api.performScan(folderSettings)

      queryClient.invalidateQueries()
      if (onStatusUpdate) onStatusUpdate()

      setupCompleted = true
      onComplete?.()

      window.location.reload()
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
        <div class="sources-list">
          {#each sources as source, i (source.id)}
            {@const resolved = resolvedPaths[source.id]}
            {@const resolvedAbsPath = resolved?.path ?? ''}
            {@const showFolderSettings =
              resolvedAbsPath &&
              isAbsolutePath(resolvedAbsPath) &&
              resolved?.exists &&
              !resolvedAbsPath.includes('Error')}

            <div
              class="source-entry"
              class:drag-over={drag.dragOverIndex === i}
              ondragover={(e) => drag.onDragOver(e, i)}
              ondragenter={(e) => e.preventDefault()}
              ondrop={(e) => drag.onDrop(e, i)}
              ondragend={drag.onDragEnd}
            >
              <div class="source-header">
                {#if sources.length > 1}
                  <span
                    class="drag-handle"
                    title="Drag to reorder"
                    draggable="true"
                    ondragstart={(e) => drag.onDragStart(e, i)}
                  >⠿</span>
                {/if}
                <span class="source-label">
                  {sources.length > 1 ? `Source ${i + 1}` : 'Media Source'}
                </span>
                {#if sources.length > 1}
                  <button class="remove-btn" onclick={() => removeSource(source.id)}>Remove</button>
                {/if}
              </div>

              <div class="form-group">
                <input
                  type="text"
                  bind:value={source.path}
                  placeholder="Enter local path (e.g., C:/Movies)"
                  autofocus={i === 0}
                />
                {#if resolvedAbsPath}
                  <p class="help-text">
                    Resolved: <code>{resolvedAbsPath}</code>
                    {#if !resolved?.exists && !resolvedAbsPath.includes('Error')}
                      {#if !source.isRelative && !isAbsolutePath(resolvedAbsPath)}
                        <span class="path-error">Absolute path required</span>
                      {:else}
                        <span class="path-warning">(Will be created)</span>
                      {/if}
                    {/if}
                  </p>
                {/if}
              </div>

              <div class="form-group checkbox-group">
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={source.isRelative} />
                  <span>Path is relative to library data parent</span>
                </label>
              </div>

              {#if showFolderSettings}
                <div class="form-group folder-setup">
                  <label>Configure Folders</label>
                  <p class="help-text">
                    Select which folders should have metadata automatically fetched for their
                    children.
                  </p>
                  <FilesystemTreeBrowser
                    rootPath={resolvedAbsPath}
                    onSettingsChange={(settings) =>
                      (folderSettings = { ...folderSettings, [source.id]: settings })}
                  />
                </div>
              {/if}
            </div>
          {/each}
        </div>

        <button class="add-source-btn" onclick={addSource}>+ Add Source</button>

        {#if sources.length > 1}
          <div class="dedup-section">
            <label class="checkbox-label">
              <input type="checkbox" bind:checked={deduplicateSources} />
              <span>Deduplicate sources</span>
            </label>
            {#if deduplicateSources}
              {@const parts = ['Movies', 'ActionFilm', 'Scene', 'Extra', 'Bonus', 'Clip', 'Featurette', 'Interview', 'Trailer', 'Short']}
              {@const examplePath = parts.slice(0, deduplicateMinDepth).join('/') + '/'}
              <div class="dedup-depth">
                <label for="dedup-min-depth">Skip folders from</label>
                <input
                  type="number"
                  id="dedup-min-depth"
                  bind:value={deduplicateMinDepth}
                  min="1"
                  max="10"
                  oninput={(e) => {
                    const v = parseInt((e.target as HTMLInputElement).value)
                    if (!isNaN(v)) deduplicateMinDepth = Math.max(1, Math.min(10, v))
                  }}
                />
                <span class="dedup-depth-unit">{deduplicateMinDepth === 1 ? 'level' : 'levels'} deep</span>
              </div>
              <p class="help-text">
                e.g. <code>{examplePath}</code> — Folders at this depth or deeper that already exist
                in a higher-priority source will be skipped. Useful for SSD + HDD mirror setups.
              </p>
            {:else}
              <p class="help-text">
                When enabled, lower-priority sources skip folders already present in a
                higher-priority source, avoiding duplicate entries.
              </p>
            {/if}
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
            disabled={isSaving || sources.some((s) => !s.path.trim())}
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

  .sources-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .source-entry {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    background-color: var(--color-background-mute);
    border: 1px solid var(--color-border);
    border-radius: 8px;
  }

  .source-entry.drag-over {
    border-color: var(--color-primary);
    background-color: color-mix(in srgb, var(--color-primary) 8%, var(--color-background-mute));
  }

  .source-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .drag-handle {
    color: var(--color-text-dim);
    font-size: 1.1rem;
    cursor: grab;
    flex-shrink: 0;
    user-select: none;
  }

  .source-label {
    font-weight: 600;
    font-size: 0.9rem;
    flex: 1;
  }

  .remove-btn {
    padding: 0.25rem 0.6rem;
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-text-dim);
    cursor: pointer;
    font-size: 0.85rem;
  }

  .remove-btn:hover {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }

  .add-source-btn {
    align-self: flex-start;
    padding: 0.5rem 1rem;
    background: none;
    border: 1px dashed var(--color-border);
    border-radius: 8px;
    color: var(--color-text-soft);
    cursor: pointer;
    font-size: 0.9rem;
    margin-top: 0.25rem;
  }

  .add-source-btn:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .dedup-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    background-color: var(--color-background-mute);
    border: 1px solid var(--color-border);
    border-radius: 8px;
  }

  .dedup-depth {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .dedup-depth label {
    color: var(--color-text-soft);
  }

  .dedup-depth input[type='number'] {
    width: 3.5rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.9rem;
  }

  .dedup-depth-unit {
    color: var(--color-text-soft);
    font-size: 0.9rem;
  }
</style>
