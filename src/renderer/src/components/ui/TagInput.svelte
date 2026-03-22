<script lang="ts">
  import type { AutocompleteSuggestions } from '@shared/types'
  import {
    autocomplete,
    type AutocompleteConfig,
    getFuzzySuggestions,
    type AutocompleteItem
  } from '@lib/autocomplete-manager'

  import { api } from '@lib/api'
  import IconX from './IconX.svelte'

  type Tag = { id: string; key: string; value: string }

  let { tags = $bindable(), suggestions }: { tags: Tag[]; suggestions: AutocompleteSuggestions } =
    $props()

  let currentInput = $state('')
  let inputElement: HTMLInputElement

  function addTag(key: string, value: string) {
    const trimmedKey = key.trim()
    const trimmedValue = value.trim()
    if (trimmedKey && trimmedValue) {
      tags = [...tags, { id: crypto.randomUUID(), key: trimmedKey, value: trimmedValue }]
    }
    currentInput = ''
  }

  function removeTag(id: string) {
    tags = tags.filter((t) => t.id !== id)
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      const [key, ...valueParts] = currentInput.split(':')
      addTag(key, valueParts.join(':'))
    } else if (e.key === 'Backspace' && currentInput === '' && tags.length > 0) {
      e.preventDefault()
      const lastTag = tags[tags.length - 1]
      currentInput = `${lastTag.key}:${lastTag.value}`
      removeTag(lastTag.id)
    }
  }

  const autocompleteConfig: AutocompleteConfig = {
    debounceMs: 50,
    getSuggestions: async (text) => {
      const colonIndex = text.indexOf(':')

      if (colonIndex === -1) {
        // Key context
        const key = text.trim()
        const allKeys = Object.keys(suggestions.tags ?? {})
        return getFuzzySuggestions(allKeys, key)
      } else {
        // Value context
        const key = text.substring(0, colonIndex).trim()
        const value = text.substring(colonIndex + 1).trimStart()

        if (key === 'person') {
          const results = await api.getAutocompleteValues('person', value)
          return getFuzzySuggestions(results, value)
        }

        const source =
          key === 'genre'
            ? suggestions.genre
            : key === 'mediaType'
              ? suggestions.mediaType
              : (suggestions.tags?.[key] ?? [])
        return getFuzzySuggestions(source, value)
      }
    },
    onSelect: (item: AutocompleteItem, node: HTMLElement) => {
      const input = node as HTMLInputElement
      const suggestion = item.label
      const text = input.value
      const colonIndex = text.indexOf(':')

      if (colonIndex === -1) {
        // Key selected
        currentInput = `${suggestion}:`
      } else {
        // Value selected
        const key = text.substring(0, colonIndex).trim()
        addTag(key, suggestion)
      }
      queueMicrotask(() => input.focus())
    },
    triggerOnFocus: true
  }
</script>

<div class="pills-input-container" onclick={() => inputElement?.focus()}>
  {#each tags as tag (tag.id)}
    <div class="pill">
      <span class="pill-key">{tag.key}:</span>
      <span class="pill-value">{tag.value}</span>
      <button
        type="button"
        class="remove-pill"
        onclick={(e) => {
          e.stopPropagation()
          removeTag(tag.id)
        }}><IconX /></button
      >
    </div>
  {/each}
  <input
    type="text"
    class="pills-input-field"
    bind:this={inputElement}
    bind:value={currentInput}
    use:autocomplete={autocompleteConfig}
    onkeydown={handleKeyDown}
    onblur={() => {
      const [key, ...valueParts] = currentInput.split(':')
      addTag(key, valueParts.join(':'))
    }}
    placeholder={tags.length === 0 ? 'e.g., favorite:true' : ''}
    data-enter-pill="true"
  />
</div>

<style>
  /* --- Pills Input --- */
  .pills-input-container {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    border-radius: 4px;
    cursor: text;
  }
  .pills-input-container:focus-within {
    border-color: var(--ev-c-gray-1);
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background-color: var(--ev-c-gray-3);
    padding: 0.2rem 0.3rem 0.2rem 0.8rem;
    border-radius: 12px;
    font-size: 0.8rem;
  }
  .pill-key {
    color: var(--ev-c-text-2);
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
    padding: 0;
    border-radius: 50%;
    width: 1.1rem;
    height: 1.1rem;
    transition: background-color 0.2s;
  }
  .remove-pill:hover {
    background-color: rgba(0, 0, 0, 0.2);
    color: var(--ev-c-text-1);
  }

  .pills-input-field {
    flex-grow: 1;
    background: none;
    border: none;
    outline: none;
    padding: 0.1rem; /* Align with pill text */
    min-width: 120px;
    color: var(--color-text);
    font-family: inherit;
    font-size: 1rem;
  }
</style>
