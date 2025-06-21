<script lang="ts">
  import { autocomplete, type AutocompleteConfig } from '../../lib/autocomplete-manager'

  let { genres = $bindable(), suggestions }: { genres: string[]; suggestions: string[] } = $props()

  let currentGenreInput = $state('')
  let genreInputElement: HTMLInputElement

  function addGenre(newGenre: string) {
    const trimmed = newGenre.trim()
    if (trimmed && !genres.includes(trimmed)) {
      genres = [...genres, trimmed]
    }
    currentGenreInput = ''
  }

  function removeGenre(index: number) {
    genres.splice(index, 1)
    genres = genres
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      addGenre(currentGenreInput)
    } else if (event.key === 'Backspace' && currentGenreInput === '' && genres.length > 0) {
      event.preventDefault()
      removeGenre(genres.length - 1)
    }
  }

  const autocompleteConfig: AutocompleteConfig = {
    getSuggestions: (text) => {
      const currentTerm = text.trim()
      if (!currentTerm) return suggestions // Show all on focus
      return suggestions.filter((s) => s.toLowerCase().startsWith(currentTerm.toLowerCase()))
    },
    onSelect: (suggestion, node) => {
      addGenre(suggestion)
      queueMicrotask(() => node.focus())
    },
    triggerOnFocus: true
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
          e.stopPropagation()
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
    use:autocomplete={autocompleteConfig}
    onkeydown={handleKeyDown}
    onblur={() => addGenre(currentGenreInput)}
    placeholder={genres.length === 0 ? 'e.g., Action, Sci-Fi' : ''}
    data-enter-pill="true"
  />
</div>

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
