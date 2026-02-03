<script lang="ts">
  import type { AutocompleteSuggestions } from '../../../../shared/types'
  import {
    autocomplete,
    type AutocompleteConfig,
    autocompleteState,
    getFuzzySuggestions,
    type AutocompleteItem
  } from '../../lib/autocomplete-manager'

  // This constant centralizes the "special" keys that have their own suggestion lists.
  const SUGGESTION_KEYS = {
    special: ['mediaType', 'genre', 'person'],
    all: (suggestions: AutocompleteSuggestions) =>
      Array.from(
        new Set([
          'year',
          ...SUGGESTION_KEYS.special,
          ...(suggestions.tagKeys ?? []),
          ...(suggestions.virtualTagKeys ?? [])
        ])
      )
  }

  let {
    query = $bindable({ text: '', tags: [] }),
    suggestions,
    element = $bindable(),
    onfocus,
    onblur
  }: {
    query: { text: string; tags: { key: string; value: string }[] }
    suggestions: AutocompleteSuggestions
    element?: HTMLInputElement
    onfocus?: (event: FocusEvent) => void
    onblur?: (event: FocusEvent) => void
  } = $props()

  function addPill(key: string, value: string) {
    if (key && value) {
      query.tags.push({ key, value })
      query.tags = query.tags // Trigger reactivity

      const genericTagMatch = query.text.match(/:([a-zA-Z0-9_.-]+):([^:]*)$/)
      if (genericTagMatch) {
        query.text = query.text.substring(0, genericTagMatch.index).trim()
      } else {
        query.text = ''
      }
    }
  }

  function removePill(index: number) {
    query.tags.splice(index, 1)
    query.tags = query.tags
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Backspace' && query.text === '' && query.tags.length > 0) {
      removePill(query.tags.length - 1)
      return
    }

    if (e.key === 'Enter') {
      const tagMatch = query.text.match(/:([a-zA-Z0-9_.-]+):([^:]*)$/)
      if (tagMatch && tagMatch[2].trim() !== '') {
        e.preventDefault()
        addPill(tagMatch[1], tagMatch[2].trim())
      }
    }
  }

  const autocompleteConfig: AutocompleteConfig = {
    getSuggestions: (text, cursorPos) => {
      const textUpToCursor = text.substring(0, cursorPos)
      const keyMatch = textUpToCursor.match(/:([a-zA-Z0-9_.-]*)$/)
      const valueMatch = textUpToCursor.match(/:([a-zA-Z0-9_.-]+):([^:]*)$/)

      if (valueMatch) {
        const key = valueMatch[1]
        const value = valueMatch[2]
        const sourceMap: Record<string, string[]> = {
          mediaType: suggestions.mediaTypes ?? [],
          genre: suggestions.genres ?? [],
          person: suggestions.persons ?? []
        }
        const source = sourceMap[key] ?? suggestions.tagValues?.[key] ?? []
        return getFuzzySuggestions(source, value)
      } else if (keyMatch) {
        const key = keyMatch[1]
        const allKeys = SUGGESTION_KEYS.all(suggestions)
        return getFuzzySuggestions(allKeys, key)
      }
      return []
    },
    onSelect: (item: AutocompleteItem, node: HTMLElement) => {
      const input = node as HTMLInputElement
      const suggestion = item.label
      const textUpToCursor = input.value.substring(0, input.selectionStart ?? 0)
      const keyMatch = textUpToCursor.match(/:([a-zA-Z0-9_.-]*)$/)
      const valueMatch = textUpToCursor.match(/:([a-zA-Z0-9_.-]+):([^:]*)$/)

      if (valueMatch) {
        // Value selected
        addPill(valueMatch[1], suggestion)
        // Hide menu after pill is added, as the text is now gone.
        autocompleteState.update((s) => ({ ...s, show: false }))
      } else if (keyMatch) {
        // Key selected
        const textBefore = input.value.substring(0, keyMatch.index)
        const textAfter = input.value.substring(input.selectionStart ?? 0)
        query.text = `${textBefore}:${suggestion}:${textAfter}`
        queueMicrotask(() => {
          const newCursorPos = (textBefore + `:${suggestion}:`).length
          input.focus()
          input.setSelectionRange(newCursorPos, newCursorPos)
        })
      }
    }
  }
</script>

<div class="search-input-wrapper">
  <div class="search-box" onclick={() => element?.focus()}>
    {#each query.tags as tag, i (i)}
      <div class="pill">
        <span class="pill-key">{tag.key}:</span>
        <span class="pill-value">{tag.value}</span>
        <button
          class="remove-pill"
          onclick={(e) => {
            e.stopPropagation()
            removePill(i)
          }}>&times;</button
        >
      </div>
    {/each}
    <input
      bind:this={element}
      bind:value={query.text}
      oninput={(e) => {
        // Correcting the oninput handler to update query.text
        query.text = (e.target as HTMLInputElement).value
        console.log('[SearchInput] oninput updated query.text to:', query.text)
      }}
      onkeydown={handleKeyDown}
      placeholder={query.tags.length > 0 ? '' : 'Search or type : for tags...'}
      class="search-input-field"
      aria-label="Search current folder"
      {onfocus}
      {onblur}
    />
  </div>
</div>

<style>
  .search-input-wrapper {
    position: relative;
    width: 100%;
    /* min/max width is now handled by the parent grid container in App.svelte */
  }

  .search-box {
    -webkit-app-region: no-drag;
    width: 100%;
    padding: 0.3rem 0.5rem;
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    color: var(--color-text);
    border-radius: 5px;
    font-size: 1rem;
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 0.4rem;
    cursor: text;
    overflow-x: auto;
  }

  .search-box::-webkit-scrollbar {
    height: 3px;
  }
  .search-box::-webkit-scrollbar-track {
    background: transparent;
  }
  .search-box::-webkit-scrollbar-thumb {
    background-color: var(--ev-c-gray-3);
    border-radius: 3px;
  }
  .search-box::-webkit-scrollbar-thumb:hover {
    background-color: var(--ev-c-gray-2);
  }
  .search-box:focus-within {
    border-color: var(--ev-c-gray-1);
  }

  .pill {
    display: inline-flex;
    align-items: center;
    background-color: var(--ev-c-gray-3);
    padding: 0.1rem 0.3rem 0.1rem 0.6rem;
    border-radius: 12px;
    font-size: 0.9rem;
    cursor: default;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .pill-key {
    color: var(--ev-c-text-2);
    margin-right: 2px;
  }

  .pill-value {
    font-weight: 600;
  }

  .remove-pill {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--ev-c-text-2);
    cursor: pointer;
    font-size: 1.2rem;
    padding: 0 0 0 0.3rem;
    line-height: 1;
    border-radius: 50%;
    width: 1.2rem;
    height: 1.2rem;
    transition: color 0.2s;
  }
  .remove-pill:hover {
    color: var(--ev-c-text-1);
  }

  .search-input-field {
    flex-grow: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--color-text);
    padding: 0.2rem 0.4rem;
    min-width: 150px;
    font-size: 1rem;
    font-weight: 600;
  }
</style>
