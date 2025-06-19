<script lang="ts">
  let {
    item,
    position,
    isTreeView,
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
    onShowProperties
  }: {
    item: LibraryItem
    position: { top: number; left: number }
    isTreeView: boolean
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
  } = $props()

  let menuElement = $state<HTMLDivElement>()
  let submenuElement = $state<HTMLDivElement>()
  let submenuVisible = $state(false)
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
    if (submenuVisible && menuElement && submenuElement) {
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
    {#if isTreeView && item.type === 'folder'}
      <button
        class="context-menu-item"
        onclick={handleOpen}
        onmouseenter={() => (submenuVisible = false)}
      >
        Open
      </button>
    {/if}
    <button
      class="context-menu-item"
      onclick={handleEdit}
      onmouseenter={() => (submenuVisible = false)}
    >
      <span class="icon">✏️</span>
      <span>Edit Metadata</span>
    </button>
    <button
      class="context-menu-item"
      onclick={handleManualSearch}
      onmouseenter={() => (submenuVisible = false)}
    >
      <span class="icon">🔍</span>
      <span>Manual Search...</span>
    </button>
    <button
      class="context-menu-item"
      onclick={handleArtwork}
      onmouseenter={() => (submenuVisible = false)}
    >
      <span class="icon">🖼️</span>
      <span>Artwork...</span>
    </button>
    {#if item.type === 'folder'}
      <button
        class="context-menu-item"
        onclick={handleLayout}
        onmouseenter={() => (submenuVisible = false)}
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
      <button
        class="context-menu-item"
        onclick={handleFolderSettings}
        onmouseenter={() => (submenuVisible = false)}
      >
        <span class="icon">⚙️</span>
        <span>Folder Settings...</span>
      </button>
    {/if}
    {#if item.path}
      <div class="separator" onmouseenter={() => (submenuVisible = false)}></div>
      <div
        class="submenu-container"
        onmouseenter={() => (submenuVisible = true)}
        onmouseleave={() => (submenuVisible = false)}
      >
        <button class="context-menu-item has-submenu" onclick={(e) => e.preventDefault()}>
          <span class="icon">📄</span>
          <span>File</span>
          <span class="submenu-arrow">▸</span>
        </button>

        {#if submenuVisible}
          <div
            bind:this={submenuElement}
            class="context-menu submenu"
            class:on-left={submenuOnLeft}
            style="top: {submenuTop}px;"
            onclick={(e) => e.stopPropagation()}
          >
            <button class="context-menu-item" onclick={handleReveal}>
              <span class="icon">↗️</span>
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
