<script lang="ts">
  import GenreInput from '@ui/GenreInput.svelte'
  import TagInput from '@ui/TagInput.svelte'
  import type { LibraryItem, AutocompleteSuggestions } from '@shared/types'

  let {
    item,
    title = $bindable(),
    year = $bindable(),
    mediaType = $bindable(),
    overview = $bindable(),
    genres = $bindable(),
    tags = $bindable(),
    seasonNumber = $bindable(),
    episodeNumber = $bindable(),
    episodeSeasonNumber = $bindable(),
    suggestions
  }: {
    item: LibraryItem
    title: string
    year: string
    mediaType: 'movie' | 'tv' | 'season' | 'episode' | undefined
    overview: string
    genres: string[]
    tags: { id: string; key: string; value: string }[]
    seasonNumber: string
    episodeNumber: string
    episodeSeasonNumber: string
    suggestions: AutocompleteSuggestions
  } = $props()
</script>

<div class="content">
  <div class="form-group">
    <label for="filename">{item.type === 'folder' ? 'Folder Name' : 'Filename'}</label>
    <input type="text" id="filename" value={item.name} readonly class="readonly-input" />
  </div>

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
            <input
              id="season-number"
              type="number"
              bind:value={seasonNumber}
              class="number-input"
              min="0"
            />
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
    <GenreInput bind:genres suggestions={suggestions.genre} />
  </div>

  <div class="divider"></div>

  <h3>Custom Tags</h3>
  <div class="form-group">
    <TagInput bind:tags {suggestions} />
  </div>
</div>

<style>
  .content {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .form-row {
    display: flex;
    gap: 1rem;
    align-items: flex-end;
  }
  .form-row .form-group {
    margin-bottom: 0;
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
  .media-type-group {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
  }
  .number-input-group {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .number-input-group label {
    font-size: 0.8rem;
    font-weight: normal;
    color: var(--ev-c-text-2);
    padding-left: 2px;
  }
  .number-input {
    width: 60px;
    appearance: textfield;
    -moz-appearance: textfield; /* Firefox */
  }
  .number-input::-webkit-outer-spin-button,
  .number-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .readonly-input {
    background-color: var(--color-background-mute);
    cursor: default;
    color: var(--ev-c-text-2);
    border-color: transparent;
    opacity: 0.8;
  }
</style>
