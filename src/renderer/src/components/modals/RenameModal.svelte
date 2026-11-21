<script lang="ts">
  import Icon from '@components/ui/Icon.svelte'
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

<ModalWindow title="Rename item" {onClose} onSave={handleSave} saveText="Rename" maxWidth="480px">
  <div class="form-stack">
    <div class="current-name raised-surface">
      <Icon name={item.type === 'folder' ? 'folder' : 'file'} size={18} />
      <span>{item.name}</span>
    </div>
    <div class="form-field">
      <label for="item-name">New name</label>
      <input type="text" id="item-name" bind:value={newName} bind:this={inputElement} />
    </div>
  </div>
</ModalWindow>

<style>
  .current-name {
    display: flex;
    align-items: center;
    gap: .65rem;
    min-width: 0;
    padding: .55rem .7rem;
    color: var(--color-text-soft);
    font-size: .85rem;
    overflow-wrap: anywhere;
  }

  .current-name :global(svg) { flex: none; color: var(--color-primary-soft); }
</style>
