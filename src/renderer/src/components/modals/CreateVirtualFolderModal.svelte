<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import VirtualFolderTab from './_parts/item-settings/VirtualFolderTab.svelte'
  import type { LibraryItem, LibraryFilter, AutocompleteSuggestions } from '@shared/types'
  import { dialogStore } from '@lib/dialog-store'

  let {
    parentItem,
    onClose,
    onCreated
  }: {
    parentItem: LibraryItem
    onClose: () => void
    onCreated: (newId: string) => void
  } = $props()

  let name = $state('')
  let filter = $state<LibraryFilter>({
    scope: { parentId: parentItem.id },
    conditionGroups: []
  })

  let nameInput = $state<HTMLInputElement | undefined>(undefined)
  let suggestions = $state<AutocompleteSuggestions | undefined>(undefined)

  $effect(() => {
    if (nameInput) {
      nameInput.focus()
    }
  })

  window.api.getAutocompleteSuggestions().then((s) => (suggestions = s)).catch(() => {})

  async function handleCreate() {
    if (!name.trim()) return

    try {
      const result = await window.api.createVirtualFolder(parentItem.id, name.trim(), filter)
      if (result?.id) {
        onCreated(result.id)
      }
    } catch (err: any) {
      dialogStore.showError({ title: 'Error Creating Folder', message: err.message || 'Failed to create virtual folder.' })
    }
  }
</script>

<ModalWindow title="Create Virtual Folder" {onClose} onSave={handleCreate} saveText="Create">
  <div class="content">
    <div class="form-group">
      <label for="vf-name">Name</label>
      <input
        type="text"
        id="vf-name"
        bind:value={name}
        bind:this={nameInput}
        placeholder="My Virtual Folder"
      />
    </div>

    <VirtualFolderTab bind:filter parentId={parentItem.id} {suggestions} />
  </div>
</ModalWindow>

<style>
  .content {
    display: flex;
    flex-direction: column;
  }
  .form-group {
    padding: 1.5rem 1.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  label {
    font-weight: bold;
    font-size: 0.9rem;
  }
</style>
