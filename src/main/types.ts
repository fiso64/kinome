export interface MediaFile {
  id: string // Stable ID (e.g., hash of relative path)
  name: string
  path: string // Full path to the file
  type: 'file'
  watched?: boolean
  // TMDB metadata
  title?: string
  overview?: string
  posterPath?: string // e.g. 'xxxx.jpg'
  backdropPath?: string
  tmdbId?: number
  mediaType?: 'movie' | 'tv'
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
  posterPath?: string // e.g. 'xxxx.jpg'
  backdropPath?: string
  tmdbId?: number
  mediaType?: 'movie' | 'tv'
}

export type LibraryItem = MediaFile | MediaFolder

export interface Database {
  version: number
  mediaSourcePath: string | null
  root: MediaFolder | null
}
