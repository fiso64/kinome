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
