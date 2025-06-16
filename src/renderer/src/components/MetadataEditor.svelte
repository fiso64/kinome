<script lang="ts">
  import AutocompleteMenu from './AutocompleteMenu.svelte'
  import GenreInput from './GenreInput.svelte'
  let { item, onClose }: { item: LibraryItem; onClose: () => void } = $props()

  // --- Form State ---
  let title = $state(item.title ?? item.name)
  let year = $state(item.year?.toString() ?? '')
  let overview = $state(item.overview ?? '')
  let genres = $state<string[]>(JSON.parse(JSON.stringify(item.genres ?? [])))
  let tags = $state(
    Object.entries(item.tags ?? {}).map(([key, value]) => ({ id: crypto.randomUUID(), key, value }))
  )

  // --- Autocomplete State (for Tags only) ---
  let allSuggestions = $state<{
    genres: string[]
    tagKeys: string[]
    tagValues: Record<string, string[]>
  }>({ genres: [], tagKeys: [], tagValues: {} })

  let showAutocomplete = $state(false)
  let autocompleteSuggestions = $state<string[]>([])
  let autocompletePosition = $state({ top: 0, left: 0 })
  let activeInput = $state<{
    element: HTMLInputElement | HTMLTextAreaElement
    type: 'tagKey' | 'tagValue'
    tagId?: string
  } | null>(null)

  $effect(() => {
    window.api.getAutocompleteSuggestions().then((data) => (allSuggestions = data))
  })

  // --- Generic Handlers (for Tags only) ---
  function handleFocus(event: FocusEvent, type: 'tagKey' | 'tagValue', tagId?: string) {
    const element = event.target as HTMLInputElement
    activeInput = { element, type, tagId }
  }

  function handleInput() {
    if (!activeInput) return

    const { element, type, tagId } = activeInput
    const value = element.value
    const cursorPosition = element.selectionStart ?? 0
    let currentTerm = ''
    let source: string[] = []

    if (type === 'tagValue') {
      const lastCommaIndex = value.lastIndexOf(',', cursorPosition - 1)
      currentTerm = value.substring(lastCommaIndex + 1, cursorPosition).trim()
      const tagKey = tags.find((t) => t.id === tagId)?.key
      source = allSuggestions.tagValues[tagKey ?? ''] ?? []
    } else {
      // type === 'tagKey'
      currentTerm = value.trim()
      source = allSuggestions.tagKeys
    }

    if (!currentTerm) {
      showAutocomplete = false
      return
    }

    const filtered = source.filter(
      (s) => s.toLowerCase().startsWith(currentTerm.toLowerCase()) && s !== currentTerm
    )

    if (filtered.length > 0) {
      autocompleteSuggestions = filtered
      const rect = element.getBoundingClientRect()
      let left = rect.left

      const textBefore = element.value.substring(0, cursorPosition)
      const mirror = document.createElement('span')
      const style = window.getComputedStyle(element)
      Object.assign(mirror.style, {
        font: style.font,
        letterSpacing: style.letterSpacing,
        visibility: 'hidden',
        position: 'absolute'
      })
      mirror.textContent = textBefore
      document.body.appendChild(mirror)
      left += mirror.offsetWidth - element.scrollLeft
      document.body.removeChild(mirror)

      autocompletePosition = { top: rect.bottom + 4, left: Math.min(left, window.innerWidth - 200) }
      showAutocomplete = true
    } else {
      showAutocomplete = false
    }
  }

  function handleAutocompleteSelect(suggestion: string) {
    if (!activeInput) return

    showAutocomplete = false
    const { element, type, tagId } = activeInput

    const value = element.value
    const cursorPosition = element.selectionStart ?? 0
    let newValue: string, newCursorPos: number

    if (type === 'tagValue') {
      const lastCommaIndex = value.lastIndexOf(',', cursorPosition - 1)
      const before = value.substring(0, lastCommaIndex + 1)
      const after = value.substring(cursorPosition)
      const prefix = before && !before.endsWith(' ') ? ' ' : ''
      newValue = before + prefix + suggestion + ', ' + after.trimStart()
      newCursorPos = (before + prefix + suggestion + ', ').length
    } else {
      // tagKey
      newValue = suggestion
      newCursorPos = newValue.length
    }

    // Update state
    if (type === 'tagKey' && tagId) {
      const tag = tags.find((t) => t.id === tagId)
      if (tag) tag.key = newValue
    } else if (type === 'tagValue' && tagId) {
      const tag = tags.find((t) => t.id === tagId)
      if (tag) tag.value = newValue
    }

    // Restore focus and de-select this input
    queueMicrotask(() => {
      element.focus()
      element.setSelectionRange(newCursorPos, newCursorPos)
    })
    activeInput = null
  }

  // --- Form Actions ---
  function addTag() {
    tags.push({ id: crypto.randomUUID(), key: '', value: '' })
    tags = tags
  }

  function removeTag(id: string) {
    tags = tags.filter((tag) => tag.id !== id)
  }

  async function handleSave() {
    // Create a copy to modify
    const updatedItem: LibraryItem = JSON.parse(JSON.stringify(item))

    // Apply changes from the form
    updatedItem.title = title

    const parsedYear = parseInt(year, 10)
    updatedItem.year = !isNaN(parsedYear) ? parsedYear : undefined

    updatedItem.overview = overview
    // Convert the reactive genres array to a plain array before sending over IPC
    updatedItem.genres = [...genres]

    updatedItem.tags = tags.reduce((acc, tag) => {
      if (tag.key) {
        acc[tag.key] = tag.value
      }
      return acc
    }, {})

    await window.api.updateItem(updatedItem)
    onClose()
  }

  $effect(() => {
    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      } else if (event.key === 'Enter') {
        const target = event.target as HTMLElement
        // Do not save if a button or textarea is the target,
        // or if the autocomplete menu is open.
        if (target.tagName !== 'BUTTON' && target.tagName !== 'TEXTAREA' && !showAutocomplete) {
          event.preventDefault()
          handleSave()
        }
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => {
      window.removeEventListener('keydown', handleKeydown)
    }
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
<div
  class="modal-backdrop"
  onclick={(e) => e.target === e.currentTarget && onClose()}
  role="dialog"
  aria-modal="true"
  tabindex="-1"
>
  <div class="modal-content">
    <h2>Edit Metadata</h2>
    <div class="scroll-area">
      <div class="form-group">
        <label for="title">Title</label>
        <input type="text" id="title" bind:value={title} />
      </div>
      <div class="form-group">
        <label for="year">Year</label>
        <input type="text" id="year" bind:value={year} />
      </div>
      <div class="form-group">
        <label for="overview">Overview</label>
        <textarea id="overview" bind:value={overview} rows="5"></textarea>
      </div>
      <div class="form-group">
        <label for="genres-input">Genres</label>
        <GenreInput bind:genres suggestions={allSuggestions.genres} />
        <p class="help-text">
          Use Comma or Enter to add a genre. Backspace on empty input removes the last one.
        </p>
      </div>

      <div class="divider"></div>

      <h3>Custom Tags</h3>
      <div class="tags-list">
        {#each tags as tag (tag.id)}
          <div class="tag-item">
            <input
              type="text"
              bind:value={tag.key}
              placeholder="Key"
              class="tag-key"
              onfocus={(e) => handleFocus(e, 'tagKey', tag.id)}
              oninput={handleInput}
              onblur={() => setTimeout(() => (showAutocomplete = false), 150)}
            />
            <span>:</span>
            <input
              type="text"
              bind:value={tag.value}
              placeholder="Value"
              class="tag-value"
              onfocus={(e) => handleFocus(e, 'tagValue', tag.id)}
              oninput={handleInput}
              onblur={() => setTimeout(() => (showAutocomplete = false), 150)}
            />
            <button class="remove-tag" onclick={() => removeTag(tag.id)} title="Remove Tag">
              &times;
            </button>
          </div>
        {/each}
      </div>
      <button class="secondary" onclick={addTag}>Add Tag</button>
    </div>

    {#if showAutocomplete && activeInput}
      <AutocompleteMenu
        suggestions={autocompleteSuggestions}
        position={autocompletePosition}
        onSelect={handleAutocompleteSelect}
        onClose={() => (showAutocomplete = false)}
      />
    {/if}

    <div class="actions">
      <button onclick={handleSave}>Save & Close</button>
      <button class="secondary" onclick={onClose}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 200;
  }
  .modal-content {
    background-color: var(--color-background-soft);
    padding: 2rem;
    border-radius: 8px;
    width: 90%;
    max-width: 700px;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-height: 90vh;
  }
  .scroll-area {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding-right: 1rem; /* for scrollbar */
    margin-right: -1rem;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  label,
  h3 {
    font-weight: bold;
  }
  input,
  textarea {
    padding: 0.5rem;
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    color: var(--color-text);
    border-radius: 4px;
    font-family: inherit;
    font-size: 1rem;
  }
  textarea {
    resize: vertical;
  }
  .help-text {
    font-size: 0.8rem;
    color: var(--ev-c-text-2);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    flex-shrink: 0;
    padding-top: 1rem;
    border-top: 1px solid var(--color-background-mute);
    margin-top: auto;
  }
  button {
    background-color: var(--ev-c-gray-3);
    color: var(--ev-c-text-1);
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 5px;
    cursor: pointer;
    font-weight: 600;
  }
  button:hover {
    background-color: var(--ev-c-gray-2);
  }
  button.secondary {
    background-color: var(--ev-button-alt-bg);
    border: 1px solid var(--ev-button-alt-border);
  }
  button.secondary:hover {
    background-color: var(--ev-button-alt-hover-bg);
  }
  .divider {
    border-bottom: 1px solid var(--color-background-mute);
    margin: -0.5rem 0;
  }

  .tags-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .tag-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .tag-key {
    flex: 1;
  }
  .tag-value {
    flex: 2;
  }
  .remove-tag {
    background: none;
    border: none;
    color: var(--ev-c-text-2);
    font-size: 1.5rem;
    padding: 0 0.5rem;
    cursor: pointer;
  }
  .remove-tag:hover {
    color: #e81123;
  }
</style>
