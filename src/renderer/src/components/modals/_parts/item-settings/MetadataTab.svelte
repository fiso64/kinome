<script lang="ts">
  import type { TmdbMetadata } from '@shared/metadata-fields'
  import GenreInput from '@ui/GenreInput.svelte'
  import TagInput from '@ui/TagInput.svelte'
  import type { LibraryItem, AutocompleteSuggestions } from '@shared/types'

  let {
    item,
    tmdbMetadata,
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
    tmdbMetadata?: TmdbMetadata | null
    title: string
    year: string
    mediaType: 'movie' | 'tv' | 'season' | 'episode' | null
    overview: string
    genres: string[]
    tags: { id: string; key: string; value: string }[]
    seasonNumber: string
    episodeNumber: number | undefined
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
            <option value={null}>Unknown</option>
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
              step="0.1"
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

  <div class="form-group">
    <h3>Custom Tags</h3>
    <TagInput bind:tags {suggestions} />
  </div>

  {#if tmdbMetadata}
    {@const score = tmdbMetadata.tmdbRating}
    {@const facts = [
      ['Status', tmdbMetadata.status],
      ['US content rating', tmdbMetadata.contentRating],
      ['TMDB score', score == null ? undefined : `${score.toFixed(1)}/10 (${tmdbMetadata.tmdbVoteCount} votes)`],
      ['Next air date', tmdbMetadata.nextAirDate],
      ['In production', tmdbMetadata.inProduction === undefined ? undefined : tmdbMetadata.inProduction ? 'Yes' : 'No'],
      ['Production companies', tmdbMetadata.studios?.join(', ')],
      ['TV networks', tmdbMetadata.networks?.join(', ')],
      ['Production countries', tmdbMetadata.productionCountries?.join(', ')],
      ['Original language', tmdbMetadata.originalLanguage]
    ].filter(([, value]) => value)}
    <section class="tmdb-summary">
      <h3>TMDB metadata</h3>
      <dl class="tmdb-facts">
        {#each facts as [label, value] (label)}
          <dt>{label}</dt>
          <dd>{value}</dd>
        {/each}
        {#if tmdbMetadata.imdbId}
          <dt>IMDb</dt>
          <dd>
            <a href={`https://www.imdb.com/title/${tmdbMetadata.imdbId}/`} target="_blank" rel="noopener noreferrer">
              {tmdbMetadata.imdbId}
            </a>
          </dd>
        {/if}
        {#if tmdbMetadata.homepage}
          <dt>Website</dt>
          <dd><a href={tmdbMetadata.homepage} target="_blank" rel="noopener noreferrer">Official website</a></dd>
        {/if}
        {#if item.tmdbId && (item.mediaType === 'tv' || item.mediaType === 'movie')}
          <dt>TMDB</dt>
          <dd>
            <a href={`https://www.themoviedb.org/${item.mediaType}/${item.tmdbId}`} target="_blank" rel="noopener noreferrer">
              View on TMDB
            </a>
          </dd>
        {/if}
      </dl>
    </section>
  {/if}
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
  .tmdb-summary {
    display: grid;
    gap: 0.75rem;
    border-top: 1px solid var(--color-border);
    padding-top: 1rem;
    user-select: text;
  }
  .tmdb-facts {
    display: grid;
    grid-template-columns: minmax(0, 9.5rem) minmax(0, 1fr);
    gap: 0.45rem 1rem;
    font-size: 0.9rem;
    line-height: 1.5;
    margin: 0;
  }
  .tmdb-facts dt {
    color: var(--color-text-soft);
  }
  .tmdb-facts a {
    color: var(--color-primary-soft);
    text-underline-offset: 0.2em;
  }
  .tmdb-facts dd {
    margin: 0;
    overflow-wrap: anywhere;
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
