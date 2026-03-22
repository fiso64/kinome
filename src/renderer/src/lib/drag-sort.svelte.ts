/**
 * Encapsulates all state and event handlers for a drag-to-reorder list.
 * Uses pointer events for a modern drag experience: a floating clone follows
 * the cursor while items dynamically rearrange via Svelte's animate:flip.
 *
 * Usage:
 *   const drag = useDragSort(() => items, (v) => (items = v))
 *
 * Template:
 *   {#each items as item, i (item.id)}
 *     <div
 *       use:drag.item={i}
 *       use:drag.handle={i}
 *       class:drag-placeholder={drag.draggedIndex === i}
 *       animate:flip={{ duration: 200 }}
 *     >
 *       <span class="drag-handle">⠿</span>
 *     </div>
 *   {/each}
 *
 * CSS (add to your component):
 *   .drag-placeholder { opacity: 0.25; pointer-events: none; }
 *
 * Dragging from any part of the item is supported. Interactive elements (inputs,
 * buttons, etc.) are excluded from drag initiation so they retain full native
 * behaviour, including click-drag text selection in inputs.
 */

// Elements whose pointerdown events must not start a drag
const INTERACTIVE_SELECTOR = 'input, textarea, select, button, a, label, [contenteditable]'
// Pixels the pointer must move before a pending pointerdown commits to a drag.
// This preserves click handlers on non-interactive item areas.
const DRAG_THRESHOLD = 5

export function useDragSort<T>(getItems: () => T[], setItems: (items: T[]) => void) {
  let draggedIndex = $state<number | null>(null)

  // Map from current array index → registered DOM element
  const itemEls = new Map<number, HTMLElement>()

  let floatingEl: HTMLElement | null = null
  let pointerOffsetX = 0
  let pointerOffsetY = 0
  let originalItems: T[] = []

  // --- Pending drag (before threshold crossed) ---

  let pending: { startX: number; startY: number; index: number; itemEl: HTMLElement } | null = null

  function onPendingMove(e: PointerEvent) {
    if (!pending) return
    const dx = e.clientX - pending.startX
    const dy = e.clientY - pending.startY
    if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
      const { index, itemEl } = pending
      clearPending()
      startDrag(e, itemEl, index)
    }
  }

  function clearPending() {
    pending = null
    document.removeEventListener('pointermove', onPendingMove)
    document.removeEventListener('pointerup', clearPending)
  }

  // --- Active drag ---

  /**
   * Finds the target insertion index in the current items array based on the
   * pointer's Y position relative to all non-dragged item elements.
   * Returns the index at which to insert the dragged item (in the pre-splice array).
   */
  function findInsertIndex(clientY: number): number {
    if (draggedIndex === null) return 0

    const positions: Array<{ index: number; center: number }> = []
    for (const [idx, el] of itemEls) {
      if (idx === draggedIndex) continue
      const rect = el.getBoundingClientRect()
      positions.push({ index: idx, center: rect.top + rect.height / 2 })
    }
    positions.sort((a, b) => a.center - b.center)

    // Find the last item whose center is at or above the pointer
    let targetIndex = 0
    for (const { index, center } of positions) {
      if (clientY >= center) {
        targetIndex = index + 1
      } else {
        break
      }
    }

    return targetIndex
  }

  function onPointerMove(e: PointerEvent) {
    if (!floatingEl || draggedIndex === null) return

    // Move the floating clone to follow the pointer
    floatingEl.style.left = `${e.clientX - pointerOffsetX}px`
    floatingEl.style.top = `${e.clientY - pointerOffsetY}px`

    // Compute the new insertion position
    const targetIndex = findInsertIndex(e.clientY)
    // After splicing out the dragged item, its gap closes — adjust for that
    const actualInsert = targetIndex > draggedIndex ? targetIndex - 1 : targetIndex

    if (actualInsert !== draggedIndex) {
      const items = [...getItems()]
      items.splice(actualInsert, 0, items.splice(draggedIndex, 1)[0])
      setItems(items)
      draggedIndex = actualInsert
    }
  }

  function onPointerUp() {
    cleanup()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      setItems(originalItems)
      draggedIndex = null
      cleanup()
    }
  }

  function cleanup() {
    clearPending()
    if (floatingEl) {
      floatingEl.remove()
      floatingEl = null
    }
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', onPointerUp)
    document.removeEventListener('keydown', onKeyDown)
    document.body.style.userSelect = ''
    draggedIndex = null
  }

  function startDrag(e: PointerEvent, itemEl: HTMLElement, index: number) {
    e.preventDefault()

    // After the drag gesture ends (pointerup), the browser may fire a click event.
    // Suppress it so item onclick handlers don't fire after a drag.
    const suppressClick = (ev: MouseEvent) => {
      ev.stopPropagation()
      ev.preventDefault()
      document.removeEventListener('click', suppressClick, true)
    }
    document.addEventListener('click', suppressClick, true)

    originalItems = [...getItems()]
    draggedIndex = index

    const rect = itemEl.getBoundingClientRect()
    pointerOffsetX = e.clientX - rect.left
    pointerOffsetY = e.clientY - rect.top

    // Clone the item element to create the floating visual.
    // We clone before Svelte applies drag-placeholder, so the clone looks normal.
    floatingEl = itemEl.cloneNode(true) as HTMLElement
    floatingEl.style.position = 'fixed'
    floatingEl.style.left = `${rect.left}px`
    floatingEl.style.top = `${rect.top}px`
    floatingEl.style.width = `${rect.width}px`
    floatingEl.style.height = `${rect.height}px`
    floatingEl.style.margin = '0'
    floatingEl.style.pointerEvents = 'none'
    floatingEl.style.zIndex = '9999'
    floatingEl.style.opacity = '0.95'
    floatingEl.style.boxShadow = '0 8px 28px rgba(0, 0, 0, 0.3)'
    floatingEl.style.transform = 'scale(1.02)'
    floatingEl.style.transition = 'box-shadow 0.15s, transform 0.15s'
    document.body.appendChild(floatingEl)

    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('keydown', onKeyDown)
  }

  /** Svelte action for item container elements. */
  function item(el: HTMLElement, index: number) {
    el.dataset.dragItem = 'true'
    itemEls.set(index, el)
    return {
      update(newIndex: number) {
        for (const [k, v] of itemEls) {
          if (v === el) {
            itemEls.delete(k)
            break
          }
        }
        itemEls.set(newIndex, el)
      },
      destroy() {
        for (const [k, v] of itemEls) {
          if (v === el) {
            itemEls.delete(k)
            break
          }
        }
        delete el.dataset.dragItem
      }
    }
  }

  /**
   * Svelte action for drag handle elements. Apply to the item container itself
   * to make the whole item draggable (interactive children are automatically
   * excluded). Or apply to a specific child element for an explicit handle.
   *
   * Interactive elements (inputs, buttons, etc.) always receive events normally
   * regardless of where this action is applied.
   */
  function handle(el: HTMLElement, index: number) {
    el.style.cursor = 'grab'

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return
      // If the click landed on or inside an interactive element, do nothing —
      // let the browser handle it (text selection, focus, button click, etc.)
      if ((e.target as HTMLElement).closest(INTERACTIVE_SELECTOR)) return

      const itemEl = el.closest('[data-drag-item]') as HTMLElement | null
      if (!itemEl) return

      // Arm a pending drag. Only commit after the pointer moves past the threshold
      // so that plain clicks on the item still fire onclick handlers.
      pending = { startX: e.clientX, startY: e.clientY, index, itemEl }
      document.addEventListener('pointermove', onPendingMove)
      document.addEventListener('pointerup', clearPending)
    }

    el.addEventListener('pointerdown', onPointerDown)
    return {
      update(newIndex: number) {
        index = newIndex
      },
      destroy() {
        el.removeEventListener('pointerdown', onPointerDown)
      }
    }
  }

  return {
    get draggedIndex() {
      return draggedIndex
    },
    item,
    handle
  }
}
