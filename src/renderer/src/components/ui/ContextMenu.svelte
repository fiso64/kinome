<script lang="ts">
  let {
    item,
    position,
    layout,
    onClose,
    onOpen,
    onEditMetadata,
    onSetLayout,
    onOpenFolderSettings,
    onOpenFileSettings,
    onManualSearch,
    onEditArtwork,
    onMarkAsUnwatched,
    onRevealInExplorer,
    onDeleteItem,
    onRenameItem,
    onShowProperties,
    onClearMetadata,
    onHideItem,
    onDeleteItemFromDb,
    onAssignSeasons
  }: {
    item: LibraryItem
    position: { top: number; left: number }
    layout?: string
    onClose: () => void
    onOpen: () => void
    onEditMetadata: () => void
    onSetLayout: () => void
    onOpenFolderSettings: () => void
    onOpenFileSettings: () => void
    onManualSearch: () => void
    onEditArtwork: () => void
    onMarkAsUnwatched: () => void
    onRevealInExplorer: () => void
    onDeleteItem: () => void
    onRenameItem: () => void
    onShowProperties: () => void
    onClearMetadata: () => void
    onHideItem: () => void
    onDeleteItemFromDb: () => void
    onAssignSeasons: () => void
  } = $props()

  let settings = $state<Settings | null>(null)
  $effect(() => {
    window.api.getSettings().then((s) => (settings = s))
  })

  const isVirtual = $derived((item as any).isVirtual === true)

  let menuElement = $state<HTMLDivElement>()
  let submenuElement = $state<HTMLDivElement>()
  let activeSubmenu = $state<string | null>(null)
  let submenuOnLeft = $state(false)
  let submenuTop = $state(0) // For vertical adjustment
  let style = $state('visibility: hidden;') // Start hidden to prevent flicker

  $effect(() => {
    if (menuElement) {
      const menuRect = menuElement.getBoundingClientRect()
      const { innerHeight: windowHeight, innerWidth: windowWidth } = window
      const margin = 5 // a small margin from the edge

      let top = position.top
      if (top + menuRect.height > windowHeight - margin) {
        top = windowHeight - menuRect.height - margin
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

  function handleOpenFileSettings() {
    onOpenFileSettings()
    onClose()
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

  function handleDeleteItemFromDb() {
    onDeleteItemFromDb()
    onClose()
  }

  function handleAssignSeasons() {
    onAssignSeasons()
    onClose()
  }

  function handlePlayWith(command: string) {
    // The item is guaranteed to be a file because of the #if block.
    // We must convert the Svelte proxy object to a plain JS object before sending over IPC.
    const plainItem = JSON.parse(JSON.stringify(item))
    window.api.playFileWith(plainItem as MediaFile, command)
    onClose()
  }

  function handleMarkAsUnwatched() {
    onMarkAsUnwatched()
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
</script>

<div
  class="context-menu-backdrop"
  onmousedown={onClose}
  oncontextmenu={(e) => {
    e.preventDefault()
    onClose()
  }}
>
  <div
    bind:this={menuElement}
    class="context-menu"
    {style}
    onmousedown={(e) => e.stopPropagation()}
    oncontextmenu={(e) => e.stopPropagation()}
  >
    {#if !isVirtual}
      {#if (layout === 'tree' || layout === 'tabs') && item.type === 'folder'}
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
      <button
        class="context-menu-item"
        onclick={handleManualSearch}
        onmouseenter={() => (activeSubmenu = null)}
      >
        <span class="icon">🔍</span>
        <span>Manual Search...</span>
      </button>
      <button
        class="context-menu-item"
        onclick={handleArtwork}
        onmouseenter={() => (activeSubmenu = null)}
      >
        <span class="icon">🖼️</span>
        <span>Artwork...</span>
      </button>
    {/if}

    {#if item.type === 'folder'}
      <!-- "Set View..." is applicable to both physical and virtual folders -->
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
      {#if !isVirtual}
        <!-- "Folder Settings..." is only for physical folders -->
        <button
          class="context-menu-item"
          onclick={handleFolderSettings}
          onmouseenter={() => (activeSubmenu = null)}
        >
          <span class="icon">⚙️</span>
          <span>Folder Settings...</span>
        </button>
      {/if}
    {/if}
    {#if item.type === 'file'}
      <button
        class="context-menu-item"
        onclick={handleOpenFileSettings}
        onmouseenter={() => (activeSubmenu = null)}
      >
        <span class="icon">⚙️</span>
        <span>File Settings...</span>
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
          <button class="context-menu-item" onclick={handleMarkAsUnwatched}>
            <span class="icon">👁️</span>
            <span>Mark as Unwatched</span>
          </button>
          {#if item.mediaType === 'tv' && !isVirtual}
            <button class="context-menu-item" onclick={handleAssignSeasons}>
              <span class="icon">🔢</span>
              <span>Assign Seasons & Episodes...</span>
            </button>
          {/if}
          <div class="separator"></div>
          <button class="context-menu-item danger" onclick={handleClearMetadata}>
            <span class="icon">🔥</span>
            <span>Clear Metadata...</span>
          </button>
          {#if !isVirtual}
            <button class="context-menu-item danger" onclick={handleHideItem}>
              <span class="icon">🚫</span>
              <span>Hide Item...</span>
            </button>
            {#if item.isMissing}
              <button class="context-menu-item danger" onclick={handleDeleteItemFromDb}>
                <span class="icon">🗑️</span>
                <span>Delete from Database...</span>
              </button>
            {/if}
          {/if}
        </div>
      {/if}
    </div>

    {#if item.type === 'file' && !isVirtual && !item.isMissing && settings?.playerCommands && settings.playerCommands.length > 0}
      <div
        class="submenu-container"
        onmouseenter={() => (activeSubmenu = 'play')}
        onmouseleave={() => (activeSubmenu = null)}
      >
        <button class="context-menu-item has-submenu" onclick={(e) => e.preventDefault()}>
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
            {#each settings.playerCommands as player}
              <button class="context-menu-item" onclick={() => handlePlayWith(player.command)}>
                <span>{player.name}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if !isVirtual && item.path}
      <div class="separator" onmouseenter={() => (activeSubmenu = null)}></div>
      <div
        class="submenu-container"
        onmouseenter={() => (activeSubmenu = 'file')}
        onmouseleave={() => (activeSubmenu = null)}
      >
        <button
          class="context-menu-item has-submenu"
          onclick={(e) => e.preventDefault()}
          disabled={item.isMissing}
        >
          <span class="icon">📄</span>
          <span>File</span>
          <span class="submenu-arrow">▸</span>
        </button>

        {#if activeSubmenu === 'file' && !item.isMissing}
          <div
            bind:this={submenuElement}
            class="context-menu submenu"
            class:on-left={submenuOnLeft}
            style="top: {submenuTop}px;"
            onclick={(e) => e.stopPropagation()}
          >
            <button class="context-menu-item" onclick={handleReveal}>
              <span class="icon">📁</span>
              <span>Show in Explorer</span>
            </button>
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
</div>

<style>
  .context-menu-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 999; /* Below menu, above everything else */
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
