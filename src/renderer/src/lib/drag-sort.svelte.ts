/**
 * Encapsulates all state and event handlers for a drag-to-reorder list.
 *
 * Usage:
 *   const drag = useDragSort(() => items, (v) => (items = v))
 *
 * Template:
 *   <div
 *     class:drag-over={drag.dragOverIndex === i}
 *     ondragover={(e) => drag.onDragOver(e, i)}
 *     ondragenter={(e) => e.preventDefault()}
 *     ondrop={(e) => drag.onDrop(e, i)}
 *     ondragend={drag.onDragEnd}
 *   >
 *     <span draggable="true" ondragstart={(e) => drag.onDragStart(e, i)}>⠿</span>
 */
export function useDragSort<T>(getItems: () => T[], setItems: (items: T[]) => void) {
  let draggedIndex = $state<number | null>(null)
  let dragOverIndex = $state<number | null>(null)

  function onDragStart(e: DragEvent, index: number) {
    draggedIndex = index
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  function onDragOver(e: DragEvent, index: number) {
    e.preventDefault()
    if (draggedIndex !== null && index !== draggedIndex) dragOverIndex = index
  }

  function onDrop(e: DragEvent, dropIndex: number) {
    e.preventDefault()
    if (draggedIndex === null || draggedIndex === dropIndex) {
      dragOverIndex = null
      return
    }
    const items = [...getItems()]
    items.splice(dropIndex, 0, items.splice(draggedIndex, 1)[0])
    setItems(items)
    draggedIndex = null
    dragOverIndex = null
  }

  function onDragEnd() {
    draggedIndex = null
    dragOverIndex = null
  }

  return {
    get dragOverIndex() {
      return dragOverIndex
    },
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd
  }
}
