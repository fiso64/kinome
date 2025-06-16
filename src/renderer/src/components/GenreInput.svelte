<script lang="ts">
  import AutocompleteMenu from './AutocompleteMenu.svelte'

  let { genres = $bindable(), suggestions }: { genres: string[]; suggestions: string[] } = $props()

  let currentGenreInput = $state('')
  let genreInputElement: HTMLInputElement
  let showAutocomplete = $state(false)
  let autocompleteSuggestions = $state<string[]>([])
  let autocompletePosition = $state({ top: 0, left: 0 })

  function addGenreFromInput() {
    const newGenre = currentGenreInput.trim()
    if (newGenre && !genres.includes(newGenre)) {
      genres = [...genres, newGenre]
    }
    currentGenreInput = ''
    showAutocomplete = false
  }

  function removeGenre(index: number) {
    genres.splice(index, 1)
    genres = genres
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      addGenreFromInput()
    } else if (event.key === 'Backspace' && currentGenreInput === '' && genres.length > 0) {
      event.preventDefault()
      genres.pop()
      genres = genres
    }
  }

  function handleInput() {
    const currentTerm = currentGenreInput.trim()
    if (!currentTerm) {
      showAutocomplete = false
      return
    }

    const filtered = suggestions.filter(
      (s) => s.toLowerCase().startsWith(currentTerm.toLowerCase()) && s !== currentTerm
    )

    if (filtered.length > 0) {
      autocompleteSuggestions = filtered
      const rect = genreInputElement.getBoundingClientRect()
      autocompletePosition = { top: rect.bottom + 4, left: rect.left }
      showAutocomplete = true
    } else {
      showAutocomplete = false
    }
  }

  function handleAutocompleteSelect(suggestion: string) {
    if (!genres.includes(suggestion)) {
      genres = [...genres, suggestion]
    }
    currentGenreInput = ''
    showAutocomplete = false
    queueMicrotask(() => genreInputElement.focus())
  }
</script>

<div class="pills-input-container" onclick={() => genreInputElement?.focus()}>
  {#each genres as genre, i (genre)}
    <div class="pill">
      {genre}
      <button
        type="button"
        class="remove-pill"
        onclick={(e) => {
          e.stopPropagation() // prevent container click
          removeGenre(i)
        }}>&times;</button
      >
    </div>
  {/each}
  <input
    type="text"
    id="genres-input"
    class="pills-input-field"
    bind:this={genreInputElement}
    bind:value={currentGenreInput}
    oninput={handleInput}
    onblur={() => setTimeout(() => (showAutocomplete = false), 150)}
    onkeydown={handleKeyDown}
    placeholder={genres.length === 0 ? 'e.g., Action, Sci-Fi' : ''}
  />
</div>

{#if showAutocomplete}
  <AutocompleteMenu
    suggestions={autocompleteSuggestions}
    position={autocompletePosition}
    onSelect={handleAutocompleteSelect}
    onClose={() => (showAutocomplete = false)}
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
    background-color: rgba(255, 255, 255, 0.1);
    padding: 0.2rem 0.3rem 0.2rem 0.8rem;
    border-radius: 12px;
    font-size: 0.8rem;
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
