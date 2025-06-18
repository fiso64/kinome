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
  // New state for season/episode numbers
  let seasonNumber = $state(item.type === 'folder' ? (item as MediaFolder).seasonNumber?.toString() ?? '' : '')
  let episodeNumber = $state(item.type === 'file' ? (item as MediaFile).episodeNumber?.toString() ?? '' : '')
  let episodeSeasonNumber = $state(item.type === 'file' ? (item as MediaFile).seasonNumber?.toString() ?? '' : '')


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
    const finalTitle = title.trim()
    updatedItem.title = finalTitle ? finalTitle : undefined

    const parsedYear = parseInt(year, 10)
    updatedItem.year = !isNaN(parsedYear) ? parsedYear : undefined
    updatedItem.mediaType = mediaType

    const parseOptionalInt = (val: string): number | undefined => {
      const parsed = parseInt(val, 10)
      return !isNaN(parsed) ? parsed : undefined
    }

    // Handle season/episode numbers
    if (updatedItem.type === 'folder') {
      if (mediaType === 'season') {
        ;(updatedItem as MediaFolder).seasonNumber = parseOptionalInt(seasonNumber)
      } else {
        delete (updatedItem as MediaFolder).seasonNumber
      }
    }
    if (updatedItem.type === 'file') {
      if (mediaType === 'episode') {
        ;(updatedItem as MediaFile).seasonNumber = parseOptionalInt(episodeSeasonNumber)
        ;(updatedItem as MediaFile).episodeNumber = parseOptionalInt(episodeNumber)
      } else {
        delete (updatedItem as MediaFile).seasonNumber
        delete (updatedItem as MediaFile).episodeNumber
      }
    }

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
        <input type="text" id="title" bind:value={title} placeholder={item.name} />
      </div>
      <div class="form-group">
        <div class="media-type-group">
          <div class="number-input-group">
            <label for="media-type">Type</label>
            <select id="media-type" bind:value={mediaType}>
              <option value={undefined}>Unknown</option>
              <option value="movie">Movie</option>
              <option value="tv">TV Show</option>
              {#if item.type === 'folder'}
                <option value="season">Season</option>
              {/if}
              {#if item.type === 'file'}
                <option value="episode">Episode</option>
              {/if}
            </select>
          </div>
          {#if mediaType === 'season' && item.type === 'folder'}
            <div class="number-input-group">
              <label for="season-number">Season</label>
              <input id="season-number" type="number" bind:value={seasonNumber} class="number-input" min="0" />
            </div>
          {/if}
          {#if mediaType === 'episode' && item.type === 'file'}
            <div class="number-input-group">
              <label for="episode-season-number">Season</label>
              <input
                id="episode-season-number"
                type="number"
                bind:value={episodeSeasonNumber}
                class="number-input"
                min="0"
              />
            </div>
            <div class="number-input-group">
              <label for="episode-number">Episode</label>
              <input
                id="episode-number"
                type="number"
                bind:value={episodeNumber}
                class="number-input"
                min="1"
              />
            </div>
          {/if}
        </div>
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
    /* This is the key: align the direct children (.form-group) to their bottom edge. */
    align-items: flex-end;
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
    /* justify-content is removed to allow natural stacking.
       The parent .form-row handles the vertical alignment of the whole group. */
  }
  label,
  h3 {
    font-weight: bold;
  }
  .divider {
    border-bottom: 1px solid var(--color-background-mute);
    margin: -0.5rem 0;
  }
  .media-type-group {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end; /* This correctly aligns the select and the number inputs to their bottom edge. */
  }
  .number-input-group {
    display: flex;
    flex-direction: column;
    gap: 0.2rem; /* Reduce gap to bring label closer to its input */
  }
  .number-input-group label {
    font-size: 0.8rem;
    font-weight: normal;
    color: var(--ev-c-text-2);
    padding-left: 2px;
  }
  .number-input {
    width: 60px;
    -moz-appearance: textfield; /* Firefox */
  }
  .number-input::-webkit-outer-spin-button,
  .number-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
</style>
