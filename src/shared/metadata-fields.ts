export interface EntityScalarMetadataField {
  key: string
  column: string
  resetValue: unknown
  serialize?: (value: unknown) => unknown
}

export const ENTITY_SCALAR_METADATA_FIELDS: readonly EntityScalarMetadataField[] = [
  { key: 'tmdbId', column: 'tmdb_id', resetValue: null },
  { key: 'mediaType', column: 'media_type', resetValue: null },
  { key: 'title', column: 'title', resetValue: null },
  { key: 'originalTitle', column: 'original_title', resetValue: null },
  { key: 'overview', column: 'overview', resetValue: null },
  { key: 'releaseDate', column: 'release_date', resetValue: null },
  { key: 'year', column: 'year', resetValue: null },
  { key: 'tmdbRuntime', column: 'tmdb_runtime', resetValue: null },
  { key: 'seasonNumber', column: 'season_number', resetValue: null },
  { key: 'episodeNumber', column: 'episode_number', resetValue: null },
  { key: 'posterPath', column: 'poster_path', resetValue: null },
  { key: 'backdropPath', column: 'backdrop_path', resetValue: null },
  { key: 'logoPath', column: 'logo_path', resetValue: null },
  {
    key: 'lockedFields',
    column: 'locked_fields_json',
    resetValue: [],
    serialize: (value) => value === null ? null : JSON.stringify(value)
  },
  { key: 'lastRefreshedAt', column: 'last_refreshed_at', resetValue: null },
  { key: '_v', column: 'version', resetValue: null }
] as const

export const ENTITY_SCALAR_METADATA_KEYS = ENTITY_SCALAR_METADATA_FIELDS.map((field) => field.key)

export function hasValidEpisodePrecision(value: unknown): boolean {
  return typeof value === 'number' && (Number.isInteger(value) || Number.isInteger(value * 10))
}

export interface TmdbMetadata {
  status?: string
  inProduction?: boolean
  contentRating?: string
  tmdbRating?: number
  tmdbVoteCount?: number
  imdbId?: string
  homepage?: string
  tagline?: string
  studios?: string[]
  networks?: string[]
  productionCountries?: string[]
  originalLanguage?: string
  lastAirDate?: string
  nextAirDate?: string
  seasonCount?: number
  episodeCount?: number
  budget?: number
  revenue?: number
}

export const TMDB_FILTER_FIELDS = {
  status: { label: 'TMDB status', kind: 'text', search: true },
  contentRating: { label: 'US content rating', kind: 'text', search: true },
  tmdbRating: { label: 'TMDB score', kind: 'number', search: false },
  tmdbVoteCount: { label: 'TMDB vote count', kind: 'number', search: false },
  imdbId: { label: 'IMDb ID', kind: 'text', search: true },
  studios: { label: 'Production company', kind: 'list', search: true },
  networks: { label: 'TV network', kind: 'list', search: true },
  productionCountries: { label: 'Production country', kind: 'list', search: true },
  originalLanguage: { label: 'Original language code', kind: 'text', search: true },
  nextAirDate: { label: 'Next air date (YYYY-MM-DD)', kind: 'text', search: false }
} as const satisfies Partial<Record<keyof TmdbMetadata, {
  label: string
  kind: 'text' | 'number' | 'list'
  search: boolean
}>>

export type TmdbFilterField = keyof typeof TMDB_FILTER_FIELDS

export function isTmdbFilterField(key: string): key is TmdbFilterField {
  return Object.hasOwn(TMDB_FILTER_FIELDS, key)
}

export function hasTmdbValueSuggestions(key: string): boolean {
  return key !== 'imdbId' && isTmdbFilterField(key) && TMDB_FILTER_FIELDS[key].search
}


export const TMDB_SEARCH_PREFIX = 'tmdb.'

export function getTmdbSearchField(key: string): TmdbFilterField | undefined {
  if (!key.startsWith(TMDB_SEARCH_PREFIX)) return
  const field = key.slice(TMDB_SEARCH_PREFIX.length)
  if (isTmdbFilterField(field) && TMDB_FILTER_FIELDS[field].search) return field
}
