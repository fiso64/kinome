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

type IndexedMetadataStorage = 'tmdb' | 'localMedia'
type LibrarySuggestionLookup = 'mediaType' | 'genre' | 'year' | 'person'

type MetadataFieldDefinition = {
  label: string
  kind: 'text' | 'number' | 'list'
  search: boolean
  rule: boolean
} & (
  | { storage: 'tmdb'; scope?: 'item'; suggestions: 'manual' | 'stored' }
  | { storage: 'localMedia'; scope: 'file'; suggestions: 'manual' | 'stored' }
  | { storage?: undefined; scope?: 'item'; suggestions: 'manual' | LibrarySuggestionLookup }
)

export const BUILTIN_METADATA_FIELDS = {
  genre: { label: 'Genre', kind: 'list', search: true, rule: true, suggestions: 'genre' },
  year: { label: 'Year', kind: 'number', search: true, rule: true, suggestions: 'year' },
  title: { label: 'Title', kind: 'text', search: false, rule: true, suggestions: 'manual' },
  mediaType: { label: 'Media Type', kind: 'text', search: true, rule: true, suggestions: 'mediaType' },
  path: { label: 'File Path', kind: 'text', search: false, rule: true, suggestions: 'manual' },
  addedDaysAgo: { label: 'Days Since Added', kind: 'number', search: false, rule: true, suggestions: 'manual' },
  retrieveChildrenMetadata: { label: 'Retrieve Children Metadata', kind: 'number', search: false, rule: true, suggestions: 'manual' },
  person: { label: 'Person', kind: 'text', search: true, rule: false, suggestions: 'person' },
  status: { label: 'TMDB status', kind: 'text', search: true, rule: true, storage: 'tmdb', suggestions: 'stored' },
  contentRating: { label: 'US content rating', kind: 'text', search: true, rule: true, storage: 'tmdb', suggestions: 'stored' },
  tmdbRating: { label: 'TMDB score', kind: 'number', search: false, rule: true, storage: 'tmdb', suggestions: 'manual' },
  tmdbVoteCount: { label: 'TMDB vote count', kind: 'number', search: false, rule: true, storage: 'tmdb', suggestions: 'manual' },
  imdbId: { label: 'IMDb ID', kind: 'text', search: true, rule: true, storage: 'tmdb', suggestions: 'manual' },
  studios: { label: 'Production company', kind: 'list', search: true, rule: true, storage: 'tmdb', suggestions: 'stored' },
  networks: { label: 'TV network', kind: 'list', search: true, rule: true, storage: 'tmdb', suggestions: 'stored' },
  productionCountries: { label: 'Production country', kind: 'list', search: true, rule: true, storage: 'tmdb', suggestions: 'stored' },
  originalLanguage: { label: 'Original language code', kind: 'text', search: true, rule: true, storage: 'tmdb', suggestions: 'stored' },
  nextAirDate: { label: 'Next air date (YYYY-MM-DD)', kind: 'text', search: false, rule: true, storage: 'tmdb', suggestions: 'manual' },
  'file.container': { label: 'File container', kind: 'text', search: true, rule: true, storage: 'localMedia', scope: 'file', suggestions: 'stored' },
  'file.durationSeconds': { label: 'File duration (seconds)', kind: 'number', search: true, rule: true, storage: 'localMedia', scope: 'file', suggestions: 'manual' },
  'file.encoder': { label: 'File encoder', kind: 'text', search: true, rule: true, storage: 'localMedia', scope: 'file', suggestions: 'manual' },
  'file.videoHeight': { label: 'Video height (pixels)', kind: 'number', search: true, rule: true, storage: 'localMedia', scope: 'file', suggestions: 'stored' },
  'file.videoCodec': { label: 'Video codec', kind: 'list', search: true, rule: true, storage: 'localMedia', scope: 'file', suggestions: 'stored' },
  'file.audioCodec': { label: 'Audio codec', kind: 'list', search: true, rule: true, storage: 'localMedia', scope: 'file', suggestions: 'stored' },
  'file.audioLanguage': { label: 'Audio language code', kind: 'list', search: true, rule: true, storage: 'localMedia', scope: 'file', suggestions: 'stored' },
  'file.subtitleCodec': { label: 'Subtitle codec', kind: 'list', search: true, rule: true, storage: 'localMedia', scope: 'file', suggestions: 'stored' },
  'file.subtitleLanguage': { label: 'Subtitle language code', kind: 'list', search: true, rule: true, storage: 'localMedia', scope: 'file', suggestions: 'stored' }
} as const satisfies Record<string, MetadataFieldDefinition>

export type BuiltinMetadataField = keyof typeof BUILTIN_METADATA_FIELDS

type FieldWithStorage<Storage extends IndexedMetadataStorage> = {
  [Field in BuiltinMetadataField]: typeof BUILTIN_METADATA_FIELDS[Field] extends { storage: Storage } ? Field : never
}[BuiltinMetadataField]

export type TmdbFilterField = FieldWithStorage<'tmdb'>
export type LocalMediaField = FieldWithStorage<'localMedia'>
export const DEFAULT_AUTOCOMPLETE_LIMIT = 20
export type MetadataSuggestionLookup = LibrarySuggestionLookup | 'stored'

export function isBuiltinMetadataField(field: string): field is BuiltinMetadataField {
  return Object.hasOwn(BUILTIN_METADATA_FIELDS, field)
}

export function getMetadataField(field: string): MetadataFieldDefinition | undefined {
  return isBuiltinMetadataField(field) ? BUILTIN_METADATA_FIELDS[field] : undefined
}

export function isTmdbFilterField(field: string): field is TmdbFilterField {
  return getMetadataField(field)?.storage === 'tmdb'
}

export function isLocalMediaField(field: string): field is LocalMediaField {
  return getMetadataField(field)?.storage === 'localMedia'
}

export function isFileScopedField(field: string): field is LocalMediaField {
  return getMetadataField(field)?.scope === 'file'
}

export function metadataFieldKey(field: BuiltinMetadataField): string {
  return getMetadataField(field)?.storage === 'tmdb' ? `tmdb.${field}` : field
}

export function metadataSuggestionLookup(field: BuiltinMetadataField): MetadataSuggestionLookup | undefined {
  const definition: MetadataFieldDefinition = BUILTIN_METADATA_FIELDS[field]
    return definition.suggestions === 'manual' ? undefined : definition.suggestions
}

const fields = Object.keys(BUILTIN_METADATA_FIELDS) as BuiltinMetadataField[]
export const TMDB_FILTER_KEYS = fields.filter(isTmdbFilterField)
export const METADATA_RULE_FIELDS = fields
  .filter((field) => BUILTIN_METADATA_FIELDS[field].rule)
  .map((value) => ({ value, label: BUILTIN_METADATA_FIELDS[value].label }))

const searchFields = new Map(fields
  .filter((field) => BUILTIN_METADATA_FIELDS[field].search)
  .map((field) => [metadataFieldKey(field), field] as const))
const valueFields = new Map(fields
  .filter((field) => BUILTIN_METADATA_FIELDS[field].search || metadataSuggestionLookup(field))
  .map((field) => [metadataFieldKey(field), field] as const))

export const METADATA_SEARCH_KEYS = [...searchFields.keys()]

export function getMetadataSearchField(key: string): BuiltinMetadataField | undefined {
  return searchFields.get(key)
}

export function getMetadataValueField(key: string): BuiltinMetadataField | undefined {
  return valueFields.get(key)
}
