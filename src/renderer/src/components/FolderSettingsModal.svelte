<script lang="ts">
  import ModalWindow from './ModalWindow.svelte'

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
</style>
