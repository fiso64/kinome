<script lang="ts">
  import ContextMenu from '../ui/ContextMenu.svelte'
  import { contextMenuStore } from '../../lib/context-menu-store.svelte'
  import { modalStore } from '../../lib/modal-store.svelte'
  import { dialogStore } from '../../lib/dialog-store'
  import { api } from '../../lib/api'
  import { resolveViewSettings } from '../../../../shared/settings-helpers'
  import type { LibraryItem, MediaFolder, Settings } from '../../../../shared/types'

  let { settings, onRefresh, onItemClick } = $props<{
    settings: Settings | null
    onRefresh: () => Promise<void>
    onItemClick: (item: LibraryItem) => Promise<void>
  }>()

  const item = $derived(contextMenuStore.item)
  const isVisible = $derived(contextMenuStore.isVisible)
  const position = $derived(contextMenuStore.position)
  const layout = $derived(contextMenuStore.layout)

  const handleRevealItem = (itemToReveal: LibraryItem) => {
    if (!itemToReveal.path) return
    api.revealInExplorer(itemToReveal.path)
  }

  async function handleDeleteItem(itemToDelete: LibraryItem) {
    if (!itemToDelete.path) return

    const confirmed = await dialogStore.showConfirmation({
      title: 'Confirm Deletion',
      message: `Are you sure you want to move "${itemToDelete.title ?? itemToDelete.name}" to the trash?`,
      detail: 'This action cannot be undone from within the app.',
      confirmText: 'Move to Trash',
      cancelText: 'Cancel',
      confirmClass: 'danger'
    })

    if (!confirmed) return

    const success = await api.trashItem(itemToDelete.path)
    if (success) {
      await onRefresh()
    }
  }

  async function handleClearItemMetadata(itemToClear: LibraryItem) {
    const isFolder = itemToClear.type === 'folder'
    const isVirtual = itemToClear.path.startsWith('virtual://')
    const message = isVirtual
      ? `This will permanently delete all metadata (including custom titles, posters, and tags) for all items currently shown in the virtual folder "${itemToClear.title ?? itemToClear.name}".`
      : `This will permanently delete all metadata (including custom titles, posters, and tags) for this item${isFolder ? ', and all its children recursively' : ''}.`

    if (isFolder && !isVirtual) {
      const result = await dialogStore.showConfirmationWithCheckbox({
        title: 'Confirm Metadata Clearing',
        message,
        detail: 'This action cannot be undone.',
        confirmText: 'Clear Metadata',
        cancelText: 'Cancel',
        confirmClass: 'danger',
        checkbox: {
          label: 'Preserve metadata for this item, only clear for its children.',
          checked: false
        }
      })
      if (result.confirmed) {
        await api.clearItemMetadata(itemToClear.id, result.checkboxValue)
      }
    } else {
      const confirmed = await dialogStore.showConfirmation({
        title: 'Confirm Metadata Clearing',
        message,
        detail: 'This action cannot be undone.',
        confirmText: 'Clear Metadata',
        cancelText: 'Cancel',
        confirmClass: 'danger'
      })

      if (!confirmed) return

      if (isVirtual && itemToClear.type === 'folder') {
        const childIds = itemToClear.children.map((c) => c.id)
        await api.clearVirtualFolderMetadata(childIds)
      } else {
        await api.clearItemMetadata(itemToClear.id, false)
      }
    }
  }

  async function handleHideItemFromContext(itemToHide: LibraryItem) {
    const confirmed = await dialogStore.showConfirmation({
      title: 'Confirm Hide',
      message: `Are you sure you want to hide "${itemToHide.title ?? itemToHide.name}"?`,
      detail: "This is not a deletion. It can be unhidden from its parent folder's settings.",
      confirmText: 'Hide Item',
      cancelText: 'Cancel'
    })

    if (confirmed) {
      const itemToUpdate = { ...JSON.parse(JSON.stringify(itemToHide)), isHidden: true }
      await api.userUpdateItem(itemToUpdate)
    }
  }

  async function handleDeleteItemFromDb(itemToDelete: LibraryItem) {
    const confirmed = await dialogStore.showConfirmation({
      title: 'Confirm Database Deletion',
      message: `Are you sure you want to permanently delete the record for "${
        itemToDelete.title ?? itemToDelete.name
      }" from the database?`,
      detail:
        'This only affects the library database, not the file on disk. This action cannot be undone.',
      confirmText: 'Delete Record',
      cancelText: 'Cancel',
      confirmClass: 'danger'
    })
    if (confirmed) {
      await api.deleteItemFromDb(itemToDelete.id)
    }
  }
</script>

{#if item && isVisible}
  <ContextMenu
    {item}
    {position}
    {layout}
    onClose={() => contextMenuStore.close()}
    onOpen={() => onItemClick(item)}
    onEditMetadata={() => {
      const resolvedSettings = resolveViewSettings(item as MediaFolder, settings).settings
      modalStore.open('itemSettings', {
        item: item,
        initialTab: 'metadata',
        defaultLayout: resolvedSettings.layout
      })
    }}
    onSetLayout={() => {
      if (item.type === 'folder') {
        const resolvedSettings = resolveViewSettings(item as MediaFolder, settings).settings
        modalStore.open('itemSettings', {
          item: item as MediaFolder,
          initialTab: 'view',
          defaultLayout: resolvedSettings.layout
        })
      }
    }}
    onOpenFolderSettings={() => {
      if (item.type === 'folder') {
        const resolvedSettings = resolveViewSettings(item as MediaFolder, settings).settings
        modalStore.open('itemSettings', {
          item: item as MediaFolder,
          initialTab: 'folder',
          defaultLayout: resolvedSettings.layout
        })
      }
    }}
    onOpenFileSettings={() => {
      modalStore.open('itemSettings', {
        item: item,
        initialTab: 'settings',
        defaultLayout: 'grid'
      })
    }}
    onManualSearch={() => {
      modalStore.open('manualSearch', {
        item: item,
        initialTab: 'match'
      })
    }}
    onEditArtwork={() => {
      modalStore.open('manualSearch', {
        item: item,
        initialTab: 'artwork'
      })
    }}
    onRevealInExplorer={() => handleRevealItem(item)}
    onDeleteItem={() => handleDeleteItem(item)}
    onRenameItem={() => modalStore.open('rename', { item })}
    onShowProperties={() => modalStore.open('properties', { item })}
    onClearMetadata={() => handleClearItemMetadata(item)}
    onHideItem={() => handleHideItemFromContext(item)}
    onAssignSeasons={() => {
      if (item.type === 'folder') {
        modalStore.open('assignSeasons', { item: item as MediaFolder })
      }
    }}
    onDeleteItemFromDb={() => handleDeleteItemFromDb(item)}
  />
{/if}
