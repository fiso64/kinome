<script lang="ts">
  let {
    item,
    onClose
  }: {
    item: MediaFolder
    onClose: () => void
  } = $props()

  let retrieveChildrenMetadata = $state(item.retrieve_children_metadata ?? false)
  let childrenTypeHint = $state(item.children_type_hint ?? 'auto')

  async function handleSave() {
    // Create a deep, plain JavaScript object copy to ensure it's clonable for IPC.
    const updatedItem: MediaFolder = JSON.parse(JSON.stringify(item))

    // Apply the changes
    updatedItem.retrieve_children_metadata = retrieveChildrenMetadata
    updatedItem.children_type_hint = childrenTypeHint === 'auto' ? undefined : childrenTypeHint

    await window.api.updateItem(updatedItem)
    onClose()
  }

  $effect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
<div
  class="modal-backdrop"
  onclick={(e) => e.target === e.currentTarget && onClose()}
  role="dialog"
  aria-modal="true"
  tabindex="-1"
>
  <div class="modal-content">
    <h2>Folder Settings</h2>
    <p class="help-text">Configure retriever settings for "{item.title ?? item.name}".</p>

    <div class="settings-group">
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={retrieveChildrenMetadata} />
        <span>Fetch metadata for direct children</span>
      </label>
      <p class="help-text">
        If checked, the scanner will try to find metadata (posters, details) for files and folders
        directly inside this one.
      </p>
    </div>

    <div class="settings-group">
      <label for="children-type-hint">Children Type Hint</label>
      <select id="children-type-hint" bind:value={childrenTypeHint}>
        <option value="auto">Automatic Detection</option>
        <option value="movie">Movie</option>
        <option value="tv">TV Show</option>
      </select>
      <p class="help-text">Improves matching accuracy by telling the retriever what to look for.</p>
    </div>

    <div class="actions">
      <button onclick={handleSave}>Save & Close</button>
      <button class="secondary" onclick={onClose}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 200;
  }
  .modal-content {
    background-color: var(--color-background-soft);
    padding: 2rem;
    border-radius: 8px;
    width: 90%;
    max-width: 500px;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .settings-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
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
  select {
    padding: 0.5rem;
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    color: var(--color-text);
    border-radius: 4px;
    font-family: inherit;
    font-size: 1rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    flex-shrink: 0;
    padding-top: 1rem;
    border-top: 1px solid var(--color-background-mute);
    margin-top: auto;
  }
  button {
    background-color: var(--ev-c-gray-3);
    color: var(--ev-c-text-1);
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 5px;
    cursor: pointer;
    font-weight: 600;
  }
  button:hover {
    background-color: var(--ev-c-gray-2);
  }
  button.secondary {
    background-color: var(--ev-button-alt-bg);
    border: 1px solid var(--ev-button-alt-border);
  }
  button.secondary:hover {
    background-color: var(--ev-button-alt-hover-bg);
  }
</style>
