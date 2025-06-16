<script lang="ts">
  let {
    item,
    position,
    isTreeView,
    onClose,
    onOpen,
    onEditMetadata,
    onSetLayout,
    onOpenFolderSettings
  }: {
    item: LibraryItem
    position: { top: number; left: number }
    isTreeView: boolean
    onClose: () => void
    onOpen: () => void
    onEditMetadata: () => void
    onSetLayout: () => void
    onOpenFolderSettings: () => void
  } = $props()

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

<div
  class="context-menu"
  style="top: {position.top}px; left: {position.left}px;"
  onclick={(e) => e.stopPropagation()}
>
  {#if isTreeView && item.type === 'folder'}
    <button class="context-menu-item" onclick={handleOpen}>
      Open
    </button>
  {/if}
  <button class="context-menu-item" onclick={handleEdit}>
    Edit Metadata
  </button>
  {#if item.type === 'folder'}
    <button class="context-menu-item" onclick={handleLayout}>
      Set Children View...
    </button>
    <button class="context-menu-item" onclick={handleFolderSettings}>
      Folder Settings...
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
    display: block;
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

  .context-menu-item:hover {
    background-color: var(--ev-c-gray-2);
  }
</style>
