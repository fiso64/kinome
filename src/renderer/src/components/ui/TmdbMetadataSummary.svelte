<script lang="ts">
  import type { TmdbMetadata } from '@shared/metadata-fields'
  import type { LibraryItem } from '@shared/types'

  let { metadata, tmdbId, mediaType }: {
    metadata: TmdbMetadata
    tmdbId: LibraryItem['tmdbId']
    mediaType: LibraryItem['mediaType']
  } = $props()

  const facts = $derived([
    ['Status', metadata.status],
    ['US content rating', metadata.contentRating],
    ['TMDB score', metadata.tmdbRating == null ? undefined :
      `${metadata.tmdbRating.toFixed(1)}/10${metadata.tmdbVoteCount == null ? '' : ` (${metadata.tmdbVoteCount.toLocaleString()} votes)`}`],
    ['Next air date', metadata.nextAirDate],
    ['In production', metadata.inProduction === undefined ? undefined : metadata.inProduction ? 'Yes' : 'No'],
    ['Production companies', metadata.studios?.join(', ')],
    ['TV networks', metadata.networks?.join(', ')],
    ['Production countries', metadata.productionCountries?.join(', ')],
    ['Original language', metadata.originalLanguage]
  ].filter(([, value]) => value))
</script>

<dl>
  {#each facts as [label, value] (label)}
    <dt>{label}</dt>
    <dd>{value}</dd>
  {/each}
  {#if metadata.imdbId}
    <dt>IMDb</dt>
    <dd>
      <a href={`https://www.imdb.com/title/${metadata.imdbId}/`} target="_blank" rel="noopener noreferrer">{metadata.imdbId}</a>
    </dd>
  {/if}
  {#if metadata.homepage}
    <dt>Website</dt>
    <dd><a href={metadata.homepage} target="_blank" rel="noopener noreferrer">Official website</a></dd>
  {/if}
  {#if tmdbId && (mediaType === 'tv' || mediaType === 'movie')}
    <dt>TMDB</dt>
    <dd><a href={`https://www.themoviedb.org/${mediaType}/${tmdbId}`} target="_blank" rel="noopener noreferrer">View on TMDB</a></dd>
  {/if}
</dl>

<style>
  dl {
    display: grid;
    grid-template-columns: minmax(0, min(41%, 9.5rem)) minmax(0, 1fr);
    align-items: start;
    gap: .4rem .7rem;
    min-width: 0;
    font-size: .86rem;
    user-select: text;
    overflow-wrap: anywhere;
  }

  dt, dd { user-select: text; }
  dt { color: var(--color-text-soft); }
  a { text-underline-offset: .2em; }
</style>
