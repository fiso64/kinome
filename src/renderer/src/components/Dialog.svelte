<script lang="ts">
  import type { DialogButton } from '../lib/dialog-store'

  let {
    title,
    message,
    detail,
    buttons,
    onClose
  }: {
    title: string
    message: string
    detail?: string
    buttons: DialogButton[]
    onClose: (value: any) => void
  } = $props()

  let isDragging = $state(false)
  let position = $state({ x: 0, y: 0 })
  let dragStartPos = $state({ mouseX: 0, mouseY: 0, elementX: 0, elementY: 0 })

  function handleDragStart(event: MouseEvent) {
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

  $effect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        // Find a "cancel" button (usually value: false) or default to the last button
        const cancelButton = buttons.find((b) => b.value === false) ?? buttons[buttons.length - 1]
        onClose(cancelButton.value)
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  })
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="dialog-backdrop"
  onmousedown={(e) => {
    if (e.target === e.currentTarget) {
      const cancelButton = buttons.find((b) => b.value === false) ?? buttons[buttons.length - 1]
      onClose(cancelButton.value)
    }
  }}
>
  <div
    class="dialog-window"
    style="transform: translate({position.x}px, {position.y}px);"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="dialog-title"
    aria-describedby="dialog-message"
  >
    <header class="dialog-header" onmousedown={handleDragStart} class:dragging={isDragging}>
      <h2 id="dialog-title">{title}</h2>
    </header>

    <div class="dialog-body">
      <p id="dialog-message" class="message">{message}</p>
      {#if detail}
        <p class="detail">{detail}</p>
      {/if}
    </div>

    <footer class="dialog-actions">
      {#each buttons as button (button.label)}
        <button class="dialog-button" class:primary={button.class === 'primary'} class:danger={button.class === 'danger'} class:secondary={button.class === 'secondary'} onclick={() => onClose(button.value)}
          >{button.label}</button
        >
      {/each}
    </footer>
  </div>
</div>

<style>
  .dialog-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.6);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2000; /* Above modals */
  }
  .dialog-window {
    position: relative;
    background-color: var(--color-background-soft);
    border-radius: 8px;
    width: 90%;
    max-width: 500px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    animation: fadeIn 0.1s ease-out;
  }
  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .dialog-header {
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--color-background-mute);
    cursor: grab;
    -webkit-user-select: none;
    user-select: none;
  }
  .dialog-header.dragging {
    cursor: grabbing;
  }
  .dialog-header h2 {
    font-size: 1.2rem;
    font-weight: bold;
  }
  .dialog-body {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .message {
    font-size: 1rem;
    line-height: 1.6;
    color: var(--color-text);
    white-space: pre-wrap; /* Preserve newlines from error messages */
  }
  .detail {
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--ev-c-text-2);
    white-space: pre-wrap;
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    padding: 1.5rem;
    padding-top: 0.5rem;
    background-color: var(--color-background);
    border-top: 1px solid var(--color-background-mute);
    border-bottom-left-radius: 8px;
    border-bottom-right-radius: 8px;
  }
  .dialog-button.danger {
    background-color: #c50f1f;
    color: white;
  }
  .dialog-button.danger:hover:not(:disabled) {
    background-color: #a40e19;
  }
</style>