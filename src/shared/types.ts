export interface MediaFile {
  id: string // Stable ID (e.g., hash of relative path)
  name: string
  path: string // Full path to the file
  type: 'file'
  watched?: boolean
  opensAsFolder?: boolean
  // TMDB metadata
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
  tmdbDetailsFetched?: boolean
  virtualTags?: Record<string, string>
  _v?: number // Cache-busting version number
  // TV Show properties
  seasonNumber?: number
  episodeNumber?: number
}

export interface MediaFolder {
  id: string // Stable ID (e.g., hash of relative path)
  name: string
  path: string // Full path to the folder
  type: 'folder'
  children: LibraryItem[]
  // TMDB metadata
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
  layout?: 'grid' | 'tree' | 'tabs' | 'sections'
  childrenClickAction?: 'detail' | 'navigate'
  // View grouping
  groupBy?: string
  virtualFolderSettings?: Record<string, Record<string, Partial<MediaFolder>>>
  // Retriever settings
  retrieve_children_metadata?: boolean
  children_type_hint?: 'movie' | 'tv'
  // TV Show specific settings
  process_tv_children?: boolean // If false, season/episode processing and fetching is disabled
  tmdbDetailsFetched?: boolean
  tmdbEpisodesFetched?: boolean
  virtualTags?: Record<string, string>
  _v?: number // Cache-busting version number
  // TV Show properties
  seasonNumber?: number // For season folders
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
