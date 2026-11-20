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
 * behaviour. A button marked data-drag-handle can also initiate a drag.
 * Use external on an item outside the ordered list and dropZone on the list
 * to allow inserting that item at the drop position.
 */

// Elements whose pointerdown events must not start a drag
const INTERACTIVE_SELECTOR = 'input, textarea, select, button, a, label, [contenteditable]'
// Pixels the pointer must move before a pending pointerdown commits to a drag.
// This preserves click handlers on non-interactive item areas.
const DRAG_THRESHOLD = 5
type DragSource<T> = { index: number } | { item: T }

export function useDragSort<T>(getItems: () => T[], setItems: (items: T[]) => void) {
  let draggedIndex = $state<number | null>(null)
  let externalDrag = $state.raw<{ item: T }>()
  let dropIndex = $state<number | null>(null)
  let dropTarget: HTMLElement | undefined

  const itemEls = new Map<HTMLElement, number>()

  let floatingEl: HTMLElement | null = null
  let pointerOffsetX = 0
  let pointerOffsetY = 0
  let originalItems: T[] = []
  let pointerId: number | undefined
  let dragOrigin: HTMLElement | undefined
  let originalUserSelect = ''

  // --- Pending drag (before threshold crossed) ---

  let pending: { startX: number; startY: number; source: DragSource<T>; itemEl: HTMLElement; pointerId: number } | null = null

  function onPendingMove(e: PointerEvent) {
    if (pending?.pointerId !== e.pointerId) return
    const dx = e.clientX - pending.startX
    const dy = e.clientY - pending.startY
    if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
      const { source, itemEl } = pending
      clearPending()
      startDrag(e, itemEl, source)
    }
  }

  function clearPending(event?: PointerEvent) {
    if (event && pending?.pointerId !== event.pointerId) return
    pending = null
    document.removeEventListener('pointermove', onPendingMove)
    document.removeEventListener('pointerup', clearPending)
    document.removeEventListener('pointercancel', clearPending)
  }

  // --- Active drag ---

  /**
   * Finds the target insertion index in the current items array based on the
   * pointer's Y position relative to all non-dragged item elements.
   * Returns the index at which to insert the dragged item (in the pre-splice array).
   */
  function findInsertIndex(clientY: number): number {
    const positions: Array<{ index: number; center: number }> = []
    for (const [el, idx] of itemEls) {
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
    if (!floatingEl || e.pointerId !== pointerId) return

    // Move the floating clone to follow the pointer
    floatingEl.style.left = `${e.clientX - pointerOffsetX}px`
    floatingEl.style.top = `${e.clientY - pointerOffsetY}px`

    if (externalDrag) {
      dropIndex = externalInsertionIndex(e)
      return
    }
    if (draggedIndex === null) return

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

  function externalInsertionIndex(e: PointerEvent): number | null {
    return dropTarget?.contains(document.elementFromPoint(e.clientX, e.clientY))
      ? findInsertIndex(e.clientY)
      : null
  }

  function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== pointerId) return
    const external = externalDrag
    const index = external ? externalInsertionIndex(e) : null
    cleanup()

    // The pointer release can still dispatch a click on a card or its controls.
    const suppressClick = (event: MouseEvent) => {
      event.stopPropagation()
      event.preventDefault()
    }
    document.addEventListener('click', suppressClick, { capture: true, once: true })
    setTimeout(() => document.removeEventListener('click', suppressClick, true), 0)

    if (external && index !== null) {
      const items = [...getItems()]
      items.splice(index, 0, external.item)
      setItems(items)
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') cancelDrag()
  }

  function cancelDrag(e?: PointerEvent) {
    if (e && e.pointerId !== pointerId) return
    if (draggedIndex !== null) setItems(originalItems)
    cleanup()
  }

  function cleanup() {
    clearPending()
    if (floatingEl) {
      floatingEl.remove()
      floatingEl = null
      document.body.style.userSelect = originalUserSelect
    }
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', onPointerUp)
    document.removeEventListener('pointercancel', cancelDrag)
    document.removeEventListener('keydown', onKeyDown)
    pointerId = undefined
    dragOrigin = undefined
    draggedIndex = null
    externalDrag = undefined
    dropIndex = null
  }

  function startDrag(e: PointerEvent, itemEl: HTMLElement, source: DragSource<T>) {
    e.preventDefault()
    pointerId = e.pointerId
    dragOrigin = itemEl
    originalItems = [...getItems()]

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

    originalUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    if ('index' in source) draggedIndex = source.index
    else externalDrag = source
    onPointerMove(e)
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', cancelDrag)
    document.addEventListener('keydown', onKeyDown)
  }

  /** Svelte action for item container elements. */
  function item(el: HTMLElement, index: number) {
    el.dataset.dragItem = 'true'
    itemEls.set(el, index)
    return {
      update(newIndex: number) {
        itemEls.set(el, newIndex)
      },
      destroy() {
        itemEls.delete(el)
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
    const destroy = dragHandle(el, () => ({ index }))
    return { update: (value: number) => { index = value }, destroy }
  }

  function external(el: HTMLElement, item: T) {
    const destroy = dragHandle(el, () => ({ item }))
    return { update: (value: T) => { item = value }, destroy }
  }

  function dragHandle(el: HTMLElement, getSource: () => DragSource<T>) {
    el.style.cursor = 'grab'
    let itemEl: HTMLElement | undefined

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0 || pending || floatingEl) return
      // If the click landed on or inside an interactive element, do nothing —
      // let the browser handle it (text selection, focus, button click, etc.)
      const control = (e.target as Element).closest(INTERACTIVE_SELECTOR)
      if (control && !control.hasAttribute('data-drag-handle')) return
      itemEl = el.closest<HTMLElement>('[data-drag-item]') ?? el

      // Arm a pending drag. Only commit after the pointer moves past the threshold
      // so that plain clicks on the item still fire onclick handlers.
      pending = { startX: e.clientX, startY: e.clientY, source: getSource(), itemEl, pointerId: e.pointerId }
      document.addEventListener('pointermove', onPendingMove)
      document.addEventListener('pointerup', clearPending)
      document.addEventListener('pointercancel', clearPending)
    }

    el.addEventListener('pointerdown', onPointerDown)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      if (itemEl && dragOrigin === itemEl) cleanup()
      else if (itemEl && pending?.itemEl === itemEl) clearPending()
    }
  }

  function dropZone(el: HTMLElement) {
    dropTarget = el
    return { destroy: () => { if (dropTarget === el) dropTarget = undefined } }
  }

  return {
    get draggedIndex() {
      return draggedIndex
    },
    get externalItem() { return externalDrag?.item },
    get dropIndex() { return dropIndex },
    item,
    handle,
    external,
    dropZone
  }
}
