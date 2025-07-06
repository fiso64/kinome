interface ShortcutActions {
  openSettings: () => void
  focusSearch: () => void
  navigateBack: () => void
  navigateForward: () => void
  reloadLibrary: () => void
  showAndFocusFilterBar: () => void
}

export function initializeShortcuts(actions: ShortcutActions): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    const isMac = /mac/i.test(navigator.platform)
    const modKey = isMac ? event.metaKey : event.ctrlKey

    const target = event.target as HTMLElement
    const isInput =
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

    // --- App-wide shortcuts that work even in input fields ---
    if (modKey && event.key.toLowerCase() === 'l') {
      event.preventDefault()
      actions.focusSearch()
      return
    }
    if (event.altKey && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      actions.focusSearch()
      return
    }

    // --- Special case for Ctrl+F, works everywhere ---
    if (modKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      actions.showAndFocusFilterBar()
      return
    }

    // --- Shortcuts that should NOT fire when typing in an input ---
    if (isInput) {
      return
    }

    if (modKey && event.key.toLowerCase() === 'p') {
      event.preventDefault()
      actions.openSettings()
    } else if (event.key === 'F5') {
      event.preventDefault()
      actions.reloadLibrary()
    } else if (
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
