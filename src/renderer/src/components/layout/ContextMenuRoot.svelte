<script lang="ts">
  import ContextMenu from '../ui/ContextMenu.svelte'
  import { contextMenuStore } from '@lib/context-menu-store.svelte'
  import { authStore } from '@lib/auth-store.svelte'
  import { modalStore } from '@lib/modal-store.svelte'
  import type { WebQualityChoice } from '@shared/web-playback'
  import type { PlaybackQuality } from '@shared/playback-quality'
  import type { LibraryItem, MediaFile, PlayerCommandConfig, Settings } from '@shared/types'

  let { settings, actions, onItemClick, onOpenMatchingFile, onPlay } = $props<{
    settings: Settings | null
    actions: any
    onItemClick: (item: LibraryItem) => Promise<void>
    onOpenMatchingFile: (id: string) => void
    onPlay: (item: MediaFile, player?: PlayerCommandConfig, quality?: WebQualityChoice | PlaybackQuality) => void
  }>()

  const item = $derived(contextMenuStore.item)
  const isVisible = $derived(contextMenuStore.isVisible)
  const position = $derived(contextMenuStore.position)
  const layout = $derived(contextMenuStore.layout)
  const showLogout = $derived(contextMenuStore.showLogout)
</script>

{#if item && isVisible}
  <ContextMenu
    {item}
    {position}
    {layout}
    appOnly={contextMenuStore.appOnly}
    globalSettings={settings}
    matchingFiles={contextMenuStore.matchingFiles}
    {onOpenMatchingFile}
    {onPlay}
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
    onLogout={showLogout ? () => authStore.logout() : undefined}
    onShowShortcuts={showLogout ? () => modalStore.open('shortcuts', {}) : undefined}
    onRefreshLibrary={showLogout && authStore.can.triggerLibraryScan ? () => actions.rescan() : undefined}
  />
{/if}
