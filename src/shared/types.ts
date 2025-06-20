// --- Layout-Specific Settings Definitions ---

/**
 * Defines the shape of settings specific to the 'grid' layout.
 */
export interface GridSettings {
  gridPosterSize: number
}

/**
 * Defines the shape of settings specific to 'tabs' or 'sections' layouts.
 */
export interface GroupingSettings {
  groupBy: string
}

/**
 * A union of all possible layout-specific setting objects.
 */
type LayoutSpecificSettings = GridSettings | GroupingSettings

/**
 * The single source of truth for layout-specific properties and their ultimate default values.
 * This drives the data-driven settings resolution logic.
 */
export const LAYOUT_SPECIFIC_SETTINGS_CONFIG = {
  grid: { gridPosterSize: 200 },
  tabs: { groupBy: 'folder' },
  sections: { groupBy: 'folder' }
} as const

// --- View Settings Type Definitions ---

/**
 * Defines the core properties common to all views.
 */
export interface BaseViewSettings {
  layout: 'grid' | 'list' | 'tree' | 'tabs' | 'sections'
  clickAction: 'detail' | 'navigate'
}

/**
 * Represents how view settings are stored in `settings.json` or on a `MediaFolder`.
 * It's a partial object containing only the user-defined *overrides*.
 */
export type StoredViewSettings = Partial<BaseViewSettings & GridSettings & GroupingSettings>

/**
 * Represents the final, computed settings object after the full cascade has been applied.
 * It's a complete object ready for the UI to consume.
 */
export type ResolvedViewSettings = BaseViewSettings & Partial<LayoutSpecificSettings>

export interface Settings {
  playerCommand: string
  tmdbApiKey: string
  useLogos?: boolean
  virtualTags?: { name: string; expression: string }[]
  // Global defaults for layout-specific properties
  defaultLayoutSettings: {
    grid: GridSettings
    tabs: GroupingSettings
    sections: GroupingSettings
  }
  // Type-specific overrides
  defaultViewSettings: StoredViewSettings // The base default
  defaultMovieViewSettings: StoredViewSettings
  defaultTvShowViewSettings: StoredViewSettings
  defaultSeasonViewSettings: StoredViewSettings
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

export interface MediaFolder extends StoredViewSettings {
  // --- Core Properties (Preserved) ---
  id: string // Stable ID (e.g., hash of relative path)
  name: string
  path: string // Full path to the folder
  type: 'folder'
  children: LibraryItem[]

  // --- View & Behavior Settings (Preserved) ---
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
  // Base view settings
  'layout',
  'clickAction',
  // Layout-specific settings
  'gridPosterSize',
  'groupBy',
  // Other view-related settings
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
