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
    onManualSearch
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
  } = $props()

  let menuElement = $state<HTMLDivElement>()
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

  $effect(() => {
    // This effect adds global listeners to close the menu
    // when the user clicks or right-clicks anywhere *outside* of it.
    const close = () => onClose()

    // Use a timeout to ensure these listeners are added *after* the
    // event that triggered the menu to open has completed.
    setTimeout(() => {
      // These are regular bubble-phase listeners.
      window.addEventListener('click', close, { once: true })
      window.addEventListener('contextmenu', close, { once: true })
    }, 0)

    return () => {
      // Cleanup the listeners when the component is destroyed.
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
    }
  })
</script>

<div bind:this={menuElement} class="context-menu" {style} onclick={(e) => e.stopPropagation()}>
  {#if isTreeView && item.type === 'folder'}
    <button class="context-menu-item" onclick={handleOpen}> Open </button>
  {/if}
  <button class="context-menu-item" onclick={handleEdit}>
    <span class="icon">✏️</span>
    <span>Edit Metadata</span>
  </button>
  <button class="context-menu-item" onclick={handleManualSearch}>
    <span class="icon">🔍</span>
    <span>Manual Search...</span>
  </button>
  {#if item.type === 'folder'}
    <button class="context-menu-item" onclick={handleLayout}>
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
    <button class="context-menu-item" onclick={handleFolderSettings}>
      <span class="icon">⚙️</span>
      <span>Folder Settings...</span>
    </button>
  {/if}
</div>

<style>
  .context-menu {
    position: fixed; /* Position relative to the viewport */
    background-color: var(--ev-c-black-soft);
    border: 1px solid var(--ev-c-black-mute);
    border-radius: 6px;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
    z-index: 1000; /* Ensure it's on top of everything */
    width: max-content;
    overflow: hidden;
    padding: 0.25rem;
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
</style>
