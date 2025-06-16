<script lang="ts">
  import GenreInput from './GenreInput.svelte'
  import TagInput from './TagInput.svelte'
  import ModalWindow from './ModalWindow.svelte'

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

<ModalWindow title="Edit Metadata" {onClose} onSave={handleSave} maxWidth="700px">
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
</ModalWindow>

<style>
  .form-row {
    display: flex;
    gap: 1rem;
    align-items: flex-end; /* Aligns the bottom of the form elements */
  }
  .form-row .form-group {
    margin-bottom: 0; /* Override default margin if any */
  }
  .scroll-area {
    padding: 0 1.5rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
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
  .divider {
    border-bottom: 1px solid var(--color-background-mute);
    margin: -0.5rem 0;
  }
</style>
