<script lang="ts">
  import AutocompleteMenu from './AutocompleteMenu.svelte'
  // Types are available globally

  type SearchPill = { key: string; value: string; id: string }

  let {
    initialQuery,
    suggestions,
    onQueryChange,
    element = $bindable()
  }: {
    initialQuery?: { text: string; tags: { key: string; value: string }[] }
    suggestions: AutocompleteSuggestions
    onQueryChange: (query: { text: string; tags: { key: string; value: string }[] }) => void
    element?: HTMLInputElement
  } = $props()

  let pills = $state<SearchPill[]>(
    initialQuery?.tags.map((t) => ({ ...t, id: crypto.randomUUID() })) ?? []
  )
  let currentInput = $state(initialQuery?.text ?? '')

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

  function updateParent() {
    const tags = pills.map(({ key, value }) => ({ key, value }))
    const text = currentInput
    onQueryChange({ text, tags })
  }

  function addPill(key: string, value: string) {
    if (key && value) {
      pills.push({ key, value, id: crypto.randomUUID() })
      currentInput = ''
      pills = pills
    }
  }

  function removePill(id: string) {
    pills = pills.filter((p) => p.id !== id)
  }

  function handleInput() {
    // A pill has been completed with a space
    const tagMatch = currentInput.match(/:([a-zA-Z0-9_]+):([^:]+?)\s$/)
    if (tagMatch) {
      addPill(tagMatch[1], tagMatch[2].trim())
      updateParent()
      return
    }

    // --- Autocomplete logic ---
    const keyMatch = currentInput.match(/:([a-zA-Z0-9_]*)$/)
    const valueMatch = currentInput.match(/:([a-zA-Z0-9_]+):([^:]*)$/)

    if (valueMatch) {
      const key = valueMatch[1]
      const value = valueMatch[2]
      const source = key === 'genre' ? suggestions.genres : (suggestions.tagValues[key] ?? [])

      autocomplete.suggestions = source.filter(
        (s) =>
          s.toLowerCase().startsWith(value.toLowerCase()) && s.toLowerCase() !== value.toLowerCase()
      )
      autocomplete.type = 'value'
      autocomplete.activeKey = key
    } else if (keyMatch) {
      const key = keyMatch[1]
      const allKeys = Array.from(new Set(['genre', 'year', ...suggestions.tagKeys]))
      autocomplete.suggestions = allKeys.filter((s) =>
        s.toLowerCase().startsWith(key.toLowerCase())
      )
      autocomplete.type = 'key'
    } else {
      autocomplete.suggestions = []
    }

    if (autocomplete.suggestions.length > 0) {
      const rect = element!.getBoundingClientRect()
      autocomplete.position = { top: rect.bottom + 4, left: rect.left }
      autocomplete.show = true
    } else {
      autocomplete.show = false
    }
    updateParent()
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Backspace' && currentInput === '' && pills.length > 0) {
      pills.pop()
      pills = pills
      updateParent()
    }
  }

  function handleAutocompleteSelect(suggestion: string) {
    if (autocomplete.type === 'key') {
      currentInput = `:${suggestion}:`
    } else if (autocomplete.type === 'value') {
      currentInput = `:${autocomplete.activeKey}:${suggestion} `
      addPill(autocomplete.activeKey, suggestion)
    }
    autocomplete.show = false
    element?.focus()
    updateParent()
  }
</script>

<div class="search-box" onclick={() => element?.focus()}>
  {#each pills as pill (pill.id)}
    <div class="pill">
      <span class="pill-key">{pill.key}:</span>
      <span class="pill-value">{pill.value}</span>
      <button
        class="remove-pill"
        onclick={(e) => {
          e.stopPropagation()
          removePill(pill.id)
          updateParent()
        }}>&times;</button
      >
    </div>
  {/each}
  <input
    bind:this={element}
    bind:value={currentInput}
    oninput={handleInput}
    onkeydown={handleKeyDown}
    onblur={() => setTimeout(() => (autocomplete.show = false), 150)}
    placeholder={pills.length > 0 ? '' : 'Search or type : for tags...'}
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

<style>
  .search-box {
    -webkit-app-region: no-drag;
    width: 100%;
    max-width: 400px;
    padding: 0.3rem 0.5rem;
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    color: var(--color-text);
    border-radius: 5px;
    font-size: 1rem;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
    cursor: text;
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
