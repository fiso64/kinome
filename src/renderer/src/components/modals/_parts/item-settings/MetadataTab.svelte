<script lang="ts">
  import type { LocalMedia } from '@shared/local-media'
  import TmdbMetadataSummary from '@components/ui/TmdbMetadataSummary.svelte'
  import type { TmdbMetadata } from '@shared/metadata-fields'
  import GenreInput from '@ui/GenreInput.svelte'
  import TagInput from '@ui/TagInput.svelte'
  import type { LibraryItem, AutocompleteSuggestions } from '@shared/types'

  let {
    item,
    readOnly,
    tmdbMetadata,
    localMedia,
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
    readOnly: boolean
    tmdbMetadata?: TmdbMetadata | null
    localMedia?: LocalMedia | null
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

<div class="form-stack" class:read-only={readOnly}>
  {#if readOnly}
    <p class="form-hint">Only accounts with permission to edit the library can change metadata.</p>
  {/if}
  <div class="form-field">
    <label for="filename">{item.type === 'folder' ? 'Folder Name' : 'Filename'}</label>
    <input type="text" id="filename" value={item.name} readonly class="readonly-input" />
  </div>

  <div class="form-row">
    <div class="form-field title-field">
      <label for="title">Title</label>
      <input type="text" id="title" bind:value={title} readonly={readOnly} placeholder={item.name} />
    </div>
    <div class="form-field">
      <div class="media-type-group">
        <div class="form-field compact-field">
          <label for="media-type">Type</label>
          <select id="media-type" bind:value={mediaType} disabled={readOnly}>
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
          <div class="form-field compact-field">
            <label for="season-number">Season</label>
            <input
              id="season-number"
              type="number"
              bind:value={seasonNumber} readonly={readOnly}
              class="number-input"
              min="0"
            />
          </div>
        {/if}
        {#if mediaType === 'episode' && item.type === 'file'}
          <div class="form-field compact-field">
            <label for="episode-season-number">Season</label>
            <input
              id="episode-season-number"
              type="number"
              bind:value={episodeSeasonNumber} readonly={readOnly}
              class="number-input"
              min="0"
            />
          </div>
          <div class="form-field compact-field">
            <label for="episode-number">Episode</label>
            <input
              id="episode-number"
              type="number"
              bind:value={episodeNumber} readonly={readOnly}
              class="number-input"
              min="1"
              step="0.1"
            />
          </div>
        {/if}
      </div>
    </div>
  </div>
  <div class="form-field">
    <label for="year">Year</label>
    <input type="text" id="year" bind:value={year} readonly={readOnly} />
  </div>
  <div class="form-field">
    <label for="overview">Overview</label>
    <textarea id="overview" bind:value={overview} readonly={readOnly} rows="5"></textarea>
  </div>
  <fieldset class="tag-fields" disabled={readOnly}>
    <div class="form-field">
      <label for="genres-input">Genres</label>
      <GenreInput bind:genres suggestions={suggestions.genre} />
    </div>

    <div class="form-field">
      <h3>Custom tags</h3>
      <TagInput bind:tags {suggestions} />
    </div>
  </fieldset>

  {#if localMedia}
    <section class="metadata-summary raised-surface">
      <h3>File metadata</h3>
      <dl class="metadata-facts">
        {#if localMedia.container}
          <dt>Container</dt><dd>{localMedia.container}</dd>
        {/if}
        {#if localMedia.durationSeconds}
          {@const seconds = Math.round(localMedia.durationSeconds)}
          <dt>Duration</dt><dd>{Math.floor(seconds / 60)}m {seconds % 60}s</dd>
        {/if}
        {#if localMedia.bitrate}
          <dt>Bitrate</dt><dd>{Math.round(localMedia.bitrate / 1000)} kb/s</dd>
        {/if}
        {#if localMedia.encoder}
          <dt>Encoder</dt><dd>{localMedia.encoder}</dd>
        {/if}
        {#each localMedia.tracks as track (track.index)}
          <dt>{track.kind[0].toUpperCase() + track.kind.slice(1)} #{track.index}</dt>
          <dd>
            {[
              track.codec, track.profile, track.width && track.height && `${track.width} x ${track.height}`,
              track.channelLayout ?? (track.channels && `${track.channels} channels`),
              track.pixelFormat, track.sampleRate && `${track.sampleRate} Hz`, track.bitrate && `${Math.round(track.bitrate / 1000)} kb/s`,
              track.language, track.title, track.encoder !== localMedia.encoder && track.encoder,
              track.default && 'Default', track.forced && 'Forced', track.hearingImpaired && 'Hearing impaired'
            ].filter(Boolean).join(', ')}
          </dd>
        {/each}
      </dl>
    </section>
  {/if}

  {#if tmdbMetadata}
    <section class="metadata-summary raised-surface">
      <h3>TMDB metadata</h3>
      <TmdbMetadataSummary metadata={tmdbMetadata} tmdbId={item.tmdbId} mediaType={item.mediaType} />
    </section>
  {/if}
</div>

<style>
  .form-row, .media-type-group { display: flex; flex-wrap: wrap; align-items: end; gap: .55rem; }
  .title-field { flex: 1 0 min(12rem, 100%); }
  .compact-field .number-input { width: 5rem; }
  .tag-fields { display: grid; gap: .75rem; min-width: 0; margin: 0; padding: 0; border: 0; }
  .read-only :is(input, textarea)[readonly]:not(.readonly-input) { opacity: .65; cursor: text; }
  .readonly-input { color: var(--color-text-soft); cursor: text; }
  #year { width: min(100%, 7rem); }
  textarea { min-height: 6rem; resize: vertical; }
  .metadata-summary { display: grid; gap: .6rem; padding: .75rem; user-select: text; }
  h3 { font-size: .92rem; font-weight: 670; }
  .metadata-facts {
    display: grid;
    grid-template-columns: minmax(0, 9rem) minmax(0, 1fr);
    align-items: start;
    gap: .42rem .7rem;
    font-size: .86rem;
  }
  .metadata-facts dt { color: var(--color-text-soft); }
  .metadata-facts dd { overflow-wrap: anywhere; }
  @media (max-width: 480px) {
    .metadata-facts { grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); font-size: .82rem; }
  }
</style>
