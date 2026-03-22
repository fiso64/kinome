<script lang="ts">
  import { api } from '@lib/api'
  import { useDragSort } from '@lib/drag-sort.svelte'
  import type { MediaSource } from '@shared/types'
  import { flip } from 'svelte/animate'
  import IconX from '@components/ui/IconX.svelte'

  let {
    mediaSources = $bindable(),
    libraryLocation = $bindable(),
    shadowSources = $bindable(),
    shadowMinDepth = $bindable()
  }: {
    mediaSources: MediaSource[]
    libraryLocation: string
    shadowSources: boolean
    shadowMinDepth: number
  } = $props()

  let resolvedPaths = $state<Record<string, { path: string; exists: boolean }>>({})
  const drag = useDragSort(
    () => mediaSources,
    (items) => (mediaSources = items)
  )
  $effect(() => {
    const snapshot = mediaSources.map((s) => ({ id: s.id, path: s.path, isRelative: s.isRelative }))
    const libLoc = libraryLocation

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
    }, 300)

    return () => clearTimeout(timeout)
  })

  function addSource() {
    mediaSources = [...mediaSources, { id: crypto.randomUUID(), path: '', isRelative: false }]
  }

  function removeSource(id: string) {
    mediaSources = mediaSources.filter((s) => s.id !== id)
  }

</script>

<div class="form-section">
  <div class="form-group">
    <label for="library-data-location">Library Data Location</label>
    <input
      type="text"
      id="library-data-location"
      bind:value={libraryLocation}
      placeholder="Path or URL"
    />
    <p class="help-text">
      The local directory (or server URL) where metadata, images, and the database are stored.
      Changing this requires an app restart.
    </p>
  </div>
</div>

<div class="form-section">
  <h3>Media Sources</h3>
  <p class="help-text">Directories where your media files are stored. Drag to reorder.</p>
  <div class="sources-list">
    {#each mediaSources as source, i (source.id)}
      {@const resolved = resolvedPaths[source.id]}
      <div
        class="source-entry"
        class:drag-placeholder={drag.draggedIndex === i}
        use:drag.item={i}
        use:drag.handle={i}
        animate:flip={{ duration: 200 }}
      >
        <div class="source-row">
          <span class="drag-handle" title="Drag to reorder">⠿</span>
          <input
            type="text"
            bind:value={source.path}
            placeholder="Enter local path (e.g., C:/Movies)"
          />
          {#if mediaSources.length > 1}
            <button
              class="remove-btn"
              onclick={() => removeSource(source.id)}
              title="Remove source"
            ><IconX size={12} /></button>
          {/if}
        </div>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={source.isRelative} />
          <span>Path is relative to library data parent</span>
        </label>
        {#if resolved?.path}
          <p class="help-text resolved-path">
            Resolved: <code>{resolved.path}</code>
            {#if !resolved.exists}
              <span class="path-warning">(Will be created)</span>
            {/if}
          </p>
        {/if}
      </div>
    {/each}
  </div>
  <button class="add-source-btn" onclick={addSource}>+ Add Source</button>

  {#if mediaSources.length > 1}
    <div class="shadow-section">
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={shadowSources} />
        <span>Shadow sources</span>
      </label>
      {#if shadowSources}
        {@const parts = ['Movies', 'ActionFilm', 'Scene', 'Extra', 'Bonus', 'Clip', 'Featurette', 'Interview', 'Trailer', 'Short']}
        {@const examplePath = parts.slice(0, shadowMinDepth).join('/') + '/'}
        <div class="shadow-depth">
          <label for="shadow-min-depth">Skip folders from</label>
          <input
            type="number"
            id="shadow-min-depth"
            bind:value={shadowMinDepth}
            min="1"
            max="10"
            oninput={(e) => {
              const v = parseInt((e.target as HTMLInputElement).value)
              if (!isNaN(v)) shadowMinDepth = Math.max(1, Math.min(10, v))
            }}
          />
          <span class="shadow-depth-unit">{shadowMinDepth === 1 ? 'level' : 'levels'} deep</span>
        </div>
        <p class="help-text">
          e.g. <code>{examplePath}</code> — Folders at this depth or deeper that already exist in a
          higher-priority source will be skipped during rescan. Useful for SSD + HDD mirror setups.
        </p>
      {:else}
        <p class="help-text">
          When enabled, lower-priority sources skip folders already present in a higher-priority
          source, avoiding duplicate entries.
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .form-section {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
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

  .sources-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .source-entry {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    background-color: var(--color-background-mute);
    border: 1px solid var(--color-border);
    border-radius: 6px;
  }

  .source-entry.drag-placeholder {
    opacity: 0.25;
    pointer-events: none;
  }

  .source-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .drag-handle {
    color: var(--color-text-dim);
    font-size: 1.1rem;
    flex-shrink: 0;
    user-select: none;
  }

  .source-row input[type='text'] {
    flex: 1;
  }

  .remove-btn {
    flex-shrink: 0;
    padding: 0.4rem 0.6rem;
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-text-dim);
    cursor: pointer;
    font-size: 0.85rem;
    line-height: 1;
  }

  .remove-btn:hover {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }

  .add-source-btn {
    align-self: flex-start;
    padding: 0.4rem 0.9rem;
    background: none;
    border: 1px dashed var(--color-border);
    border-radius: 6px;
    color: var(--color-text-soft);
    cursor: pointer;
    font-size: 0.9rem;
  }

  .add-source-btn:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    cursor: pointer;
    font-size: 0.9rem;
  }

  input[type='text'] {
    padding: 0.75rem;
    background-color: var(--color-background-soft);
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

  .resolved-path {
    font-size: 0.8rem;
  }

  .path-warning {
    color: var(--color-primary);
    font-size: 0.8rem;
    font-weight: 500;
    margin-left: 0.4rem;
  }

  code {
    background-color: var(--color-background-soft);
    padding: 0.1rem 0.3rem;
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.9em;
  }

  .shadow-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    background-color: var(--color-background-mute);
    border: 1px solid var(--color-border);
    border-radius: 6px;
  }

  .shadow-depth {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .shadow-depth label {
    color: var(--color-text-soft);
  }

  .shadow-depth input[type='number'] {
    width: 3.5rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.9rem;
  }

  .shadow-depth-unit {
    color: var(--color-text-soft);
    font-size: 0.9rem;
  }
</style>
