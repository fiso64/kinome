import { writable, get } from 'svelte/store'

const SUGGESTION_LIMIT = 50

export interface AutocompleteItem {
  label: string
  matches: [number, number][] // Array of [start, end] indices for highlighting
}

export interface AutocompleteState {
  show: boolean
  suggestions: AutocompleteItem[]
  position: { top: number; left: number; inputTop: number }
  onSelect: (suggestion: AutocompleteItem) => void
  activeIndex: number
  targetNode: HTMLElement | null
}

export const autocompleteState = writable<AutocompleteState>({
  show: false,
  suggestions: [],
  position: { top: 0, left: 0, inputTop: 0 },
  onSelect: () => { },
  activeIndex: 0,
  targetNode: null
})

// Action configuration
export interface AutocompleteConfig {
  getSuggestions: (text: string, cursorPosition: number) => AutocompleteItem[]
  onSelect: (suggestion: AutocompleteItem, node: HTMLElement) => void
  triggerOnFocus?: boolean
}

/**
 * Fuzzy matching utility that prioritizes "starts with" and ranks by match index.
 * Returns AutocompleteItem with highlight segments.
 */
export function getFuzzySuggestions(items: string[], query: string): AutocompleteItem[] {
  const lowerQuery = query.toLowerCase().trim()

  if (!lowerQuery) {
    return items.map((item) => ({ label: item, matches: [] }))
  }

  const results: { item: string; index: number; score: number }[] = []

  for (const item of items) {
    const lowerItem = item.toLowerCase()
    const index = lowerItem.indexOf(lowerQuery)

    if (index !== -1) {
      // Logic for ranking:
      // 1. Starts with query (score 0-1)
      // 2. Contains query (score 2+)
      let score = index === 0 ? 0 : index + 1

      // Boost for exact case match if it's start-of-word or similar?
      // For now keep it simple: lower index = better score.
      results.push({ item, index, score })
    }
  }

  // Sort by score (asc), then alphabetically
  results.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    return a.item.localeCompare(b.item)
  })

  return results.map((res) => ({
    label: res.item,
    matches: [[res.index, res.index + lowerQuery.length]]
  }))
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
