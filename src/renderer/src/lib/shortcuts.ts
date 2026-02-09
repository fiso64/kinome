interface ShortcutActions {
  navigateBack: () => void
  navigateForward: () => void
  escapeAction: () => void
  focusSearch: () => void
  rescan: () => void // Shift+R
  toggleFullscreen: () => void // F
  openSettings: () => void // P
  openViewSettings: () => void // V
  markAsUnwatched: () => void // Shift+W
  editMetadata: () => void // E
  openProperties: () => void // Alt+Enter
}

export function initializeShortcuts(actions: ShortcutActions): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement
    const isInput =
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

    // --- Shortcuts that should NOT fire when typing in an input ---
    if (isInput) {
      if (event.key === 'Escape') {
        actions.escapeAction()
      }
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      actions.escapeAction()
    } else if (event.key === 'BrowserBack' || (event.altKey && event.key === 'ArrowLeft')) {
      event.preventDefault()
      actions.navigateBack()
    } else if (event.key === 'BrowserForward' || (event.altKey && event.key === 'ArrowRight')) {
      event.preventDefault()
      actions.navigateForward()
    } else if (
      (event.key === 'd' || event.key === 'D') &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault()
      actions.focusSearch()
    } else if (event.key === 'R' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      actions.rescan()
    } else if (event.key === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      actions.toggleFullscreen()
    } else if (event.key === 'p' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      actions.openSettings()
    } else if (event.key === 'v' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      actions.openViewSettings()
    } else if (event.key === 'W' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      actions.markAsUnwatched()
    } else if (event.key === 'e' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      actions.editMetadata()
    } else if (event.key === 'Enter' && event.altKey) {
      event.preventDefault()
      actions.openProperties()
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
