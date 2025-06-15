<script lang="ts">
  let { item, onClose }: { item: LibraryItem; onClose: () => void } = $props()

  // Create local reactive state for the form fields
  let title = $state(item.title ?? item.name)
  let year = $state(item.year?.toString() ?? '')
  let overview = $state(item.overview ?? '')
  let genres = $state(item.genres?.join(', ') ?? '')
  let tags = $state(
    Object.entries(item.tags ?? {}).map(([key, value]) => ({ id: crypto.randomUUID(), key, value }))
  )

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
    updatedItem.genres = genres
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean)

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
        <label for="genres">Genres</label>
        <input type="text" id="genres" bind:value={genres} placeholder="e.g., Action, Sci-Fi" />
        <p class="help-text">Comma-separated list of genres.</p>
      </div>

      <div class="divider"></div>

      <h3>Custom Tags</h3>
      <div class="tags-list">
        {#each tags as tag (tag.id)}
          <div class="tag-item">
            <input type="text" bind:value={tag.key} placeholder="Key" class="tag-key" />
            <span>:</span>
            <input type="text" bind:value={tag.value} placeholder="Value" class="tag-value" />
            <button class="remove-tag" onclick={() => removeTag(tag.id)} title="Remove Tag">
              &times;
            </button>
          </div>
        {/each}
      </div>
      <button class="secondary" onclick={addTag}>Add Tag</button>
    </div>
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
