<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import type { LibraryItem } from '@shared/types'
  import { notificationStore } from '@lib/notification-store.svelte'

  let {
    item,
    onClose,
    onNeedRefresh
  }: {
    item: LibraryItem
    onClose: () => void
    onNeedRefresh: () => Promise<void>
  } = $props()

  let newName = $state(item.name)
  let inputElement = $state<HTMLInputElement | undefined>(undefined)

  async function handleSave() {
    if (newName && newName.trim() !== '' && newName !== item.name) {
      try {
        const success = await window.api.renameItem(item.id, newName)
        if (success) {
          onClose()
          await onNeedRefresh()
        } else {
          notificationStore.add('Rename failed. The file may be in use or the name is invalid.', 'error')
        }
      } catch (err: any) {
        notificationStore.add(err.message || 'Failed to rename item.', 'error')
      }
    } else {
      onClose() // Close even if name hasn't changed
    }
  }

  $effect(() => {
    if (inputElement) {
      inputElement.focus()
      inputElement.select()
    }
  })
</script>

<ModalWindow title="Rename Item" {onClose} onSave={handleSave}>
  <div class="content">
    <div class="form-group">
      <label for="item-name">New name for "{item.name}"</label>
      <input type="text" id="item-name" bind:value={newName} bind:this={inputElement} />
    </div>
  </div>
</ModalWindow>

<style>
  .content {
    padding: 1.5rem;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  label {
    font-weight: bold;
  }
</style>
