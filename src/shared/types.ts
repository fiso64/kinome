// --- Layout-Specific Settings Definitions ---

/**
 * Defines the shape of settings specific to the 'grid' layout.
 */
export interface GridSettings {
  gridPosterSize: number
}

/**
 * Defines the shape of settings specific to the 'list' layout.
 */
export interface ListSettings {
  listDescriptionRows: number
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
type LayoutSpecificSettings = GridSettings | GroupingSettings | ListSettings

/**
 * The single source of truth for layout-specific properties and their ultimate default values.
 * This drives the data-driven settings resolution logic.
 */
export const LAYOUT_SPECIFIC_SETTINGS_CONFIG = {
  grid: { gridPosterSize: 250 },
  list: { listDescriptionRows: 3 },
  tabs: { groupBy: 'folder' },
  sections: { groupBy: 'folder' }
} as const

// --- Generated Helper Constants ---

// This function computes all unique keys from the layout-specific settings config.
function getAllLayoutSpecificKeys(): string[] {
  const allKeys = (
    Object.values(LAYOUT_SPECIFIC_SETTINGS_CONFIG) as { [key: string]: any }[]
  ).flatMap((config) => Object.keys(config))
  return [...new Set(allKeys)]
}

/**
 * A data-driven constant holding all possible keys that can be overridden on a per-item basis for view settings.
 */
export const ALL_VIEW_OVERRIDE_KEYS: readonly string[] = [
  'layout',
  'clickAction',
  ...getAllLayoutSpecificKeys()
]

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
export type StoredViewSettings = Partial<
  BaseViewSettings & GridSettings & GroupingSettings & ListSettings
>

/**
 * Represents the final, computed settings object after the full cascade has been applied.
 * It's a complete object ready for the UI to consume.
 */
export type ResolvedViewSettings = BaseViewSettings & Partial<LayoutSpecificSettings>

export type ResolutionSource = {
  source: 'item' | 'type' | 'global'
  sourceKey?: DefaultLayoutKey
}

export interface ResolutionInfo {
  settings: ResolvedViewSettings
  sources: { [K in keyof ResolvedViewSettings]?: ResolutionSource }
}

/**
 * A single source of truth for the configurations of different default layout types.
 * This drives the UI in the settings modal and the default values in the main process.
 */
export const DEFAULT_LAYOUTS_CONFIG = {
  _default: {
    label: 'Default Folder View',
    help: 'The default view used for folders that do not have a specific layout set.',
    availableLayouts: ['grid', 'list', 'tree'] as ('grid' | 'list' | 'tree')[],
    showClickAction: false
  },
  movie: {
    label: 'Default Movie Contents View',
    help: 'The default view for the contents of a movie folder on its detail page.',
    availableLayouts: ['grid', 'list', 'tree', 'tabs', 'sections'] as (
      | 'grid'
      | 'list'
      | 'tree'
      | 'tabs'
      | 'sections'
    )[],
    showClickAction: true
  },
  tv: {
    label: 'Default TV Show Contents View',
    help: 'The default view for the contents of a TV show folder on its detail page.',
    availableLayouts: ['grid', 'list', 'tree', 'tabs', 'sections'] as (
      | 'grid'
      | 'list'
      | 'tree'
      | 'tabs'
      | 'sections'
    )[],
    showClickAction: true
  },
  season: {
    label: 'Default Season Contents View',
    help: 'The default view for the contents of a season folder on its detail page.',
    availableLayouts: ['grid', 'list', 'tree', 'tabs', 'sections'] as (
      | 'grid'
      | 'list'
      | 'tree'
      | 'tabs'
      | 'sections'
    )[],
    showClickAction: true
  }
} as const

/**
 * A type representing the keys of the default layout configuration object.
 * e.g., '_default' | 'movie' | 'tv' | 'season'
 */
export type DefaultLayoutKey = keyof typeof DEFAULT_LAYOUTS_CONFIG

export interface Settings {
  playerCommand: string
  tmdbApiKey: string
  useLogos: boolean
  creditsDisplay: 'shown' | 'collapsed' | 'hidden' | 'tab'
  showContinueWatching: boolean
  showNextUp: boolean
  virtualTags?: { name: string; expression: string }[]
  libraryLocation: string // The path to the library data directory.
  mediaSourcePath?: string
  // Global defaults for layout-specific properties
  defaultLayoutSettings: {
    grid: GridSettings
    list: ListSettings
    tabs: GroupingSettings
    sections: GroupingSettings
  }
  // Type-specific layout defaults, now typed from our config keys
  defaultLayouts: {
    [K in DefaultLayoutKey]: StoredViewSettings
  }
  // View settings for special non-folder views
  searchResultView: StoredViewSettings
  searchPopupView: StoredViewSettings
}

export interface Person {
  id: number
  name: string
  profile_path: string | null
  // For cast
  character?: string
  // For crew
  job?: string
  // For sorting
  order?: number
}

export interface MediaFile {
  // --- Core & User State (Preserved) ---
  id: string // Stable ID (e.g., hash of relative path)
  name: string
  path: string // Full path to the file
  type: 'file'
  watched?: boolean // User state, preserved
  lastWatched?: number // Timestamp of when the item was last played

  // --- Fetched & User-Editable Metadata (Reset by "Clear Metadata") ---
  title?: string
  overview?: string | null
  posterPath?: string | null // e.g. 'xxxx.jpg'
  backdropPath?: string | null
  logoPath?: string | null
  tmdbId?: number | null
  mediaType?: 'movie' | 'tv' | 'episode'
  year?: number | null
  genres?: string[]
  tags?: Record<string, string>
  seasonNumber?: number
  episodeNumber?: number
  opensAsFolder?: boolean // This behavior is tied to having metadata, so it's reset
  tmdbCredits?: { cast: Person[]; crew: Person[] } | null

  // --- Internal State & Cache Properties (Reset or Managed Internally) ---
  isHidden?: boolean
  isMissing?: boolean
  isUserEdited?: boolean
  tmdbDetailsFetched?: boolean
  tmdbCreditsFetched?: boolean
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
  overview?: string | null
  posterPath?: string | null // e.g. 'xxxx.jpg'
  backdropPath?: string | null
  logoPath?: string | null
  tmdbId?: number | null
  mediaType?: 'movie' | 'tv' | 'season'
  year?: number | null
  genres?: string[]
  tags?: Record<string, string>
  seasonNumber?: number // For season folders

  // --- Internal State & Cache Properties (Reset or Managed Internally) ---
  isHidden?: boolean
  isMissing?: boolean
  isUserEdited?: boolean
  tmdbDetailsFetched?: boolean
  tmdbCreditsFetched?: boolean
  tmdbEpisodesFetched?: boolean
  virtualTags?: Record<string, string>
  _v?: number // Cache-busting version number
  tmdbSeasons?: any[] | null // For the TV show root, caches the seasons array from TMDB
  tmdbEpisodes?: TmdbEpisode[] | null // For a season folder, caches episode data from TMDB
  tmdbCredits?: { cast: Person[]; crew: Person[] } | null
  continueWatchingDismissed?: boolean
  _lastSeenLocalMaxSeason?: number
  _lastSeenLocalMaxEpisode?: number
}

export type LibraryItem = MediaFile | MediaFolder

export interface TmdbEpisode {
  episode_number: number
  name: string
  overview: string | null
  still_path: string | null
}

export interface Database {
  version: number
  root: MediaFolder | null
}

export interface AutocompleteSuggestions {
  mediaTypes: string[]
  genres: string[]
  persons: string[]
  tagKeys: string[]
  virtualTagKeys: string[]
  tagValues: Record<string, string[]>
}

export interface SearchIndexEntry {
  id: string
  title: string // This will be the primary display and search title (item.title ?? item.name)
  type: 'file' | 'folder'
  posterPath?: string | null
  overview?: string | null
  // We need all filterable properties
  persons?: string[]
  mediaType?: 'movie' | 'tv' | 'season' | 'episode'
  year?: number | null
  genres?: string[]
  tags?: Record<string, string>
  virtualTags?: Record<string, string>
  watched?: boolean
  episodeNumber?: number
  // We need properties for UI interaction
  isMissing?: boolean
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
  'tmdbEpisodes',
  'virtualTags', // Derived from metadata, so must be reset
  'tmdbCredits',
  'tmdbCreditsFetched',
  '_lastSeenLocalMaxSeason',
  '_lastSeenLocalMaxEpisode'
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
  'isMissing',
  '_v'
] as const
