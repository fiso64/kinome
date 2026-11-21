<script lang="ts">
  import {
    autocomplete,
    type AutocompleteConfig,
    getFuzzySuggestions,
    type AutocompleteItem
  } from '@lib/autocomplete-manager'
  import Icon from './Icon.svelte'

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
      return getFuzzySuggestions(suggestions, text)
    },
    onSelect: (item: AutocompleteItem, node) => {
      addGenre(item.label)
      queueMicrotask(() => (node as HTMLInputElement).focus())
    },
    triggerOnFocus: true
  }
</script>

<div class="chip-field" onclick={() => genreInputElement?.focus()}>
  {#each genres as genre, i (genre)}
    <div class="field-chip">
      {genre}
      <button
        type="button"
        class="field-chip-remove" aria-label={`Remove ${genre}`}
        onclick={(e) => {
          e.stopPropagation()
          removeGenre(i)
        }}><Icon name="close" size={14} /></button
      >
    </div>
  {/each}
  <input
    type="text"
    id="genres-input"
    class="chip-input"
    bind:this={genreInputElement}
    bind:value={currentGenreInput}
    use:autocomplete={autocompleteConfig}
    onkeydown={handleKeyDown}
    onblur={() => addGenre(currentGenreInput)}
    placeholder={genres.length === 0 ? 'e.g., Action, Sci-Fi' : ''}
    data-enter-pill="true"
  />
</div>
