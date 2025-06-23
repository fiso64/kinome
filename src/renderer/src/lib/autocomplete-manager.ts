import { writable, get } from 'svelte/store'

const SUGGESTION_LIMIT = 50

export interface AutocompleteState {
  show: boolean
  suggestions: string[]
  position: { top: number; left: number; inputTop: number }
  onSelect: (suggestion: string) => void
  activeIndex: number
  targetNode: HTMLElement | null
}

export const autocompleteState = writable<AutocompleteState>({
  show: false,
  suggestions: [],
  position: { top: 0, left: 0 },
  onSelect: () => {},
  activeIndex: 0,
  targetNode: null
})

// Action configuration
export interface AutocompleteConfig {
  getSuggestions: (text: string, cursorPosition: number) => string[]
  onSelect: (suggestion: string, node: HTMLElement) => void
  triggerOnFocus?: boolean
}

let textMirror: HTMLSpanElement | null = null

function handleKeydown(event: KeyboardEvent) {
  const state = get(autocompleteState)
  if (!state.show || state.suggestions.length === 0) return

  let handled = false
  if (event.key === 'ArrowDown') {
    handled = true
    autocompleteState.update((s) => ({
      ...s,
      activeIndex: (s.activeIndex + 1) % s.suggestions.length
    }))
  } else if (event.key === 'ArrowUp') {
    handled = true
    autocompleteState.update((s) => ({
      ...s,
      activeIndex: (s.activeIndex - 1 + s.suggestions.length) % s.suggestions.length
    }))
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    handled = true
    state.onSelect(state.suggestions[state.activeIndex])
  } else if (event.key === 'Escape') {
    handled = true
    autocompleteState.update((s) => ({ ...s, show: false }))
  }

  if (handled) {
    event.preventDefault()
    event.stopPropagation()
  }
}

export function autocomplete(
  node: HTMLInputElement | HTMLTextAreaElement,
  config: AutocompleteConfig
) {
  function updateSuggestions() {
    const text = node.value
    const cursorPos = node.selectionStart ?? 0
    const rawSuggestions = config.getSuggestions(text, cursorPos)
    const suggestions = rawSuggestions.slice(0, SUGGESTION_LIMIT)

    if (suggestions.length > 0) {
      if (!textMirror) {
        textMirror = document.createElement('span')
        textMirror.className = 'autocomplete-text-mirror'
        document.body.appendChild(textMirror)
      }

      const computedStyle = getComputedStyle(node)
      textMirror.style.font = computedStyle.font
      textMirror.style.letterSpacing = computedStyle.letterSpacing
      textMirror.style.whiteSpace = 'pre'

      const prefix = text.substring(0, cursorPos)
      textMirror.textContent = prefix

      const nodeRect = node.getBoundingClientRect()
      const caretLeft =
        nodeRect.left +
        parseInt(computedStyle.paddingLeft, 10) -
        node.scrollLeft +
        textMirror.offsetWidth

      const position = {
        top: nodeRect.bottom + 4,
        left: caretLeft,
        inputTop: nodeRect.top
      }

      const wrappedOnSelect = (suggestion: string) => {
        // 1. Call the component's original onSelect logic.
        config.onSelect(suggestion, node)

        // 2. Schedule a re-evaluation of suggestions for after the DOM updates.
        queueMicrotask(() => {
          updateSuggestions()
        })
      }

      autocompleteState.set({
        show: true,
        suggestions,
        position,
        onSelect: wrappedOnSelect,
        activeIndex: 0,
        targetNode: node
      })
    } else {
      autocompleteState.update((s) => (s.targetNode === node ? { ...s, show: false } : s))
    }
  }

  function handleFocus() {
    if (config.triggerOnFocus) {
      updateSuggestions()
    }
  }

  function handleBlur() {
    setTimeout(() => {
      const state = get(autocompleteState)
      if (state.targetNode === node) {
        autocompleteState.update((s) => ({ ...s, show: false }))
      }
    }, 150)
  }

  function onKeydown(e: KeyboardEvent) {
    const state = get(autocompleteState)
    if (state.show && state.targetNode === node) {
      handleKeydown(e)
    }
  }

  node.addEventListener('input', updateSuggestions)
  node.addEventListener('focus', handleFocus)
  node.addEventListener('blur', handleBlur)
  node.addEventListener('keydown', onKeydown)

  return {
    destroy() {
      node.removeEventListener('input', updateSuggestions)
      node.removeEventListener('focus', handleFocus)
      node.removeEventListener('blur', handleBlur)
      node.removeEventListener('keydown', onKeydown)
      if (textMirror && textMirror.parentElement === document.body) {
        textMirror.remove()
        textMirror = null
      }
    }
  }
}
