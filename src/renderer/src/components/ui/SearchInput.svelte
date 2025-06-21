<script lang="ts">
  import AutocompleteMenu from './AutocompleteMenu.svelte'
  // Types are available globally

  // This constant centralizes the "special" keys that have their own suggestion lists.
  const SUGGESTION_KEYS = {
    // Keys that have dedicated suggestion arrays (not from user-defined tags)
    special: ['mediaType', 'genre', 'person'],
    // All keys that can be used for autocompletion
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
    element = $bindable()
  }: {
    query: { text: string; tags: { key: string; value: string }[] }
    suggestions: AutocompleteSuggestions
    element?: HTMLInputElement
  } = $props()

  let autocomplete = $state<{
    show: boolean
    suggestions: string[]
    position: { top: number; left: number }
    type: 'key' | 'value' | null
    activeKey: string
  }>({
    show: false,
    suggestions: [],
    position: { top: 0, left: 0 },
    type: null,
    activeKey: ''
  })

  function addPill(key: string, value: string) {
    if (key && value) {
      query.tags.push({ key, value })
      query.tags = query.tags // Trigger reactivity
      query.text = ''
    }
  }

  function removePill(index: number) {
    query.tags.splice(index, 1)
    query.tags = query.tags // Trigger reactivity
  }

  function handleInput() {
    // A pill has been completed with a space
    const tagMatch = query.text.match(/:([a-zA-Z0-9_]+):([^:]+?)\s$/)
    if (tagMatch) {
      addPill(tagMatch[1], tagMatch[2].trim())
      return
    }

    // --- Autocomplete logic ---
    const keyMatch = query.text.match(/:([a-zA-Z0-9_]*)$/)
    const valueMatch = query.text.match(/:([a-zA-Z0-9_]+):([^:]*)$/)

    if (valueMatch) {
      const key = valueMatch[1]
      const value = valueMatch[2]
      // This map provides a clean, data-driven way to get suggestion sources.
      const sourceMap: Record<string, string[]> = {
        mediaType: suggestions.mediaTypes ?? [],
        genre: suggestions.genres ?? [],
        person: suggestions.persons ?? []
      }
      const source = sourceMap[key] ?? suggestions.tagValues?.[key] ?? []

      autocomplete.suggestions = source.filter((s) =>
        s.toLowerCase().startsWith(value.toLowerCase())
      )
      autocomplete.type = 'value'
      autocomplete.activeKey = key
    } else if (keyMatch) {
      const key = keyMatch[1]
      // Use the centralized constant to get all possible suggestion keys.
      const allKeys = SUGGESTION_KEYS.all(suggestions)
      autocomplete.suggestions = allKeys.filter((s) =>
        s.toLowerCase().startsWith(key.toLowerCase())
      )
      autocomplete.type = 'key'
    } else {
      autocomplete.suggestions = []
    }

    if (autocomplete.suggestions.length > 0) {
      const searchBox = element?.closest('.search-box')
      if (searchBox) {
        const rect = searchBox.getBoundingClientRect()
        autocomplete.position = { top: rect.height + 4, left: 0 }
        autocomplete.show = true
      }
    } else {
      autocomplete.show = false
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Backspace' && query.text === '' && query.tags.length > 0) {
      query.tags.pop()
      query.tags = query.tags // Trigger reactivity
    }
  }

  function handleAutocompleteSelect(suggestion: string) {
    if (autocomplete.type === 'key') {
      query.text = `:${suggestion}:`
      handleInput()
    } else if (autocomplete.type === 'value') {
      addPill(autocomplete.activeKey, suggestion)
      autocomplete.show = false
    }
    element?.focus()
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
      oninput={handleInput}
      onfocus={handleInput}
      onkeydown={handleKeyDown}
      onblur={() => (autocomplete.show = false)}
      placeholder={query.tags.length > 0 ? '' : 'Search or type : for tags...'}
      class="search-input-field"
      aria-label="Search current folder"
    />
  </div>

  {#if autocomplete.show}
    <AutocompleteMenu
      suggestions={autocomplete.suggestions}
      position={autocomplete.position}
      onSelect={handleAutocompleteSelect}
      onClose={() => (autocomplete.show = false)}
    />
  {/if}
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
