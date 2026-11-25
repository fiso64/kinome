/**
 * Every keyboard shortcut lives here. The app's global handler dispatches from
 * APP_SHORTCUTS, and the shortcut reference renders APP_SHORTCUTS and
 * PLAYER_SHORTCUTS, so a shortcut cannot be added without describing it.
 * Leave out what needs no explaining: Escape closing things, Back, arrows and Enter in lists.
 * Avoid keys the browser keeps for itself, such as Ctrl+Tab.
 */

export interface ShortcutActions {
  navigateBack: () => void
  navigateForward: () => void
  escapeAction: () => void
  focusSearch: () => void
  rescan: () => void
  toggleFullscreen: () => void
  openSettings: () => void
  openViewSettings: () => void
  markAsUnwatched: () => void
  editMetadata: () => void
  openProperties: () => void
  showShortcuts: () => void
}

export interface Shortcut {
  /** Each entry is one way to trigger it; a chord's keys are joined with "+". */
  keys: string[]
  description: string
  /** A global shortcut: matched here and dispatched to an action. */
  match?: (event: KeyboardEvent) => boolean
  action?: keyof ShortcutActions
  /** A shortcut handled where it applies, named so it is easy to find. */
  handledIn?: string
}

const plain = (key: string) => (event: KeyboardEvent) =>
  event.key.toLowerCase() === key && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
const shifted = (key: string) => (event: KeyboardEvent) =>
  event.key === key && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey

export const APP_SHORTCUTS: { section: string; shortcuts: Shortcut[] }[] = [
  {
    section: 'Navigation',
    shortcuts: [
      { keys: ['D'], description: 'Search the library, or within a title', match: plain('d'), action: 'focusSearch' },
      { keys: ['P'], description: 'Open settings', match: plain('p'), action: 'openSettings' },
      { keys: ['F'], description: 'Toggle fullscreen', match: plain('f'), action: 'toggleFullscreen' }
    ]
  },
  {
    section: 'Search',
    shortcuts: [
      { keys: ['>'], description: 'Start a filter tag, such as >genre:drama', handledIn: 'SearchInput.svelte' }
    ]
  },
  {
    section: 'Current item',
    shortcuts: [
      { keys: ['E'], description: 'Edit metadata', match: plain('e'), action: 'editMetadata' },
      { keys: ['V'], description: 'View settings', match: plain('v'), action: 'openViewSettings' },
      { keys: ['Shift+W'], description: 'Mark as unwatched', match: shifted('W'), action: 'markAsUnwatched' },
      { keys: ['Alt+Enter'], description: 'Properties', action: 'openProperties',
        match: (event) => event.key === 'Enter' && event.altKey }
    ]
  },
  {
    section: 'Library',
    shortcuts: [
      { keys: ['Shift+R'], description: 'Rescan the library', match: shifted('R'), action: 'rescan' },
      { keys: ['?'], description: 'Show this list', match: (event) => event.key === '?' && !event.ctrlKey && !event.metaKey,
        action: 'showShortcuts' }
    ]
  }
]

/** Handled by WebPlayer.svelte, which also lists them in its settings menu. */
export const PLAYER_SHORTCUTS: Shortcut[] = [
  { keys: ['Space', 'K'], description: 'Play or pause' },
  { keys: ['Left / Right'], description: 'Seek 5 seconds (Shift for 30)' },
  { keys: [', / .'], description: 'Previous or next frame' },
  { keys: ['Up / Down', 'M'], description: 'Volume or mute' },
  { keys: ['[ / ]'], description: 'Playback speed' },
  { keys: ['A', 'Q', 'P'], description: 'Audio & subtitles, quality, or queue' },
  { keys: ['S'], description: 'Toggle subtitles' },
  { keys: ['Shift+Up / Down'], description: 'Previous or next subtitle track' },
  { keys: ['Ctrl+Shift+Up / Down'], description: 'Subtitle scale' },
  { keys: ['Ctrl+Shift+Left / Right'], description: 'Subtitle delay' },
  { keys: ['PgUp / PgDn'], description: 'Previous or next chapter' },
  { keys: ['Shift+PgUp / PgDn'], description: 'Previous or next video' },
  { keys: ['F'], description: 'Fullscreen' },
  { keys: ['?'], description: 'Player shortcuts' }
]

const globalShortcuts = APP_SHORTCUTS.flatMap(({ shortcuts }) => shortcuts)
  .filter((shortcut): shortcut is Shortcut & Required<Pick<Shortcut, 'match' | 'action'>> => !!shortcut.match && !!shortcut.action)

export function initializeShortcuts(actions: ShortcutActions): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return
    const target = event.target as HTMLElement
    const isInput =
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable

    if (event.key === 'Escape') {
      if (!isInput) event.preventDefault()
      actions.escapeAction()
      return
    }
    // Typing in a field never triggers a shortcut.
    if (isInput) return

    // Back and forward follow the browser's own keys, so they are not listed.
    if (event.key === 'BrowserBack' || (event.altKey && event.key === 'ArrowLeft')) {
      event.preventDefault()
      actions.navigateBack()
      return
    }
    if (event.key === 'BrowserForward' || (event.altKey && event.key === 'ArrowRight')) {
      event.preventDefault()
      actions.navigateForward()
      return
    }
    const shortcut = globalShortcuts.find(({ match }) => match(event))
    if (!shortcut) return
    event.preventDefault()
    actions[shortcut.action]()
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
