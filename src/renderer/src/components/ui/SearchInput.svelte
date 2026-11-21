<script lang="ts">
  import { getMetadataSearchField, METADATA_SEARCH_KEYS } from '@shared/metadata-fields'
  import { getMetadataSuggestions } from '@lib/metadata-autocomplete'
  import type { AutocompleteSuggestions } from '@shared/types'
  import {
    autocomplete,
    type AutocompleteConfig,
    autocompleteState,
    getFuzzySuggestions,
    type AutocompleteItem
  } from '@lib/autocomplete-manager'
  import Icon from './Icon.svelte'

  let {
    query = $bindable({ text: '', tags: [] }),
    suggestions,
    label = 'Search library',
    element = $bindable(),
    onfocus,
    onblur
  }: {
    query: { text: string; tags: { key: string; value: string }[] }
    label?: string
    suggestions: AutocompleteSuggestions
    element?: HTMLInputElement
    onfocus?: (event: FocusEvent) => void
    onblur?: (event: FocusEvent) => void
  } = $props()

  function addPill(key: string, value: string) {
    if (key && value) {
      query.tags.push({ key, value })
      query.tags = query.tags // Trigger reactivity

      const genericTagMatch = query.text.match(/>([a-zA-Z0-9_.-]+):([^:]*)$/)
      if (genericTagMatch) {
        query.text = query.text.substring(0, genericTagMatch.index).trim()
      } else {
        query.text = ''
      }
      autocompleteState.update((s) => ({ ...s, show: false }))
    }
  }

  function removePill(index: number) {
    query.tags.splice(index, 1)
    query.tags = query.tags
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.defaultPrevented) return

    if (e.key === 'Backspace' && query.text === '' && query.tags.length > 0) {
      removePill(query.tags.length - 1)
      return
    }

    if (e.key === 'Enter') {
      const tagMatch = query.text.match(/>([a-zA-Z0-9_.-]+):([^:]*)$/)
      if (tagMatch && tagMatch[2].trim() !== '') {
        e.preventDefault()
        addPill(tagMatch[1], tagMatch[2].trim())
      }
    }
  }

  const autocompleteConfig: AutocompleteConfig = {
    debounceMs: 50,
    getSuggestions: async (text, cursorPos) => {
      const textUpToCursor = text.substring(0, cursorPos)
      const keyMatch = textUpToCursor.match(/>([a-zA-Z0-9_.-]*)$/)
      const valueMatch = textUpToCursor.match(/>([a-zA-Z0-9_.-]+):([^:]*)$/)

      if (valueMatch) {
        const key = valueMatch[1]
        const value = valueMatch[2]

        const field = getMetadataSearchField(key)
        const values = field
          ? await getMetadataSuggestions(field, value, suggestions)
          : suggestions.tags?.[key] ?? suggestions.virtualTags?.[key] ?? []
        return getFuzzySuggestions(values, value)
      } else if (keyMatch) {
        const keys = [...new Set([
          ...METADATA_SEARCH_KEYS,
          ...Object.keys(suggestions.tags ?? {}),
          ...Object.keys(suggestions.virtualTags ?? {})
        ])]
        return getFuzzySuggestions(keys, keyMatch[1])
      }
      return []
    },
    onSelect: (item: AutocompleteItem, node: HTMLElement) => {
      const input = node as HTMLInputElement
      const suggestion = item.label
      const textUpToCursor = input.value.substring(0, input.selectionStart ?? 0)
      const keyMatch = textUpToCursor.match(/>([a-zA-Z0-9_.-]*)$/)
      const valueMatch = textUpToCursor.match(/>([a-zA-Z0-9_.-]+):([^:]*)$/)

      if (valueMatch) {
        addPill(valueMatch[1], suggestion)
      } else if (keyMatch) {
        // Key selected
        const textBefore = input.value.substring(0, keyMatch.index)
        const textAfter = input.value.substring(input.selectionStart ?? 0)
        query.text = `${textBefore}>${suggestion}:${textAfter}`
        queueMicrotask(() => {
          const newCursorPos = (textBefore + `>${suggestion}:`).length
          input.focus()
          input.setSelectionRange(newCursorPos, newCursorPos)
        })
      }
    }
  }
</script>

<div class="search-input-wrapper">
  <div class="chip-field" onclick={() => element?.focus()}>
    {#each query.tags as tag, i (i)}
      <div class="field-chip">
        <span class="field-chip-key">{tag.key}:</span>
        <span class="field-chip-value">{tag.value}</span>
        <button
          type="button" class="field-chip-remove" aria-label={`Remove ${tag.key + ': '+ tag.value}`}
          onclick={(e) => {
            e.stopPropagation()
            removePill(i)
          }}><Icon name="close" size={14} /></button
        >
      </div>
    {/each}
    <input
      bind:this={element}
      bind:value={query.text}
      use:autocomplete={autocompleteConfig}
      onkeydown={handleKeyDown}
      placeholder={query.tags.length > 0 ? '' : 'Search or type > for tags'}
      class="chip-input"
      aria-label={label}
      {onfocus}
      {onblur}
    />
  </div>
</div>
