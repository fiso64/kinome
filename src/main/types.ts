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
  mediaType?: 'movie' | 'tv'
  year?: number
  genres?: string[]
  tags?: Record<string, string>
  _v?: number // Cache-busting version number
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
  mediaType?: 'movie' | 'tv'
  year?: number
  genres?: string[]
  tags?: Record<string, string>
  layout?: 'grid' | 'tree' | 'tabs' | 'sections'
  childrenClickAction?: 'detail' | 'navigate'
  // Retriever settings
  retrieve_children_metadata?: boolean
  children_type_hint?: 'movie' | 'tv'
  _v?: number // Cache-busting version number
}

export type LibraryItem = MediaFile | MediaFolder

export interface Database {
  version: number
  mediaSourcePath: string | null
  root: MediaFolder | null
}

export interface AutocompleteSuggestions {
  genres: string[]
  tagKeys: string[]
  tagValues: Record<string, string[]>
}
