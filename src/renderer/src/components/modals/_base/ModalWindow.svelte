<script lang="ts">
  import { registerModalKeyHandler } from '../../../lib/modal-keyboard-manager'

  let {
    title,
    onClose,
    onSave,
    cancelText = 'Cancel',
    saveText = 'Save & Close',
    maxWidth = '600px',
    zIndex = 100,
    children,
    header
  }: {
    title: string
    onClose: () => void
    onSave?: () => void
    cancelText?: string | null
    saveText?: string
    maxWidth?: string
    zIndex?: number
    children: Snippet
    header?: Snippet
  } = $props()

  let isDragging = $state(false)
  let position = $state({ x: 0, y: 0 })
  let dragStartPos = $state({ mouseX: 0, mouseY: 0, elementX: 0, elementY: 0 })

  $effect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      // Only handle Escape and Enter. Let all other keys (like letters, numbers, arrows)
      // pass through to the input fields.
      if (event.key !== 'Escape' && event.key !== 'Enter') {
        return
      }

      const target = event.target as HTMLElement

      // Special case: allow Enter to create newlines in textareas.
      if (event.key === 'Enter' && target.tagName === 'TEXTAREA') {
        return
      }

      // Now that we're certain we want to handle the key, prevent default.
      // This stops 'Enter' from submitting a form, for example.
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        onClose()
      } else if (onSave && event.key === 'Enter') {
        // Do not trigger save if a button is the active element,
        // allowing the button's own click handler to manage the action.
        if (target.tagName !== 'BUTTON') {
          onSave()
        }
      }
    }

    const unregister = registerModalKeyHandler(handleKeydown)

    return () => {
      unregister()
    }
  })

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
<div
  class="modal-backdrop"
  style="z-index: {zIndex};"
  onmousedown={(e) => e.target === e.currentTarget && onClose()}
>
  <div
    class="modal-positioner"
    style="transform: translate({position.x}px, {position.y}px); max-width: {maxWidth};"
  >
    <div class="modal-window" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-header" onmousedown={handleDragStart} class:dragging={isDragging}>
        <h2 id="modal-title">{title}</h2>
        <div class="header-extra">
          {#if header}
            {@render header()}
          {/if}
        </div>
        <button class="close-btn" onclick={onClose} title="Close (Esc)">&times;</button>
      </header>

      <div class="modal-body">
        {@render children()}
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
    /* z-index is now set inline via style prop */
  }
  .modal-positioner {
    width: 90%;
    /* max-width is applied inline from the prop */
  }
  .modal-window {
    background-color: var(--color-background-soft);
    border-radius: 8px;
    width: 100%; /* It should now fill the positioner, which is correctly sized */
    display: flex;
    flex-direction: column;
    max-height: 90vh;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    animation: modal-pop-in 0.15s ease-out;
  }

  @keyframes modal-pop-in {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
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
    flex-grow: 1; /* Allow title to take up space */
    min-width: 0; /* CRUCIAL: Allows flex item to shrink below its content size */
    white-space: nowrap;
    overflow: hidden;
    /* Apply a fade-out effect instead of an ellipsis for a cleaner look */
    mask-image: linear-gradient(to left, transparent, black 2rem);
    -webkit-mask-image: linear-gradient(to left, transparent, black 2rem);
  }
  .header-extra {
    display: flex;
    justify-content: flex-end;
    flex-shrink: 0; /* Prevent the tabs container from shrinking */
    -webkit-app-region: no-drag; /* Allow clicking elements in the slot */
  }
  .close-btn {
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
