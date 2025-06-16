<script lang="ts">
  import AutocompleteMenu from './AutocompleteMenu.svelte'
  // Types are globally available

  type Tag = { id: string; key: string; value: string }

  let { tags = $bindable(), suggestions }: { tags: Tag[]; suggestions: AutocompleteSuggestions } =
    $props()

  let currentInput = $state('')
  let inputElement: HTMLInputElement

  let autocomplete = $state<{
    show: boolean
    suggestions: string[]
    position: { top: number; left: number }
    type: 'key' | 'value'
    activeKey: string
  }>({
    show: false,
    suggestions: [],
    position: { top: 0, left: 0 },
    type: 'key',
    activeKey: ''
  })

  function addTagFromInput() {
    const [key, ...valueParts] = currentInput.split(':')
    const value = valueParts.join(':').trim()
    if (key.trim() && value) {
      tags = [...tags, { id: crypto.randomUUID(), key: key.trim(), value }]
    }
    currentInput = ''
    handleInput()
  }

  function removeTag(id: string) {
    tags = tags.filter((t) => t.id !== id)
  }

  function handleInput() {
    const colonIndex = currentInput.indexOf(':')

    if (colonIndex === -1) {
      // Key context
      const key = currentInput.trim()
      const allKeys = suggestions.tagKeys
      autocomplete.suggestions = allKeys.filter((s) =>
        s.toLowerCase().startsWith(key.toLowerCase())
      )
      autocomplete.type = 'key'
    } else {
      // Value context
      const key = currentInput.substring(0, colonIndex).trim()
      const value = currentInput.substring(colonIndex + 1).trimStart()
      const source = key === 'genre' ? suggestions.genres : (suggestions.tagValues[key] ?? [])

      autocomplete.suggestions = source.filter((s) =>
        s.toLowerCase().startsWith(value.toLowerCase())
      )
      autocomplete.type = 'value'
      autocomplete.activeKey = key
    }

    if (autocomplete.suggestions.length > 0) {
      const inputRect = inputElement.getBoundingClientRect()
      const modalWindow = inputElement.closest('.modal-window')
      const modalRect = modalWindow?.getBoundingClientRect() ?? { top: 0, left: 0 }

      autocomplete.position = {
        top: inputRect.bottom - modalRect.top + 4,
        left: inputRect.left - modalRect.left
      }
      autocomplete.show = true
    } else {
      autocomplete.show = false
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      addTagFromInput()
    } else if (e.key === 'Backspace' && currentInput === '' && tags.length > 0) {
      e.preventDefault()
      const lastTag = tags[tags.length - 1]
      currentInput = `${lastTag.key}:${lastTag.value}`
      removeTag(lastTag.id)
    }
  }

  function handleAutocompleteSelect(suggestion: string) {
    if (autocomplete.type === 'key') {
      currentInput = `${suggestion}:`
      handleInput()
    } else if (autocomplete.type === 'value') {
      currentInput = `${autocomplete.activeKey}:${suggestion}`
      addTagFromInput()
    }
    inputElement.focus()
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
          e.stopPropagation() // prevent container click
          removeTag(tag.id)
        }}>&times;</button
      >
    </div>
  {/each}
  <input
    type="text"
    class="pills-input-field"
    bind:this={inputElement}
    bind:value={currentInput}
    oninput={handleInput}
    onfocus={handleInput}
    onblur={() => (autocomplete.show = false)}
    onkeydown={handleKeyDown}
    placeholder={tags.length === 0 ? 'e.g., favorite:true' : ''}
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
    font-size: 1.1rem;
    padding: 0;
    line-height: 1;
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
