<script lang="ts">
  import { contextMenuStore } from '@lib/context-menu-store.svelte'
  import { api, getDownloadUrl } from '@lib/api'
  import { BUILTIN_WEB_PLAYER, resolveClientPlayers, resolvePlaybackQuality } from '@lib/services/player-launcher.service'
  import { clientSettingsStore } from '@lib/client-settings-store.svelte'
  import { itemCapabilities } from '@shared/item-capabilities'
  import { CONTAINER_LAYOUTS } from '@shared/types'
  import { availablePlaybackQualities, qualityLabel, type PlaybackQuality } from '@shared/playback-quality'
  import { webQualityChoices, webQualityLabel, type WebQualityChoice } from '@shared/web-playback'
  import type {
    LibraryItem,
    MediaFolder,
    MediaFile,
    SearchIndexEntry,
    Settings,
    PlayerCommandConfig
  } from '@shared/types'
  let {
    item,
    position,
    layout,
    globalSettings,
    matchingFiles,
    onOpenMatchingFile,
    onPlay,
    onClose,
    onOpen,
    onEditMetadata,
    onSetLayout,
    onOpenFolderSettings,
    onManualSearch,
    onEditArtwork,
    onRevealInExplorer,
    onDeleteItem,
    onRenameItem,
    onShowProperties,
    onClearMetadata,
    onHideItem,
    onDeleteItemFromDb,
    onAssignSeasons,
    onCreateVirtualFolder,
    onLogout
  }: {
    item: LibraryItem
    position: { top: number; left: number }
    layout?: string
    globalSettings: Settings | null
    matchingFiles?: SearchIndexEntry['matchingFiles']
    onOpenMatchingFile: (id: string) => void
    onPlay: (item: MediaFile, player?: PlayerCommandConfig, quality?: WebQualityChoice | PlaybackQuality) => void
    onClose: () => void
    onOpen: () => void
    onEditMetadata: () => void
    onSetLayout: () => void
    onOpenFolderSettings: () => void
    onManualSearch: () => void
    onEditArtwork: () => void
    onRevealInExplorer: () => void
    onDeleteItem: () => void
    onRenameItem: () => void
    onShowProperties: () => void
    onClearMetadata: () => void
    onHideItem: () => void
    onDeleteItemFromDb: () => void
    onAssignSeasons: () => void
    onCreateVirtualFolder: () => void
    onLogout?: () => void
  } = $props()

  const caps = $derived(itemCapabilities(item))
  const availablePlayers = $derived(
    resolveClientPlayers(
      globalSettings?.playerCommands ?? [],
      clientSettingsStore.settings.enabledPlayerIds
    )
  )

  let menuElement = $state<HTMLDivElement>()
  let submenuElement = $state<HTMLDivElement>()
  let activeSubmenu = $state<string | null>(null)
  const playbackQualities = $derived(availablePlaybackQualities(globalSettings))
  const defaultQuality = $derived(resolvePlaybackQuality(globalSettings))
  let workerNotice = $state('')
  let activePlayerQuality = $state<string | null>(null)
  let qualityMenu = $state<HTMLDivElement>()
  let qualityMenuPosition = $state('')

  $effect(() => {
    workerNotice = ''
    if (activeSubmenu !== 'play' || globalSettings?.playbackConversion === 'off') return
    let active = true
    api.getPlaybackWorkerHealth().then((health) => {
      if (active && health.status !== 'ready') workerNotice = health.detail
    }).catch(() => {
      if (active) workerNotice = 'Could not check the playback engine.'
    })
    return () => { active = false }
  })

  $effect(() => {
    if (!qualityMenu) return
    const parent = qualityMenu.parentElement!.getBoundingClientRect()
    const menu = qualityMenu.getBoundingClientRect()
    const left = parent.right + menu.width <= window.innerWidth ? parent.width - 1 : -menu.width + 1
    const top = Math.max(4, Math.min(parent.top - 4, window.innerHeight - menu.height - 4)) - parent.top
    qualityMenuPosition = `left: ${Math.max(4 - parent.left, left)}px; top: ${top}px;`
  })
  let submenuOnLeft = $state(false)
  let submenuTop = $state(0) // For vertical adjustment
  let style = $state('visibility: hidden;') // Start hidden to prevent flicker

  type WatchedState =
    | 'fully'
    | 'partially'
    | 'unwatched'
    | 'none'
    | 'file_watched'
    | 'file_unwatched'
  let watchedState: WatchedState = $state('none')

  $effect(() => {
    if (activeSubmenu !== 'actions') return

    const updateWatchedState = async () => {
      if (item.type === 'file') {
        watchedState = item.watched ? 'file_watched' : 'file_unwatched'
      } else {
        // We know it's a folder, but TS doesn't, so we cast.
        watchedState = await window.api.getFolderWatchedState((item as MediaFolder).id)
      }
    }
    updateWatchedState()
  })

  $effect(() => {
    // For file items, the menu content can change when `globalSettings` are loaded (e.g. "Play with...").
    // We must wait for globalSettings to be available before calculating the position to avoid a layout shift.
    if (menuElement && (item.type !== 'file' || globalSettings)) {
      const menuRect = menuElement.getBoundingClientRect()
      const { innerHeight: windowHeight, innerWidth: windowWidth } = window
      const margin = 5 // a small margin from the edge

      let top = position.top
      if (top + menuRect.height > windowHeight - margin) {
        // It overflows the bottom, so place it above the cursor
        top = position.top - menuRect.height
      }
      if (top < margin) top = margin

      let left = position.left
      if (left + menuRect.width > windowWidth - margin) {
        left = windowWidth - menuRect.width - margin
      }
      if (left < margin) left = margin

      style = `top: ${top}px; left: ${left}px; visibility: visible;`
    }
  })

  // This effect checks if the submenu would go off-screen and flips its position if needed.
  $effect(() => {
    if (activeSubmenu && menuElement && submenuElement) {
      const mainRect = menuElement.getBoundingClientRect()
      const subRect = submenuElement.getBoundingClientRect()
      const parentRect = submenuElement.parentElement!.getBoundingClientRect()
      const { innerWidth: windowWidth, innerHeight: windowHeight } = window
      const margin = 5

      // --- Horizontal Positioning ---
      // Check if there's enough space on the right. If not, flip it to the left.
      submenuOnLeft = mainRect.right + subRect.width > windowWidth

      // --- Vertical Positioning ---
      // Default top position (aligns with parent button, considering main menu's padding)
      const defaultTop = -5

      // Calculate where the bottom of the submenu would be in the viewport with default positioning
      const potentialBottom = parentRect.top + defaultTop + subRect.height

      if (potentialBottom > windowHeight - margin) {
        // It overflows. Align bottom of submenu with bottom of viewport.
        const newBottomInViewport = windowHeight - margin
        const newTopInViewport = newBottomInViewport - subRect.height
        // Convert the desired viewport 'top' to be relative to the submenu's parent container
        submenuTop = newTopInViewport - parentRect.top
      } else {
        // No overflow, use the default top position.
        submenuTop = defaultTop
      }
    }
  })

  function handleOpen() {
    onOpen()
    onClose()
  }

  function handleEdit() {
    onEditMetadata()
    onClose() // Also close the menu
  }

  function handleLayout() {
    onSetLayout()
    onClose() // Also close the menu
  }

  function handleFolderSettings() {
    onOpenFolderSettings()
    onClose() // Also close the menu
  }

  function handleManualSearch() {
    onManualSearch()
    onClose()
  }

  function handleArtwork() {
    onEditArtwork()
    onClose()
  }

  function handleClearMetadata() {
    onClearMetadata()
    onClose()
  }

  function handleHideItem() {
    onHideItem()
    onClose()
  }

  function handleDownload() {
    if (item.id) {
      const url = getDownloadUrl(item.id)
      // Use a hidden anchor tag to trigger a real download instead of just opening a tab
      const a = document.createElement('a')
      a.href = url
      a.download = '' // Let the server headers decide the filename
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
    onClose()
  }

  function handleDeleteItemFromDb() {
    onDeleteItemFromDb()
    onClose()
  }

  function handleAssignSeasons() {
    onAssignSeasons()
    onClose()
  }

  function handleCreateVirtualFolder() {
    onCreateVirtualFolder()
    onClose()
  }


  function handlePlayWith(player: PlayerCommandConfig, quality?: WebQualityChoice | PlaybackQuality) {
    onPlay(item as MediaFile, player, quality)
    onClose()
  }

  function handleMarkAsWatched() {
    window.api.markAsWatched(item.id)
    onClose()
  }

  function handleMarkAsUnwatched() {
    window.api.markAsUnwatched(item.id)
    onClose()
  }

  function handleCustomAction(commandId: string) {
    window.api.executeCustomAction(item.id, commandId)
    onClose()
  }

  function handleReveal() {
    onRevealInExplorer()
    onClose()
  }

  function handleDelete() {
    onDeleteItem()
    onClose()
  }

  function handleRename() {
    onRenameItem()
    onClose()
  }

  function handleShowProperties() {
    onShowProperties()
    onClose()
  }

  $effect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    // Listen for the Escape key to close the menu.
    // This is the only global listener we need, as the backdrop handles all click-away cases.
    window.addEventListener('keydown', handleKeyDown, { capture: true })

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  })

  $effect(() => {
    const handleGlobalMouseDown = (e: MouseEvent) => {
      if (menuElement && !menuElement.contains(e.target as Node)) {
        // Close on left-click outside
        if (e.button === 0) onClose()
      }
    }

    const handleGlobalContextMenu = (e: MouseEvent) => {
      if (menuElement && menuElement.contains(e.target as Node)) {
        return // Allow events within the menu
      }

      // Check if this is a second click at the same location to show native menu
      const dx = Math.abs(e.clientX - contextMenuStore.lastClick.x)
      const dy = Math.abs(e.clientY - contextMenuStore.lastClick.y)
      const dt = e.timeStamp - contextMenuStore.lastClick.time

      if (dx < 10 && dy < 10 && dt < 2000) {
        onClose()
        return // Allow native browser menu by not calling preventDefault
      }

      // Clicked elsewhere - close existing and allow event to propagate to new items
      onClose()
    }

    window.addEventListener('mousedown', handleGlobalMouseDown, { capture: true })
    window.addEventListener('contextmenu', handleGlobalContextMenu, { capture: true })

    return () => {
      window.removeEventListener('mousedown', handleGlobalMouseDown, { capture: true })
      window.removeEventListener('contextmenu', handleGlobalContextMenu, { capture: true })
    }
  })
</script>

<div
  bind:this={menuElement}
  class="context-menu"
  {style}
  onmousedown={(e) => e.stopPropagation()}
  oncontextmenu={(e) => e.stopPropagation()}
>
  {#if onLogout}
    <button
      class="context-menu-item"
      onclick={() => { onLogout!(); onClose() }}
      onmouseenter={() => (activeSubmenu = null)}
    >
      <span>Log Out</span>
    </button>
    <div class="separator"></div>
  {/if}
  {#if matchingFiles?.length}
    <div
      class="submenu-container"
      onmouseenter={() => (activeSubmenu = 'matches')}
      onmouseleave={() => (activeSubmenu = null)}
    >
      <button class="context-menu-item has-submenu" onclick={() => (activeSubmenu = 'matches')}>
        <span>Matching files ({matchingFiles.length})</span>
        <span class="submenu-arrow">▸</span>
      </button>
      {#if activeSubmenu === 'matches'}
        <div
          bind:this={submenuElement}
          class="context-menu submenu matching-files"
          class:on-left={submenuOnLeft}
          style="top: {submenuTop}px;"
        >
          {#each matchingFiles as file (file.id)}
            <button class="context-menu-item" onclick={() => { onClose(); onOpenMatchingFile(file.id) }}>
              {file.title}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="separator"></div>
  {/if}
  {#if caps.canPlay && availablePlayers.length > 0}
    <div
      class="submenu-container"
      onmouseenter={() => (activeSubmenu = 'play')}
      onmouseleave={() => { activeSubmenu = null; activePlayerQuality = null }}
    >
      <button class="context-menu-item has-submenu" aria-expanded={activeSubmenu === 'play'} onclick={() => (activeSubmenu = 'play')}>
        <span class="icon">▶️</span>
        <span>Play with...</span>
        <span class="submenu-arrow">▸</span>
      </button>

      {#if activeSubmenu === 'play'}
        <div
          bind:this={submenuElement}
          class="context-menu submenu"
          class:on-left={submenuOnLeft}
          style="top: {submenuTop}px;"
          onclick={(e) => e.stopPropagation()}
        >
          {#each availablePlayers as player (player.id)}
            <div class="player-row">
              <button class="context-menu-item player-action" onclick={() => handlePlayWith(player)}>
                {player.name}
              </button>
              <button
                class="context-menu-item quality-arrow"
                aria-label={`Quality for ${player.name}`}
                title="Playback quality"
                aria-expanded={activePlayerQuality === player.id}
                onclick={() => (activePlayerQuality = activePlayerQuality === player.id ? null : player.id)}
              >▸</button>
              {#if activePlayerQuality === player.id}
                {@const isWeb = player.id === BUILTIN_WEB_PLAYER.id}
                <div class="context-menu submenu quality-menu" bind:this={qualityMenu} style={qualityMenuPosition}>
                  {#if isWeb}
                    {#each webQualityChoices as quality (quality)}
                      <button class="context-menu-item" aria-current={quality === clientSettingsStore.settings.webQuality}
                        onclick={() => handlePlayWith(player, quality)}>{webQualityLabel(quality)}</button>
                    {/each}
                  {:else}
                    {#each playbackQualities as quality (quality)}
                      <button class="context-menu-item" aria-current={quality === defaultQuality}
                        onclick={() => handlePlayWith(player, quality)}>{qualityLabel(quality)}</button>
                    {/each}
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
          {#if workerNotice}
            <div class="worker-notice" role="status">{workerNotice} Original playback is available.</div>
          {/if}
        </div>
      {/if}
    </div>
    <div class="separator"></div>
  {/if}
  {#if (layout === 'tree' || (layout && CONTAINER_LAYOUTS.includes(layout as any))) && item.type === 'folder'}
    <button
      class="context-menu-item"
      onclick={handleOpen}
      onmouseenter={() => (activeSubmenu = null)}
    >
      Open
    </button>
  {/if}
  <button
    class="context-menu-item"
    onclick={handleEdit}
    onmouseenter={() => (activeSubmenu = null)}
  >
    <span class="icon">✏️</span>
    <span>Edit Metadata</span>
  </button>
  {#if caps.canManualSearch}
    <button
      class="context-menu-item"
      onclick={handleManualSearch}
      onmouseenter={() => (activeSubmenu = null)}
    >
      <span class="icon">🔍</span>
      <span>Manual Search...</span>
    </button>
  {/if}
  <button
    class="context-menu-item"
    onclick={handleArtwork}
    onmouseenter={() => (activeSubmenu = null)}
  >
    <span class="icon">🖼️</span>
    <span>Artwork...</span>
  </button>

  {#if caps.canEditView}
    <button
      class="context-menu-item"
      onclick={handleLayout}
      onmouseenter={() => (activeSubmenu = null)}
    >
      <span class="icon">
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
          ></rect>
          <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
          ></rect>
          <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
          ></rect>
          <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
          ></rect>
        </svg>
      </span>
      <span>Set View...</span>
    </button>
  {/if}
  {#if caps.canEditFolderSettings || caps.canEditVirtualFolder}
    <button
      class="context-menu-item"
      onclick={handleFolderSettings}
      onmouseenter={() => (activeSubmenu = null)}
    >
      <span class="icon">⚙️</span>
      <span>Folder Settings...</span>
    </button>
  {/if}
  <div
    class="submenu-container"
    onmouseenter={() => (activeSubmenu = 'actions')}
    onmouseleave={() => (activeSubmenu = null)}
  >
    <button class="context-menu-item has-submenu" onclick={(e) => e.preventDefault()}>
      <span class="icon">⚡️</span>
      <span>Actions</span>
      <span class="submenu-arrow">▸</span>
    </button>

    {#if activeSubmenu === 'actions'}
      <div
        bind:this={submenuElement}
        class="context-menu submenu"
        class:on-left={submenuOnLeft}
        style="top: {submenuTop}px;"
        onclick={(e) => e.stopPropagation()}
      >
        {#if ['file_unwatched', 'unwatched', 'partially'].includes(watchedState)}
          <button class="context-menu-item" onclick={handleMarkAsWatched}>
            <span class="icon">👓</span>
            <span>Mark as Watched</span>
          </button>
        {/if}
        {#if ['file_watched', 'fully', 'partially'].includes(watchedState)}
          <button class="context-menu-item" onclick={handleMarkAsUnwatched}>
            <span class="icon">🕶️</span>
            <span>Mark as Unwatched</span>
          </button>
        {/if}
        {#if caps.canAssignSeasons}
          <button class="context-menu-item" onclick={handleAssignSeasons}>
            <span class="icon">🔢</span>
            <span>Assign Seasons & Episodes...</span>
          </button>
        {/if}
        {#if caps.canCreateVirtualFolder}
          <button class="context-menu-item" onclick={handleCreateVirtualFolder}>
            <span class="icon">📂</span>
            <span>Create Virtual Folder...</span>
          </button>
        {/if}
        <div class="separator"></div>
        <button class="context-menu-item danger" onclick={handleClearMetadata}>
          <span class="icon">🔥</span>
          <span>Clear Metadata...</span>
        </button>
        {#if caps.canHide}
          <button class="context-menu-item danger" onclick={handleHideItem}>
            <span class="icon">🚫</span>
            <span>Hide Item...</span>
          </button>
        {/if}
        {#if caps.canDelete}
          <button class="context-menu-item danger" onclick={handleDeleteItemFromDb}>
            <span class="icon">🗑️</span>
            <span>Delete from Database...</span>
          </button>
        {/if}
      </div>
    {/if}
  </div>

  {#if caps.canCustomActions && item.path && globalSettings?.customActions && globalSettings.customActions.length > 0}
    <div class="separator" onmouseenter={() => (activeSubmenu = null)}></div>
    <div
      class="submenu-container"
      onmouseenter={() => (activeSubmenu = 'custom')}
      onmouseleave={() => (activeSubmenu = null)}
    >
      <button class="context-menu-item has-submenu" onclick={(e) => e.preventDefault()}>
        <span class="icon">🛠️</span>
        <span>Custom Actions</span>
        <span class="submenu-arrow">▸</span>
      </button>

      {#if activeSubmenu === 'custom'}
        <div
          bind:this={submenuElement}
          class="context-menu submenu"
          class:on-left={submenuOnLeft}
          style="top: {submenuTop}px;"
          onclick={(e) => e.stopPropagation()}
        >
          {#each globalSettings.customActions as action (action.id)}
            <button class="context-menu-item" onclick={() => handleCustomAction(action.id)}>
              <span>{action.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if caps.canFilesystemOps}
    <div class="separator" onmouseenter={() => (activeSubmenu = null)}></div>
    <div
      class="submenu-container"
      onmouseenter={() => (activeSubmenu = 'file')}
      onmouseleave={() => (activeSubmenu = null)}
    >
      <button
        class="context-menu-item has-submenu"
        onclick={(e) => e.preventDefault()}
      >
        <span class="icon">📄</span>
        <span>File</span>
        <span class="submenu-arrow">▸</span>
      </button>

      {#if activeSubmenu === 'file'}
        <div
          bind:this={submenuElement}
          class="context-menu submenu"
          class:on-left={submenuOnLeft}
          style="top: {submenuTop}px;"
          onclick={(e) => e.stopPropagation()}
        >
          {#if window.api.capabilities.supportsLocalPlayback}
            <button class="context-menu-item" onclick={handleReveal}>
              <span class="icon">📁</span>
              <span>Show in Explorer</span>
            </button>
          {/if}
          {#if caps.canDownload}
            <button class="context-menu-item" onclick={handleDownload}>
              <span class="icon">⬇️</span>
              <span>Download</span>
            </button>
          {/if}
          <button class="context-menu-item" onclick={handleRename}>
            <span class="icon">✏️</span>
            <span>Rename...</span>
          </button>
          <button class="context-menu-item" onclick={handleShowProperties}>
            <span class="icon">ℹ️</span>
            <span>Properties...</span>
          </button>
          <div class="separator"></div>
          <button class="context-menu-item danger" onclick={handleDelete}>
            <span class="icon">🗑️</span>
            <span>Move to Trash...</span>
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .matching-files {
    max-height: min(24rem, 80vh);
    overflow-y: auto;
  }

  .context-menu {
    position: fixed; /* Position relative to the viewport */
    background-color: var(--ev-c-black-soft);
    border: 1px solid var(--ev-c-black-mute);
    border-radius: 6px;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
    z-index: 1000; /* Ensure it's on top of everything */
    width: max-content;
    overflow: visible; /* Allow submenu to overflow */
    padding: 0.25rem;
    animation: fadeIn 0.15s ease-out;
  }

  .context-menu-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 1.25rem;
    background: none;
    border: none;
    color: var(--color-text);
    text-align: left;
    cursor: pointer;
    font-size: 0.9rem;
    border-radius: 4px;
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.2em;
    font-size: 1.1em;
  }

  .context-menu-item:hover {
    background-color: var(--ev-c-gray-2);
  }

  .separator {
    height: 1px;
    background-color: var(--ev-c-black-mute);
    margin: 0.25rem 0.5rem;
  }

  .context-menu-item.danger:hover {
    background-color: #c50f1f;
    color: var(--ev-c-white);
  }

  .context-menu-item.has-submenu .submenu-arrow {
    margin-left: auto;
    font-size: 0.8em;
    color: var(--ev-c-text-2);
  }

  .submenu {
    position: absolute;
    left: 100%;
    margin-left: -1px;
    animation: fadeIn 0.1s ease-out;
  }

  .player-row {
    display: flex;
    position: relative;
  }

  .worker-notice {
    border-top: 1px solid var(--color-border);
    color: var(--color-text-dim);
    font-size: 0.85rem;
    max-width: 17rem;
    padding: 0.5rem 0.75rem;
  }

  .player-action {
    flex: 1;
    white-space: nowrap;
  }

  .quality-arrow {
    width: auto;
    flex-shrink: 0;
    padding-inline: 0.65rem;
    color: var(--ev-c-text-2);
  }

  .quality-menu {
    max-height: calc(100vh - 8px);
    overflow-y: auto;
  }

  .submenu-container {
    position: relative;
  }

  .submenu.on-left {
    left: auto;
    right: 100%;
    margin-left: 0;
    margin-right: -1px;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
