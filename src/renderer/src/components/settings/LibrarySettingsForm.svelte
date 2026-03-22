<script lang="ts">
  import { api } from '@lib/api'
  import type { MediaSource } from '@shared/types'

  let {
    mediaSources = $bindable(),
    libraryLocation = $bindable()
  }: {
    mediaSources: MediaSource[]
    libraryLocation: string
  } = $props()

  let resolvedPaths = $state<Record<string, { path: string; exists: boolean }>>({})
  let draggedIndex = $state<number | null>(null)
  let dragOverIndex = $state<number | null>(null)

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

  function handleDragStart(e: DragEvent, index: number) {
    draggedIndex = index
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  function handleDragOver(e: DragEvent, index: number) {
    e.preventDefault()
    if (draggedIndex !== null && index !== draggedIndex) dragOverIndex = index
  }

  function handleDrop(e: DragEvent, dropIndex: number) {
    e.preventDefault()
    if (draggedIndex === null || draggedIndex === dropIndex) {
      dragOverIndex = null
      return
    }
    const items = [...mediaSources]
    items.splice(dropIndex, 0, items.splice(draggedIndex, 1)[0])
    mediaSources = items
    draggedIndex = null
    dragOverIndex = null
  }

  function handleDragEnd() {
    draggedIndex = null
    dragOverIndex = null
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
        class:drag-over={dragOverIndex === i}
        draggable="true"
        ondragstart={(e) => handleDragStart(e, i)}
        ondragover={(e) => handleDragOver(e, i)}
        ondragenter={(e) => e.preventDefault()}
        ondrop={(e) => handleDrop(e, i)}
        ondragend={handleDragEnd}
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
            >✕</button>
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
    cursor: grab;
  }

  .source-entry:active {
    cursor: grabbing;
  }

  .source-entry.drag-over {
    border-color: var(--color-primary);
    background-color: color-mix(in srgb, var(--color-primary) 8%, var(--color-background-mute));
  }

  .source-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .drag-handle {
    color: var(--color-text-dim);
    font-size: 1.1rem;
    cursor: grab;
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
</style>
