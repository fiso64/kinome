<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte'
  import { registerModalKeyHandler } from '@lib/modal-keyboard-manager'
  import Icon from '@components/ui/Icon.svelte'

  let {
    title,
    onClose,
    onSave,
    onDone,
    cancelText = 'Cancel',
    saveText = 'Save & Close',
    submitDisabled = false,
    maxWidth = '600px',
    zIndex = 100,
    role = 'dialog',
    descriptionId,
    children,
    header,
    actions
  }: {
    title: string
    onClose: () => void
    cancelText?: string | null
    saveText?: string
    submitDisabled?: boolean
    maxWidth?: string
    zIndex?: number
    role?: 'dialog' | 'alertdialog'
    descriptionId?: string
    children: Snippet
    header?: Snippet
    actions?: Snippet
  } & (
    | { onSave?: () => void; onDone?: never }
    | { onDone: () => void; onSave?: never }
  ) = $props()

  const submit = $derived(onDone ?? onSave)

  const titleId = $props.id()
  const opener = typeof document === 'undefined' ? null : document.activeElement
  let windowElement: HTMLElement
  let isDragging = $state(false)
  let position = $state({ x: 0, y: 0 })
  let dragStartPos = $state({ mouseX: 0, mouseY: 0, elementX: 0, elementY: 0 })

  onMount(() => {
    const current = windowElement
    void tick().then(() => {
      if (current.isConnected && !current.contains(document.activeElement)) current.focus({ preventScroll: true })
    })
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected &&
        (current.contains(document.activeElement) || document.activeElement === document.body)) {
        opener.focus({ preventScroll: true })
      }
      window.removeEventListener('mousemove', handleDragMove)
      window.removeEventListener('mouseup', handleDragEnd)
    }
  })

  $effect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      // If a child component already handled the event, do nothing.
      if (event.defaultPrevented) {
        return
      }

      if (event.key === 'Tab') {
        const stops = Array.from(windowElement.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], [tabindex]'
        )).filter((node) => node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length > 0)
        const first = stops[0]
        const last = stops.at(-1)
        const active = document.activeElement
        if (!first || !windowElement.contains(active) || active === windowElement ||
          (event.shiftKey ? active === first : active === last)) {
          event.preventDefault()
          const destination = event.shiftKey ? last : first
          if (destination) destination.focus()
          else windowElement.focus()
        }
      } else if (event.key === 'Escape') {
        // Escape should always close the modal.
        event.preventDefault()
        onClose()
      } else if (submit && !submitDisabled && event.key === 'Enter') {
        const target = event.target as HTMLElement
        const isModEnter = event.ctrlKey || event.metaKey

        // Buttons and links handle Enter on their own.
        if (target.closest('button, a[href]')) {
          return
        }

        // Let forms, textareas, and pill inputs handle Enter themselves.
        // But if it's Ctrl/Cmd + Enter, we ALWAYS save.
        if (
          !isModEnter &&
          (target.closest('form') || target.tagName === 'TEXTAREA' || target.hasAttribute('data-enter-pill'))
        ) {
          return
        }

        // For all other cases, 'Enter' (or any Mod+Enter) saves the modal.
        event.preventDefault()
        submit()
      }
    }

    const unregister = registerModalKeyHandler(handleKeydown)

    return () => {
      unregister()
    }
  })

  function handleDragStart(event: MouseEvent) {
    // Don't drag if a button in the header is clicked
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, a, input, select')) return

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
    const bounds = windowElement.getBoundingClientRect()
    const centeredLeft = bounds.left - position.x
    const centeredTop = bounds.top - position.y
    const visibleHeader = Math.min(bounds.width, 200)
    position = {
      x: Math.min(window.innerWidth - centeredLeft - visibleHeader,
        Math.max(visibleHeader - centeredLeft - bounds.width, dragStartPos.elementX + deltaX)),
      y: Math.min(window.innerHeight - centeredTop - 55,
        Math.max(-centeredTop + 5, dragStartPos.elementY + deltaY))
    }
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
  onmousedown={(e) => {
    if (e.target === e.currentTarget) {
      e.stopPropagation()
      onClose()
    }
  }}
>
  <div
    class="modal-positioner"
    style="transform: translate({position.x}px, {position.y}px); max-width: {maxWidth};"
  >
    <div class="modal-window glass-surface" bind:this={windowElement} {role} aria-modal="true"
      aria-labelledby={titleId} aria-describedby={descriptionId} tabindex="-1">
      <header class="modal-header" onmousedown={handleDragStart} class:dragging={isDragging}>
        <h2 id={titleId}>{title}</h2>
        <button class="icon-button close-btn" type="button" onclick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="close" size={19} />
        </button>
      </header>

      {#if header}<div class="header-extra">{@render header()}</div>{/if}

      <div class="modal-body">
        {@render children()}
      </div>

      {#if actions || submit || cancelText}
        <footer class="modal-actions">
          {#if actions}
            {@render actions()}
          {:else}
            {#if cancelText}
              <button class="secondary" onclick={onClose}>{cancelText}</button>
            {/if}
            {#if submit}
              <button class="primary" disabled={submitDisabled} onclick={submit}>{onDone ? 'Done' : saveText}</button>
            {/if}
          {/if}
        </footer>
      {/if}
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: #0606099c;
    display: grid;
    place-items: center;
    padding: clamp(.52rem, 3vw, 2.75rem);
  }

  .modal-positioner { width: 100%; min-width: 0; }
  .modal-window {
    width: 100%;
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 2 * clamp(.52rem, 3vw, 2.75rem));
    border-radius: var(--radius-window);
    box-shadow: var(--edge-light), var(--shadow-window);
    overflow: hidden;
    outline: none;
    animation: window-enter .16s ease-out;
  }

  @keyframes window-enter {
    from { opacity: 0; transform: translateY(5px) scale(.992); }
  }

  .modal-header {
    min-height: 3.9rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: .75rem;
    padding: .65rem 1rem .65rem 1.2rem;
    background: linear-gradient(160deg, #ffffff06, transparent);
    border-bottom: 1px solid var(--color-border-soft);
    cursor: grab;
    flex: none;
    user-select: none;
  }
  .modal-header.dragging { cursor: grabbing; }
  .modal-header h2 { font-size: clamp(1.075rem, 2.8vw, 1.3rem); font-weight: 670; letter-spacing: -.022em; overflow-wrap: anywhere; }
  .header-extra {
    min-width: 0;
    flex: none;
    padding: .55rem 1.1rem;
    border-bottom: 1px solid var(--color-border-soft);
    overflow-x: auto;
  }

  .modal-body {
    min-height: 0;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    overscroll-behavior: contain;
  }

  @media (pointer: coarse) { .modal-header { cursor: default; } }
  @media (max-width: 540px) {
    .modal-header { padding-inline: .8rem .55rem; min-height: 3.2rem; }
    .header-extra { padding-inline: .7rem; }
  }
  @media (prefers-reduced-motion: reduce) { .modal-window { animation: none; } }
</style>
