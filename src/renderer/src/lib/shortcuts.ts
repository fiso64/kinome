interface ShortcutActions {
  navigateBack: () => void
  navigateForward: () => void
}

export function initializeShortcuts(actions: ShortcutActions): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement
    const isInput =
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

    // --- Shortcuts that should NOT fire when typing in an input ---
    if (isInput) {
      return
    }

    if (
      event.key === 'Escape' ||
      event.key === 'BrowserBack' ||
      (event.altKey && event.key === 'ArrowLeft')
    ) {
      event.preventDefault()
      actions.navigateBack()
    } else if (event.key === 'BrowserForward' || (event.altKey && event.key === 'ArrowRight')) {
      event.preventDefault()
      actions.navigateForward()
    }
  }

  const handleMouseDown = (event: MouseEvent): void => {
    // Mouse 4 (Back)
    if (event.button === 3) {
      event.preventDefault()
      actions.navigateBack()
    }
    // Mouse 5 (Forward)
    if (event.button === 4) {
      event.preventDefault()
      actions.navigateForward()
    }
  }

  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('mousedown', handleMouseDown)

  // Return a cleanup function
  return () => {
    window.removeEventListener('keydown', handleKeyDown)
    window.removeEventListener('mousedown', handleMouseDown)
  }
}
