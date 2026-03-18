<script lang="ts">
  import ContextMenu from '../ui/ContextMenu.svelte'
  import { contextMenuStore } from '@lib/context-menu-store.svelte'
  import type { LibraryItem, Settings } from '@shared/types'

  let { settings, actions, onItemClick } = $props<{
    settings: Settings | null
    actions: any
    onItemClick: (item: LibraryItem) => Promise<void>
  }>()

  const item = $derived(contextMenuStore.item)
  const isVisible = $derived(contextMenuStore.isVisible)
  const position = $derived(contextMenuStore.position)
  const layout = $derived(contextMenuStore.layout)
</script>

{#if item && isVisible}
  <ContextMenu
    {item}
    {position}
    {layout}
    globalSettings={settings}
    onClose={() => contextMenuStore.close()}
    onOpen={() => onItemClick(item)}
    onEditMetadata={() => actions.editMetadata(item)}
    onSetLayout={() => actions.openViewSettings(item)}
    onOpenFolderSettings={() => actions.editMetadata(item, item.isVirtual ? 'virtualFolder' : 'folder')}
    onManualSearch={() => actions.manualSearch(item, 'match')}
    onEditArtwork={() => actions.manualSearch(item, 'artwork')}
    onRevealInExplorer={() => actions.revealInExplorer(item)}
    onDeleteItem={() => actions.trashItem(item)}
    onRenameItem={() => actions.renameItem(item)}
    onShowProperties={() => actions.showProperties(item)}
    onClearMetadata={() => actions.clearMetadata(item)}
    onHideItem={() => actions.hideItem(item)}
    onAssignSeasons={() => actions.assignSeasons(item)}
    onDeleteItemFromDb={() => actions.deleteFromDb(item)}
    onCreateVirtualFolder={() => actions.createVirtualFolder(item)}
  />
{/if}
