export const LIBRARY_ROOT_ID = 'virtual-library-root'

// --- Layout-Specific Settings Definitions ---

/**
 * Defines the shape of settings specific to the 'grid' layout.
 */
export interface GridSettings {
  gridPosterSize: number
}

/**
 * Defines the shape of settings for a horizontal grid layout.
 */
export interface HorizontalGridSettings extends GridSettings {
  showHorizontalScrollbar: boolean
}

/**
 * Defines the shape of settings for a button grid layout.
 */
export interface ButtonGridSettings extends GridSettings {
  scrollHorizontally: boolean
  showHorizontalScrollbar: boolean
}

/**
 * Defines the shape of settings specific to the 'list' layout.
 */
export interface ListSettings {
  listDescriptionRows: number
}

/**
 * The single source of truth for layout-specific properties and their ultimate default values.
 * This drives the data-driven settings resolution logic.
 */
export const LAYOUT_SPECIFIC_SETTINGS_CONFIG = {
  grid: { gridPosterSize: 210 },
  'horizontal-grid': { gridPosterSize: 210, showHorizontalScrollbar: false },
  'button-grid': { gridPosterSize: 180, scrollHorizontally: false, showHorizontalScrollbar: false },
  list: { listDescriptionRows: 5 },
  tabs: {},
  sections: {}
} as const

// --- Generated Helper Constants ---

export const ALL_VIEW_LAYOUTS = [
  'grid',
  'horizontal-grid',
  'button-grid',
  'list',
  'tree',
  'tabs',
  'sections'
] as const
export type ViewLayout = (typeof ALL_VIEW_LAYOUTS)[number]

export const CONTAINER_LAYOUTS: readonly ViewLayout[] = ['tabs', 'sections']

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
  ...getAllLayoutSpecificKeys(),
  'childViewSettings'
]

// --- View Settings Type Definitions ---

/**
 * Defines the core properties common to all views.
 */
export interface BaseViewSettings {
  layout: ViewLayout
  clickAction: 'detail' | 'navigate'
}

export type SortBy = 'hybrid' | 'alpha' | 'date-added' | 'year'

/**
 * Settings that cascade through childViewSettings and per-child overrides.
 * These control rendering and display, and can be contextually overridden by a parent.
 *
 * ⚠️  New display/rendering settings belong here.
 */
export interface CascadableViewSettings
  extends Partial<
    BaseViewSettings &
      GridSettings &
      HorizontalGridSettings &
      ButtonGridSettings &
      ListSettings
  > {
  /** Narrow type: only display settings can cascade — FolderOrganizationSettings cannot. */
  childViewSettings?: CascadableViewSettings
  overrides?: Record<string, CascadableViewSettings>
  title?: string
}

/**
 * Per-folder organization settings. These are intrinsic to the folder and never cascade.
 * A parent cannot override how a child folder organizes its own contents.
 *
 * ⚠️  New per-folder structural settings belong here.
 */
export interface FolderOrganizationSettings {
  /**
   * Set atomically by applyGrouping() / removeGrouping(). Describes which grouping key
   * is currently reflected in the DB as virtual grouping folders under this folder.
   * Not user-editable directly.
   */
  appliedGrouping?: string | null
  /** Child item IDs pinned to the top, in display order. */
  sortTop?: string[]
  /** Child item IDs pinned to the bottom, in display order. */
  sortBottom?: string[]
  /** How to sort children. Defaults to 'hybrid' (season-aware). */
  sortBy?: SortBy
  /** Whether to sort in descending order. Defaults to false. */
  sortDescending?: boolean
}

/** Runtime list of all FolderOrganizationSettings keys — used for generic merging. */
export const FOLDER_ORGANIZATION_KEYS = [
  'appliedGrouping',
  'sortTop',
  'sortBottom',
  'sortBy',
  'sortDescending',
] as const satisfies (keyof FolderOrganizationSettings)[]

/**
 * The complete settings stored per folder in the DB (view_settings_json).
 * = Cascadable display settings + non-cascading folder organization settings.
 */
export type StoredViewSettings = CascadableViewSettings & FolderOrganizationSettings

/**
 * Represents the final, computed settings object after the cascade has been applied.
 * Only covers CascadableViewSettings — FolderOrganizationSettings are read directly
 * from item.viewSettings and never resolved through the cascade.
 */
export type ResolvedViewSettings = BaseViewSettings &
  Partial<
    GridSettings & HorizontalGridSettings & ButtonGridSettings & ListSettings
  > & {
    childViewSettings?: CascadableViewSettings
    overrides?: Record<string, CascadableViewSettings>
    title?: string
  }

export type ResolutionSource = {
  source: 'item' | 'type' | 'global' | 'inherited' | 'override'
  sourceKey?: DefaultLayoutKey | string
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
    availableLayouts: ['grid', 'list', 'tree'] as ViewLayout[],
    showClickAction: false
  },
  movie: {
    label: 'Default Movie Contents View',
    help: 'The default view for the contents of a movie folder on its detail page.',
    availableLayouts: [...ALL_VIEW_LAYOUTS] as ViewLayout[],
    showClickAction: true
  },
  tv: {
    label: 'Default TV Show Contents View',
    help: 'The default view for the contents of a TV show folder on its detail page.',
    availableLayouts: [...ALL_VIEW_LAYOUTS] as ViewLayout[],
    showClickAction: true
  },
  season: {
    label: 'Default Season Contents View',
    help: 'The default view for the contents of a season folder on its detail page.',
    availableLayouts: [...ALL_VIEW_LAYOUTS] as ViewLayout[],
    showClickAction: true
  }
} as const

/**
 * A type representing the keys of the default layout configuration object.
 * e.g., '_default' | 'movie' | 'tv' | 'season'
 */
export type DefaultLayoutKey = keyof typeof DEFAULT_LAYOUTS_CONFIG

export interface ScanStatus {
  isFileScanningLibrary: boolean
  isMetadataFetchingLibrary: boolean
  isFastUpdating: boolean
}

export type LibraryStatusType = 'ready' | 'no_location' | 'db_missing' | 'no_settings'

export interface LibraryStatus {
  status: LibraryStatusType
}

export type LibraryConditionOp =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'notContains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isNull'
  | 'isNotNull'
  | 'isEmpty'
  | 'isNotEmpty'

/**
 * A single filter predicate against a library item field.
 * Shared by LibraryFilter (virtual folders / pool queries) and VirtualTagConfig (vtag cases).
 *
 * field: a REPOSITORY_SCHEMA key, 'genre', 'tags.{key}', or 'vt.{key}'.
 *        Computed fields (e.g. 'addedDaysAgo') are also valid.
 * op:    comparison operator; 'contains' is case-insensitive substring match.
 *        'isNull'/'isNotNull' ignore value.
 * value: the comparison value; ignored for isNull/isNotNull ops.
 */
export interface LibraryCondition {
  field: string
  op: LibraryConditionOp
  value?: string | number | null
}

/**
 * A declarative filter over library items. Used as the definition for:
 *   - virtual folder contents (stored as filter_json)
 *   - individual cases within a VirtualTagConfig
 *
 * scope.parentId restricts results to direct children of that folder.
 * conditions is a legacy shorthand for a single AND-joined group.
 * conditionGroups is an array of AND-groups, joined by OR.
 *   e.g. [[c1, c2], [c3]] → (c1 AND c2) OR (c3)
 * If both are set, conditionGroups takes precedence.
 */
export interface LibraryFilter {
  scope?: { parentId?: string; manual?: boolean }
  conditions?: LibraryCondition[]
  conditionGroups?: LibraryCondition[][]
  /**
   * Conditions AND'd on top of conditionGroups after compilation.
   * Produced by resolveEffectiveFilter when merging a single-group child with a
   * multi-group parent, avoiding O(n×m) cross-product expansion.
   * Never persisted to filter_json — runtime only.
   */
  requiredConditions?: LibraryCondition[]
}

export interface VirtualTagCase {
  filter: LibraryFilter
  result: string
}

export interface VirtualTagConfig {
  id: string
  name: string
  cases: VirtualTagCase[]
  defaultResult?: string
}

/**
 * Settings that are universal to the server instance and NOT library-specific.
 */
export interface ServerSettings {
  libraryLocation: string
  serverPort?: number
  serverHost?: string
}

/**
 * A single media source root. The id is a stable UUID that never changes, so item IDs
 * (which are SHA256(sourceId + ':' + relativePath)) remain valid even if path changes.
 */
export interface MediaSource {
  id: string       // stable UUID, generated once when source is added
  path: string     // stored path (absolute or relative to library location)
  isRelative: boolean
  name?: string    // optional display name; defaults to basename of resolved path
}

/**
 * Settings that define defaults for a library, but can be overridden by individual library-settings.json.
 */
export interface LibrarySettings {
  tmdbApiKey: string
  useLogos: boolean
  creditsDisplay: 'shown' | 'collapsed' | 'hidden' | 'tab'
  grayOutWatched: boolean
  showContinueWatching: boolean
  showNextUp: boolean
  virtualTags?: VirtualTagConfig[]
  playerCommands: PlayerCommandConfig[]
  customActions: CustomActionConfig[]
  mediaSources?: MediaSource[]
  shadowSources?: boolean
  shadowMinDepth?: number
  defaultLayoutSettings: {
    grid: GridSettings
    'horizontal-grid': HorizontalGridSettings
    'button-grid': ButtonGridSettings
    list: ListSettings
    tabs: Record<string, never>
    sections: Record<string, never>
  }
  defaultLayouts: {
    [K in DefaultLayoutKey]: CascadableViewSettings
  }
  searchResultView: CascadableViewSettings
  searchPopupView: StoredViewSettings
  itemDetailBackdropSize: 'small' | 'full'
  itemDetailBackdropBlur: number
}

/**
 * The unified Settings object used throughout the application.
 */
export type Settings = ServerSettings & LibrarySettings

/**
 * The structure of the global settings.json file on disk.
 */
export interface GlobalConfig {
  server: ServerSettings
  libraryDefaults: LibrarySettings
}

/**
 * Fields that can ONLY be set in the global server settings.json.
 * Library-specific library-settings.json files are prohibited from overriding these.
 */
export const SERVER_SETTING_KEYS: (keyof ServerSettings)[] = [
  'serverPort',
  'serverHost',
  'libraryLocation'
]

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
  parentId?: string
  name: string
  path?: string // Full path to the file (Optional/Lazy)
  type: 'file'
  watched?: boolean // User state, preserved
  lastWatched?: number // Timestamp of when the item was last played

  // --- Fetched & User-Editable Metadata (Reset by "Clear Metadata") ---
  title?: string | null
  overview?: string | null
  posterPath?: string | null // e.g. 'xxxx.jpg'
  backdropPath?: string | null
  logoPath?: string | null
  tmdbId?: number | null
  mediaType?: 'movie' | 'tv' | 'episode' | null
  year?: number | null
  genres?: string[] | null
  tags?: Record<string, string> | null
  seasonNumber?: number | null
  episodeNumber?: number | null
  opensAsFolder?: boolean // This behavior is tied to having metadata, so it's reset
  tmdbCredits?: { cast: Person[]; crew: Person[] } | null

  // --- Internal State & Cache Properties (Reset or Managed Internally) ---
  isHidden?: boolean
  isMissing?: boolean
  addedAt?: number
  lastRefreshedAt?: number | null // Timestamp of last successful full fetch
  virtualTags?: Record<string, string>
  _v?: number // Cache-busting version number
  lockedFields?: string[] // Array of field names that are locked (e.g. ['title', 'overview'])
  ancestorIds?: string[] // Populated during broadcast for targeted query invalidation
}

export interface FolderSettings {
  retrieveChildrenMetadata: boolean
  childrenTypeHint: 'auto' | 'movie' | 'tv' | null
  processTvChildren: boolean
}

export interface MediaFolder {
  // --- Core Properties ---
  id: string // Stable ID (e.g., hash of relative path)
  parentId?: string
  name: string
  path?: string // Full path to the file (Optional/Lazy)
  type: 'folder'
  children: LibraryItem[] | null
  isVirtual?: boolean
  virtualType?: 'user' | 'grouping' | 'season' | 'home'
  filter?: LibraryFilter | null

  // --- View & Behavior Settings ---
  // TODO: Maybe combine viewSettings and folderSettings into a single settings object. Subkeys like "viewSettings", "scraperSettings", etc.
  viewSettings?: StoredViewSettings
  folderSettings?: FolderSettings
  // --- Fetched & User-Editable Metadata (Reset by "Clear Metadata") ---
  title?: string | null
  overview?: string | null
  posterPath?: string | null // e.g. 'xxxx.jpg'
  backdropPath?: string | null
  logoPath?: string | null
  tmdbId?: number | null
  mediaType?: 'movie' | 'tv' | 'season' | null
  year?: number | null
  genres?: string[] | null
  tags?: Record<string, string> | null
  seasonNumber?: number | null // For season folders

  // --- Internal State & Cache Properties (Reset or Managed Internally) ---
  isHidden?: boolean
  isMissing?: boolean
  lastRefreshedAt?: number | null // Timestamp of last successful full fetch
  virtualTags?: Record<string, string>
  _v?: number // Cache-busting version number
  tmdbSeasons?: TmdbSeason[] | null // For the TV show root, caches the seasons array from TMDB
  tmdbEpisodes?: TmdbEpisode[] | null // For a season folder, caches episode data from TMDB
  tmdbCredits?: { cast: Person[]; crew: Person[] } | null
  continueWatchingDismissed?: boolean
  nextUpDismissed?: boolean
  nextUpEpisodeId?: string | null
  _lastSeenLocalMaxSeason?: number
  _lastSeenLocalMaxEpisode?: number
  lockedFields?: string[] // Array of field names that are locked
  ancestorIds?: string[] // Populated during broadcast for targeted query invalidation
}

export interface BaseLibraryItem {
  id: string
  parentId?: string
  sourceId?: string | null
  name: string
  path?: string
  type: 'file' | 'folder'
  mediaType?: 'movie' | 'tv' | 'season' | 'episode' | null
  title?: string | null
  overview?: string | null
  posterPath?: string | null
  backdropPath?: string | null
  logoPath?: string | null
  tmdbId?: number | null
  year?: number | null
  genres?: string[] | null
  tags?: Record<string, string> | null
  virtualTags?: Record<string, string>
  seasonNumber?: number | null
  episodeNumber?: number | null
  watched?: boolean
  lastWatched?: number
  continueWatchingDismissed?: boolean
  nextUpDismissed?: boolean
  nextUpEpisodeId?: string | null
  lastRefreshedAt?: number | null
  lockedFields?: string[]
  viewSettings?: StoredViewSettings
  folderSettings?: FolderSettings
  _v?: number
  overrideChildId?: string
  mtime?: number
  birthtime?: number
  size?: number
  inode?: number
  deviceId?: number
  isIgnored?: boolean
  isVirtual?: boolean
  virtualType?: 'user' | 'grouping' | 'season' | 'home'
  addedAt?: number
}

export interface ViewHierarchyNode {
  /** The ID of the item this node describes (physical or virtual) */
  id: string

  /**
   * The raw, stored settings for this item.
   * Used by: Settings Modals (to show "inherited" vs "overridden" states).
   */
  stored: StoredViewSettings

  /**
   * The fully resolved, effective settings for rendering.
   * Used by: MediaView (to determine layout), field collectors.
   */
  effective: ResolvedViewSettings

  /**
   * Recursive map of children view configurations.
   * Only populated if the effective layout is a container ('tabs', 'sections')
   * OR if explicitly requested for unlimited depth.
   * Key: Child Item ID
   */
  children?: Record<string, ViewHierarchyNode>
}

export type LibraryItem = (MediaFile | MediaFolder) &
  BaseLibraryItem & {
    /** Optional side-channel for the resolved view hierarchy tree. */
    viewHierarchy?: ViewHierarchyNode
  }

export interface PlayerCommandConfig {
  id: string
  name: string
  command: string
  isBuiltIn?: boolean
}

export interface CustomActionConfig {
  id: string
  name: string
  command: string
}

export interface TmdbEpisode {
  episode_number: number
  name: string
  overview: string | null
  still_path: string | null
}

export interface TmdbSeason {
  id: number
  air_date?: string | null
  episode_count?: number
  name: string
  overview: string | null
  poster_path: string | null
  season_number: number
}

export interface TmdbImage {
  aspect_ratio: number
  file_path: string
  height: number
  iso_639_1: string | null
  vote_average: number
  vote_count: number
  width: number
}

export interface TmdbSearchResult {
  id: number
  title?: string
  name?: string
  overview: string | null
  poster_path: string | null
  backdrop_path: string | null
  release_date?: string
  first_air_date?: string
  media_type?: 'movie' | 'tv'
  genre_ids?: number[]
  season_number?: number
  episode_count?: number
}

export interface Database {
  version: number
  root: MediaFolder | null
}

export interface AppCapabilities {
  /**
   * Determines if the custom Minimize/Maximize/Close buttons should be rendered.
   * True for Desktop clients, False for generic Web browsers.
   */
  hasWindowControls: boolean
  /**
   * Indicates if the backend can spawn processes visible to the user (e.g., launching VLC).
   * True for Desktop/Local setups, False for remote Web access.
   */
  supportsLocalPlayback: boolean
}

export interface AutocompleteSuggestions {
  mediaType: string[]
  genre: string[]
  /**
   * If null, indicates that the person suggestions are offloaded to a specialized search endpoint
   * to avoid bloating the initial payload.
   */
  person: string[] | null
  tags: Record<string, string[]>
  virtualTags: Record<string, string[]>
}

export interface SearchQuery {
  text: string
  tags: { key: string; value: string }[]
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

export interface MediaProperties {
  name: string
  path: string
  type: 'File' | 'Folder'
  created: string
  modified: string
  size: number
  contains?: {
    files: number
    folders: number
  }
}

export interface TmdbImageResults {
  posters: TmdbImage[]
  backdrops: TmdbImage[]
  logos: TmdbImage[]
}

/**
 * These constants define which properties of a LibraryItem belong to which conceptual
 * group. This provides a single, type-safe source of truth for logic that needs to
 * differentiate between settings, fetched metadata, and internal state.
 */

/**
 * TODO: We want to refactor this so that it is slimmed down all the way to only have 'id' as a core field,
 * but this has been postponed as this is a dangerous/breaking change refactor.
 * NOBODY IS ALLOWED TO ADD ANY FIELD HERE, NO MATTER WHAT - YES, THAT INCLUDES YOU!
 */
export const CORE_FIELDS = [
  'id',
  'parentId',
  'name',
  'type',
  'title',
  'mediaType',
  'posterPath',
  'watched',
  'isMissing',
  'year',
  'seasonNumber',
  'episodeNumber',
  'tmdbId', // Required for "Fix Match" / "Find Artwork" buttons
  '_v', // Required for image cache busting
  'isVirtual',
  'virtualType',

  // TODO: When removing this field from CORE_FIELDS, we must make locking
  //       more robust by 1) enforcing that at the repository/update layer,
  //       and 2) adding & using helpers to check for field locks everywhere.
  'lockedFields' // Our locking logic is brittle and might fail if this is not included.
] as const

// --- Property Key Definitions ---

export const METADATA_KEYS = [
  'title',
  'originalTitle',
  'overview',
  'releaseDate',
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
  'listDescriptionRows',
  'showHorizontalScrollbar',
  'groupBy',
  // Special settings
  'childViewSettings'
] as const

export const FOLDER_BEHAVIOR_SETTINGS_KEYS = [
  'retrieveChildrenMetadata',
  'childrenTypeHint',
  'processTvChildren'
] as const

// --- Combined & Functional Key Lists ---

/**
 * A list of all keys that should be reset when a user performs a "Clear Metadata" action.
 * This combines fetched metadata with internal cache state that needs to be invalidated.
 */
export const RESETTABLE_METADATA_KEYS = [
  ...METADATA_KEYS,
  'lockedFields',
  // Internal cache state that must be cleared along with metadata
  'lastRefreshedAt',
  'tmdbSeasons',
  'tmdbEpisodes',
  'virtualTags', // Derived from metadata, so must be reset
  'tmdbCredits',
  'continueWatchingDismissed',
  'nextUpDismissed',
  '_lastSeenLocalMaxSeason',
  '_lastSeenLocalMaxEpisode'
] as const

/**
 * Fields that are user-controlled and must be preserved when reassigning media
 * (e.g. manual TMDB match). These are not sourced from TMDB and would be lost
 * permanently if cleared. Add to this list when introducing new user-managed fields.
 *
 * Current preserved fields:
 * - `tags`: custom key/value tags set by the user
 */
export const PRESERVED_ON_REASSIGN_FIELDS = ['tags'] as const

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

// --- Accounts & Permissions ---

export type AccountRole = 'admin' | 'normal'

export type Capability =
  | 'editMetadata'
  | 'editSettings'
  | 'manageAccounts'
  | 'triggerLibraryScan'

export const ROLE_CAPABILITIES: Record<AccountRole, Capability[]> = {
  admin: ['editMetadata', 'editSettings', 'manageAccounts', 'triggerLibraryScan'],
  normal: [],
}

export interface Account {
  id: string
  username: string
  role: AccountRole
}

export interface AccountFilterRule {
  accountId: string
  mode: 'allow' | 'deny'
  filter: LibraryFilter
}

export interface LoginRequest {
  username: string
  password: string
}

export interface SetupRequest {
  setupToken: string
  username: string
  password: string
}

export interface AuthResponse {
  authenticated: boolean
  needsSetup: boolean
  account?: Account & { capabilities: Capability[] }
  token?: string
}
