<script lang="ts">
  import type { AutocompleteSuggestions } from '@shared/types'
  import {
    autocomplete,
    type AutocompleteConfig,
    getFuzzySuggestions,
    type AutocompleteItem
  } from '@lib/autocomplete-manager'

  import { api } from '@lib/api'
  import Icon from './Icon.svelte'

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

<div class="chip-field" onclick={() => inputElement?.focus()}>
  {#each tags as tag (tag.id)}
    <div class="field-chip">
      <span class="field-chip-key">{tag.key}:</span>
      <span class="field-chip-value">{tag.value}</span>
      <button
        type="button"
        class="field-chip-remove" aria-label={`Remove ${tag.key + ': '+ tag.value}`}
        onclick={(e) => {
          e.stopPropagation()
          removeTag(tag.id)
        }}><Icon name="close" size={14} /></button
      >
    </div>
  {/each}
  <input
    type="text"
    aria-label="Custom tag"
    class="chip-input"
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
