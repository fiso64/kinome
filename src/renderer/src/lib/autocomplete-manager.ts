import { writable, get } from 'svelte/store'

const SUGGESTION_LIMIT = 50

export interface AutocompleteItem {
  label: string
  matches: [number, number][] // Array of [start, end] indices for highlighting
}

export interface AutocompleteState {
  show: boolean
  loading: boolean
  suggestions: AutocompleteItem[]
  position: { top: number; left: number; inputTop: number }
  onSelect: (suggestion: AutocompleteItem) => void
  activeIndex: number
  targetNode: HTMLElement | null
}

export const autocompleteState = writable<AutocompleteState>({
  show: false,
  loading: false,
  suggestions: [],
  position: { top: 0, left: 0, inputTop: 0 },
  onSelect: () => {},
  activeIndex: 0,
  targetNode: null
})

// Action configuration
export interface AutocompleteConfig {
  getSuggestions: (
    text: string,
    cursorPosition: number
  ) => AutocompleteItem[] | Promise<AutocompleteItem[]>
  onSelect: (suggestion: AutocompleteItem, node: HTMLElement) => void
  triggerOnFocus?: boolean
  debounceMs?: number
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

/**
 * Capture-phase window listener — runs before the modal's own capture listener,
 * so calling preventDefault here is enough to make the modal skip its handling.
 * This keeps the autocomplete fully self-contained; ModalWindow never needs to
 * inspect autocompleteState.
 */
function captureKeydown(event: KeyboardEvent) {
  const state = get(autocompleteState)
  if (!state.show || state.suggestions.length === 0) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    autocompleteState.update((s) => ({
      ...s,
      activeIndex: (s.activeIndex + 1) % s.suggestions.length
    }))
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    autocompleteState.update((s) => ({
      ...s,
      activeIndex: (s.activeIndex - 1 + s.suggestions.length) % s.suggestions.length
    }))
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault()
    state.onSelect(state.suggestions[state.activeIndex])
  } else if (event.key === 'Escape') {
    event.preventDefault()
    autocompleteState.update((s) => ({ ...s, show: false }))
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', captureKeydown, true)
}

function calculatePosition(node: HTMLElement, text: string, cursorPos: number) {
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

  return {
    top: nodeRect.bottom + 4,
    left: caretLeft,
    inputTop: nodeRect.top
  }
}

export function autocomplete(
  node: HTMLInputElement | HTMLTextAreaElement,
  config: AutocompleteConfig
) {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let currentRequestId = 0

  async function updateSuggestions() {
    const text = node.value
    const cursorPos = node.selectionStart ?? 0
    const requestId = ++currentRequestId

    const runUpdate = async () => {
      // If it's potentially async, show loading if it's not immediate
      let isImmediate = true
      const rawResult = config.getSuggestions(text, cursorPos)

      if (rawResult instanceof Promise) {
        isImmediate = false
        const position = calculatePosition(node, text, cursorPos)
        autocompleteState.update((s) => ({
          ...s,
          loading: true,
          show: true,
          position,
          targetNode: node
        }))
      }

      try {
        const rawSuggestions = await rawResult
        // Only update if this is still the latest request
        if (requestId !== currentRequestId) return

        const suggestions = rawSuggestions.slice(0, SUGGESTION_LIMIT)

        if (suggestions.length > 0) {
          const position = calculatePosition(node, text, cursorPos)

          const wrappedOnSelect = (suggestion: AutocompleteItem) => {
            config.onSelect(suggestion, node)
            queueMicrotask(() => {
              updateSuggestions()
            })
          }

          autocompleteState.set({
            show: true,
            loading: false,
            suggestions,
            position,
            onSelect: wrappedOnSelect,
            activeIndex: 0,
            targetNode: node
          })
        } else {
          autocompleteState.update((s) =>
            s.targetNode === node ? { ...s, show: false, loading: false } : s
          )
        }
      } catch (e) {
        if (requestId === currentRequestId) {
          autocompleteState.update((s) =>
            s.targetNode === node ? { ...s, show: false, loading: false } : s
          )
        }
      }
    }

    if (config.debounceMs && config.debounceMs > 0) {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(runUpdate, config.debounceMs)
    } else {
      await runUpdate()
    }
  }

  function handleFocus() {
    if (config.triggerOnFocus) {
      updateSuggestions()
    }
  }

  function handleBlur() {
    // A small delay is still helpful for event ordering, but we'll
    // also use document mousedown for immediate response.
    setTimeout(() => {
      const state = get(autocompleteState)
      if (state.targetNode === node) {
        autocompleteState.update((s) => ({ ...s, show: false }))
      }
    }, 100)
  }

  // Handle clicking elsewhere to close immediately
  function onDocumentMousedown(e: MouseEvent) {
    const state = get(autocompleteState)
    if (!state.show || state.targetNode !== node) return

    const menu = document.querySelector('.autocomplete-menu')
    if (menu?.contains(e.target as Node) || node.contains(e.target as Node)) {
      return
    }

    autocompleteState.update((s) => ({ ...s, show: false }))
  }

  node.addEventListener('input', updateSuggestions)
  node.addEventListener('focus', handleFocus)
  node.addEventListener('blur', handleBlur)
  document.addEventListener('mousedown', onDocumentMousedown)

  return {
    destroy() {
      node.removeEventListener('input', updateSuggestions)
      node.removeEventListener('focus', handleFocus)
      node.removeEventListener('blur', handleBlur)
      document.removeEventListener('mousedown', onDocumentMousedown)

      // Close the menu if this node was the one that opened it
      autocompleteState.update((s) => (s.targetNode === node ? { ...s, show: false } : s))

      if (textMirror && textMirror.parentElement === document.body) {
        textMirror.remove()
        textMirror = null
      }
    }
  }
}
