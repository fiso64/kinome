type KeyHandler = (event: KeyboardEvent) => void

const handlerStack: KeyHandler[] = []

/**
 * The single global event listener for keyboard events.
 * It calls only the handler at the top of the stack.
 */
function globalKeydownListener(event: KeyboardEvent) {
  if (handlerStack.length > 0) {
    const topHandler = handlerStack[handlerStack.length - 1]
    topHandler(event)
    // If the modal handler prevented the default action (e.g., for Escape or Enter),
    // then also stop the event from propagating to other global listeners like shortcuts.
    if (event.defaultPrevented) {
      event.stopPropagation()
    }
  }
}

// This check is to prevent errors during SSR or in non-browser environments.
if (typeof window !== 'undefined') {
  // Listen during the capture phase (by setting the third argument to `true`)
  // to ensure this runs before other global listeners (like shortcuts) and can
  // stop the event from propagating to them if handled.
  window.addEventListener('keydown', globalKeydownListener, true)
}

/**
 * Registers a keyboard event handler for a modal.
 * The handler is pushed onto a stack, ensuring only the top-most modal's
 * handler will be executed.
 *
 * @param handler The function to call when a keydown event occurs.
 * @returns A cleanup function to be called when the modal is unmounted.
 */
export function registerModalKeyHandler(handler: KeyHandler): () => void {
  handlerStack.push(handler)

  return () => {
    // When cleaning up, remove this specific handler from the stack.
    // Searching from the end is safest in case of duplicate handlers.
    const index = handlerStack.lastIndexOf(handler)
    if (index > -1) {
      handlerStack.splice(index, 1)
    }
  }
}
