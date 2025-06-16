<script lang="ts">
  let {
    title,
    onClose,
    onSave,
    cancelText = 'Cancel',
    saveText = 'Save & Close',
    maxWidth = '600px'
  }: {
    title: string
    onClose: () => void
    onSave?: () => void
    cancelText?: string | null
    saveText?: string
    maxWidth?: string
  } = $props()

  let isDragging = $state(false)
  let position = $state({ x: 0, y: 0 })
  let dragStartPos = $state({ mouseX: 0, mouseY: 0, elementX: 0, elementY: 0 })
  let modalElement: HTMLDivElement

  function handleDragStart(event: MouseEvent) {
    // Don't drag if a button in the header is clicked
    if ((event.target as HTMLElement).closest('button')) return

    isDragging = true
    dragStartPos = {
      mouseX: event.clientX,
      mouseY: event.clientY,
      elementX: position.x,
      elementY: position.y
    }

    window.addEventListener('mousemove', handleDragMove)
    window.addEventListener('mouseup', handleDragEnd, { once: true })
  }

  function handleDragMove(event: MouseEvent) {
    if (!isDragging) return
    const deltaX = event.clientX - dragStartPos.mouseX
    const deltaY = event.clientY - dragStartPos.mouseY
    position.x = dragStartPos.elementX + deltaX
    position.y = dragStartPos.elementY + deltaY
  }

  function handleDragEnd() {
    isDragging = false
    window.removeEventListener('mousemove', handleDragMove)
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<div class="modal-backdrop" onmousedown={(e) => e.target === e.currentTarget && onClose()}>
  <div
    bind:this={modalElement}
    class="modal-window"
    style="transform: translate({position.x}px, {position.y}px); max-width: {maxWidth};"
    role="dialog"
    aria-modal="true"
    aria-labelledby="modal-title"
  >
    <header class="modal-header" onmousedown={handleDragStart} class:dragging={isDragging}>
      <h2 id="modal-title">{title}</h2>
      <div class="header-extra">
        <slot name="header" />
      </div>
      <button class="close-btn" onclick={onClose} title="Close (Esc)">&times;</button>
    </header>

    <div class="modal-body">
      <slot />
    </div>

    {#if onSave || cancelText}
      <footer class="modal-actions">
        {#if cancelText}
          <button class="secondary" onclick={onClose}>{cancelText}</button>
        {/if}
        {#if onSave}
          <button class="primary" onclick={onSave}>{saveText}</button>
        {/if}
      </footer>
    {/if}
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: flex-start; /* Align to the top instead of centering */
    padding-top: 10vh; /* Give some space from the top */
    z-index: 100;
  }
  .modal-window {
    position: relative;
    background-color: var(--color-background-soft);
    border-radius: 8px;
    width: 90%;
    display: flex;
    flex-direction: column;
    max-height: 90vh;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    /* The transform is set inline */
  }
  .modal-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem 0.5rem 1rem 1.5rem;
    border-bottom: 1px solid var(--color-background-mute);
    cursor: grab;
    flex-shrink: 0;
    -webkit-user-select: none;
    user-select: none;
  }
  .modal-header.dragging {
    cursor: grabbing;
  }
  .modal-header h2 {
    font-size: 1.2rem;
    font-weight: bold;
    flex-shrink: 0;
  }
  .header-extra {
    flex-grow: 1;
    display: flex;
    justify-content: flex-end;
    -webkit-app-region: no-drag; /* Allow clicking elements in the slot */
  }
  .close-btn {
    margin-left: auto;
    background: none;
    color: var(--ev-c-text-2);
    font-size: 2rem;
    line-height: 1;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border-radius: 50%;
    transition:
      background-color 0.2s,
      color 0.2s;
  }
  .close-btn:hover {
    background-color: var(--ev-c-gray-3);
    color: var(--ev-c-text-1);
  }
  .modal-body {
    overflow-y: auto;
    flex-grow: 1;
    display: flex;
    flex-direction: column;
  }
  /* modal-actions is global now */
</style>
