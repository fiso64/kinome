export interface ViewSettings {
  layout: 'grid' | 'list' | 'tree' | 'tabs' | 'sections'
  clickAction: 'detail' | 'navigate'
  groupBy: string
}

export interface Settings {
  playerCommand: string
  tmdbApiKey: string
  useLogos?: boolean
  virtualTags?: { name: string; expression: string }[]
  gridPosterSize?: number
  defaultViewSettings: ViewSettings
  defaultMovieViewSettings: ViewSettings
  defaultTvShowViewSettings: ViewSettings
  defaultSeasonViewSettings: ViewSettings
}

export interface MediaFile {
  // --- Core & User State (Preserved) ---
  id: string // Stable ID (e.g., hash of relative path)
  name: string
  path: string // Full path to the file
  type: 'file'
  watched?: boolean // User state, preserved

  // --- Fetched & User-Editable Metadata (Reset by "Clear Metadata") ---
  title?: string
  overview?: string
  posterPath?: string | null // e.g. 'xxxx.jpg'
  backdropPath?: string | null
  logoPath?: string | null
  tmdbId?: number | null
  mediaType?: 'movie' | 'tv' | 'episode'
  year?: number
  genres?: string[]
  tags?: Record<string, string>
  seasonNumber?: number
  episodeNumber?: number
  opensAsFolder?: boolean // This behavior is tied to having metadata, so it's reset

  // --- Internal State & Cache Properties (Reset or Managed Internally) ---
  isHidden?: boolean
  tmdbDetailsFetched?: boolean
  virtualTags?: Record<string, string>
  _v?: number // Cache-busting version number
}

export interface MediaFolder {
  // --- Core Properties (Preserved) ---
  id: string // Stable ID (e.g., hash of relative path)
  name: string
  path: string // Full path to the folder
  type: 'folder'
  children: LibraryItem[]

  // --- View & Behavior Settings (Preserved) ---
  layout?: 'grid' | 'tree' | 'tabs' | 'sections'
  gridPosterSize?: number | null
  childrenClickAction?: 'detail' | 'navigate'
  groupBy?: string
  virtualFolderSettings?: Record<string, Record<string, Partial<MediaFolder>>>
  retrieve_children_metadata?: boolean
  children_type_hint?: 'movie' | 'tv'
  process_tv_children?: boolean // If false, season/episode processing and fetching is disabled

  // --- Fetched & User-Editable Metadata (Reset by "Clear Metadata") ---
  title?: string
  overview?: string
  posterPath?: string | null // e.g. 'xxxx.jpg'
  backdropPath?: string | null
  logoPath?: string | null
  tmdbId?: number | null
  mediaType?: 'movie' | 'tv' | 'season'
  year?: number
  genres?: string[]
  tags?: Record<string, string>
  seasonNumber?: number // For season folders

  // --- Internal State & Cache Properties (Reset or Managed Internally) ---
  isHidden?: boolean
  tmdbDetailsFetched?: boolean
  tmdbEpisodesFetched?: boolean
  virtualTags?: Record<string, string>
  _v?: number // Cache-busting version number
  tmdbSeasons?: any[] // For the TV show root, caches the seasons array from TMDB
}

export type LibraryItem = MediaFile | MediaFolder

export interface Database {
  version: number
  mediaSourcePath: string | null
  root: MediaFolder | null
}

export interface AutocompleteSuggestions {
  mediaTypes: string[]
  genres: string[]
  tagKeys: string[]
  virtualTagKeys: string[]
  tagValues: Record<string, string[]>
}

export interface SearchIndexEntry {
  id: string
  title: string // This will be the primary display and search title (item.title ?? item.name)
  type: 'file' | 'folder'
  posterPath?: string | null
  overview?: string
  // We need all filterable properties
  mediaType?: 'movie' | 'tv' | 'season' | 'episode'
  year?: number
  genres?: string[]
  tags?: Record<string, string>
  virtualTags?: Record<string, string>
  watched?: boolean
  episodeNumber?: number
  // We need properties for UI interaction
  _v?: number // Cache-busting version number
  // Score for ranking
  staticScore: number
}

/**
 * These constants define which properties of a LibraryItem belong to which conceptual
 * group. This provides a single, type-safe source of truth for logic that needs to
 * differentiate between settings, fetched metadata, and internal state.
 */

// --- Property Key Definitions ---

export const METADATA_KEYS = [
  'title',
  'overview',
  'posterPath',
  'backdropPath',
  'logoPath',
  'tmdbId',
  'mediaType',
  'year',
  'genres',
  'tags',
  'opensAsFolder', // File-specific
  'seasonNumber',
  'episodeNumber' // File-specific
] as const

export const VIEW_SETTINGS_KEYS = [
  'layout',
  'gridPosterSize',
  'childrenClickAction',
  'groupBy',
  'virtualFolderSettings'
] as const

export const FOLDER_BEHAVIOR_SETTINGS_KEYS = [
  'retrieve_children_metadata',
  'children_type_hint',
  'process_tv_children'
] as const

// --- Combined & Functional Key Lists ---

/**
 * A list of all keys that should be reset when a user performs a "Clear Metadata" action.
 * This combines fetched metadata with internal cache state that needs to be invalidated.
 */
export const RESETTABLE_METADATA_KEYS = [
  ...METADATA_KEYS,
  // Internal cache state that must be cleared along with metadata
  'tmdbDetailsFetched',
  'tmdbEpisodesFetched',
  'tmdbSeasons',
  'virtualTags' // Derived from metadata, so must be reset
] as const

/**
 * A list of all properties from a LibraryItem that are needed to create
 * a `SearchIndexEntry`. This is used to build the search index.
 */
export const SEARCH_INDEX_PROPERTIES = [
  'id',
  'type',
  'posterPath',
  'overview',
  'mediaType',
  'year',
  'genres',
  'tags',
  'virtualTags',
  'watched',
  'episodeNumber',
  '_v'
] as const
