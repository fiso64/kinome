<script lang="ts">
  import ModalWindow from './ModalWindow.svelte'

  let {
    item,
    onClose,
    onNeedRefresh
  }: {
    item: MediaFolder
    onClose: () => void
    onNeedRefresh: () => Promise<void>
  } = $props()

  let retrieveChildrenMetadata = $state(item.retrieve_children_metadata ?? false)
  let childrenTypeHint = $state(item.children_type_hint ?? 'auto')
  let processTvChildren = $state(item.process_tv_children ?? true)

  async function handleSave() {
    const wasEnabled = item.retrieve_children_metadata ?? false
    // Create a deep, plain JavaScript object copy to ensure it's clonable for IPC.
    const updatedItem: MediaFolder = JSON.parse(JSON.stringify(item))

    // Apply the changes
    updatedItem.retrieve_children_metadata = retrieveChildrenMetadata
    updatedItem.children_type_hint = childrenTypeHint === 'auto' ? undefined : childrenTypeHint
    updatedItem.process_tv_children = processTvChildren === true ? undefined : false

    await window.api.updateItem(updatedItem)
    onClose()

    // If the setting was just turned on, trigger a refresh to fetch metadata
    if (retrieveChildrenMetadata && !wasEnabled) {
      onNeedRefresh()
    }
  }

  async function handleClearMetadata() {
    const confirmed = confirm(
      `DANGER: This will save any changes made in this window and then permanently delete all fetched metadata (titles, posters, tags, etc.) for all items inside "${item.title ?? item.name}", recursively.\n\nThis action cannot be undone.\n\nAre you sure you want to proceed?`
    )
    if (confirmed) {
      // 1. Save current settings for the folder first by calling the existing update IPC.
      const updatedItem: MediaFolder = JSON.parse(JSON.stringify(item))
      updatedItem.retrieve_children_metadata = retrieveChildrenMetadata
      updatedItem.children_type_hint = childrenTypeHint === 'auto' ? undefined : childrenTypeHint
      updatedItem.process_tv_children = processTvChildren === true ? undefined : false
      await window.api.updateItem(updatedItem)

      // 2. Now, call the separate IPC to clear the metadata for all of its children.
      const success = await window.api.clearChildrenMetadata(item.id)
      if (success) {
        onClose()
        // await onNeedRefresh()
      } else {
        alert('Failed to clear metadata. See console for details.')
      }
    }
  }

  $effect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      } else if (event.key === 'Enter') {
        const target = event.target as HTMLElement
        if (target.tagName !== 'BUTTON') {
          event.preventDefault()
          handleSave()
        }
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  })
</script>

<ModalWindow title="Folder Settings" {onClose} onSave={handleSave}>
  <div class="content">
    <p class="help-text">Configure retriever settings for "{item.title ?? item.name}".</p>

    <div class="settings-group">
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={retrieveChildrenMetadata} />
        <span>This folder directly contains media items (e.g., movies or TV shows)</span>
      </label>
      <p class="help-text">
        Enable this to fetch movie or TV show metadata for direct children of this folder.
      </p>
    </div>

    <div class="settings-group" class:disabled={!retrieveChildrenMetadata}>
      <label for="children-type-hint">Children Type Hint</label>
      <select
        id="children-type-hint"
        bind:value={childrenTypeHint}
        disabled={!retrieveChildrenMetadata}
      >
        <option value="auto">Automatic Detection</option>
        <option value="movie">Movie</option>
        <option value="tv">TV Show</option>
      </select>
      <p class="help-text">Improves matching accuracy by telling the retriever what to look for.</p>
    </div>

    {#if item.mediaType === 'tv'}
      <div class="settings-group">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={processTvChildren} />
          <span>Enable TV show processing (seasons & episodes)</span>
        </label>
        <p class="help-text">
          If enabled, the app will analyze file/folder names to identify seasons and episodes, and
          fetch their specific metadata. Disable this for folders that contain TV shows but should
          be treated as simple folders.
        </p>
      </div>
    {/if}

    <div class="danger-zone">
      <div class="danger-zone-header">
        <h4>Danger Zone</h4>
      </div>
      <div>
        <button class="danger" onclick={handleClearMetadata}>
          Recursively Clear Children Metadata...
        </button>
        <p class="help-text danger-help-text">
          Removes all fetched data (titles, posters, tags, etc.) for every item inside this folder,
          recursively. This is useful for forcing a complete re-fetch from scratch.
        </p>
      </div>
    </div>
  </div>
</ModalWindow>

<style>
  .content {
    padding: 0 1.5rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .settings-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: opacity 0.2s ease-in-out;
  }
  .settings-group.disabled {
    opacity: 0.5;
    pointer-events: none;
  }
  .help-text {
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
  }
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 1rem;
    cursor: pointer;
    font-weight: bold;
  }
  .checkbox-label input {
    width: 1rem;
    height: 1rem;
  }
  label {
    font-weight: bold;
  }

  .danger-zone {
    border: 1px solid #c50f1f;
    border-radius: 6px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background-color: rgba(197, 15, 31, 0.1);
  }
  .danger-zone-header h4 {
    color: #ff7d7d;
    font-weight: bold;
    margin: 0;
  }
  .danger-help-text {
    margin-top: 0.5rem;
  }
  button.danger {
    background-color: #c50f1f;
    color: white;
    align-self: flex-start;
  }
  button.danger:hover:not(:disabled) {
    background-color: #a40e19;
  }
</style>
