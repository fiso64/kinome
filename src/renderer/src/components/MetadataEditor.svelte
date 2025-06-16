<script lang="ts">
  import GenreInput from './GenreInput.svelte'
  import TagInput from './TagInput.svelte'
  let { item, onClose }: { item: LibraryItem; onClose: () => void } = $props()

  // --- Form State ---
  let title = $state(item.title ?? item.name)
  let year = $state(item.year?.toString() ?? '')
  let mediaType = $state(item.mediaType)
  let overview = $state(item.overview ?? '')
  let genres = $state<string[]>(JSON.parse(JSON.stringify(item.genres ?? [])))
  let tags = $state(
    Object.entries(item.tags ?? {}).map(([key, value]) => ({ id: crypto.randomUUID(), key, value }))
  )

  // --- Autocomplete Suggestions ---
  let allSuggestions = $state<{
    genres: string[]
    tagKeys: string[]
    tagValues: Record<string, string[]>
  }>({ genres: [], tagKeys: [], tagValues: {} })

  $effect(() => {
    window.api.getAutocompleteSuggestions().then((data) => (allSuggestions = data))
  })

  // --- Form Actions ---

  async function handleSave() {
    // Create a copy to modify
    const updatedItem: LibraryItem = JSON.parse(JSON.stringify(item))

    // Apply changes from the form
    updatedItem.title = title

    const parsedYear = parseInt(year, 10)
    updatedItem.year = !isNaN(parsedYear) ? parsedYear : undefined
    updatedItem.mediaType = mediaType

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
        // Do not save if a button or textarea is the target.
        if (target.tagName !== 'BUTTON' && target.tagName !== 'TEXTAREA') {
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
  onmousedown={(e) => e.target === e.currentTarget && onClose()}
  role="dialog"
  aria-modal="true"
  tabindex="-1"
>
  <div class="modal-content">
    <h2>Edit Metadata</h2>
    <div class="scroll-area">
      <div class="form-row">
        <div class="form-group" style="flex-grow: 1;">
          <label for="title">Title</label>
          <input type="text" id="title" bind:value={title} />
        </div>
        <div class="form-group">
          <label for="media-type">Type</label>
          <select id="media-type" bind:value={mediaType}>
            <option value={undefined}>Unknown</option>
            <option value="movie">Movie</option>
            <option value="tv">TV Show</option>
          </select>
        </div>
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
      </div>

      <div class="divider"></div>

      <h3>Custom Tags</h3>
      <div class="form-group">
        <TagInput bind:tags suggestions={allSuggestions} />
      </div>
    </div>

    <div class="actions">
      <button class="secondary" onclick={onClose}>Cancel</button>
      <button class="primary" onclick={handleSave}>Save & Close</button>
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
  .form-row {
    display: flex;
    gap: 1rem;
    align-items: flex-end; /* Aligns the bottom of the form elements */
  }
  .form-row .form-group {
    margin-bottom: 0; /* Override default margin if any */
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
  textarea,
  select {
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
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 5px;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--ev-c-text-1);
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  button.primary {
    background-color: var(--ev-c-gray-2);
    color: var(--ev-c-text-1);
  }
  button.primary:hover:not(:disabled) {
    background-color: var(--ev-c-gray-1);
  }
  button.secondary {
    background-color: var(--ev-button-alt-bg);
    border: 1px solid var(--ev-c-gray-2);
  }
  button.secondary:hover:not(:disabled) {
    background-color: var(--ev-c-black-mute);
  }
  .divider {
    border-bottom: 1px solid var(--color-background-mute);
    margin: -0.5rem 0;
  }
</style>
