import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface MediaFile {
    id: string
    name: string
    path: string
    type: 'file'
    watched?: boolean
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

  interface MediaFolder {
    id: string
    name: string
    path: string
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

  type LibraryItem = MediaFile | MediaFolder

  interface AutocompleteSuggestions {
    genres: string[]
    tagKeys: string[]
    tagValues: Record<string, string[]>
  }

  interface Window {
    electron: ElectronAPI
    api: {
      // Library
      getLibraryRoot: () => Promise<MediaFolder | null>
      scanLibrary: () => Promise<MediaFolder | null> // Used to set a new library path
      refreshLibrary: () => Promise<MediaFolder | null> // Used to scan for new/removed files
      // Settings
      getSettings: () => Promise<{ playerCommand: string; tmdbApiKey: string }>
      getLibraryMediaSourcePath: () => Promise<string | null>
      saveSettings: (settings: { playerCommand: string; tmdbApiKey: string }) => Promise<void>
      // Data
      getItemDetails: (itemId: string) => Promise<LibraryItem | null>
      updateItem: (item: LibraryItem) => Promise<void>
      getAutocompleteSuggestions: () => Promise<AutocompleteSuggestions>
      getItemById: (itemId: string) => Promise<LibraryItem | null>
      // Manual Match
      manualSearch: (query: string, type: 'movie' | 'tv', year?: string) => Promise<any[]>
      getTmdbImages: (
        tmdbId: number,
        mediaType: 'movie' | 'tv',
        language: string
      ) => Promise<{ posters: any[]; backdrops: any[]; logos: any[] }>
      applyTmdbResult: (itemId: string, result: any, mediaType: 'movie' | 'tv') => Promise<void>
      selectLocalImage: () => Promise<string | null>
      setImage: (
        itemId: string,
        imageType: 'poster' | 'backdrop' | 'logo',
        source: { type: 'tmdb'; path: string } | { type: 'local'; path: string }
      ) => Promise<void>
      removeImage: (itemId: string, imageType: 'poster' | 'backdrop' | 'logo') => Promise<void>
      // Playback
      playFile: (file: MediaFile) => Promise<boolean>
      // Window
      minimizeWindow: () => void
      toggleMaximizeWindow: () => void
      closeWindow: () => void
      isWindowMaximized: () => Promise<boolean>
      onWindowMaximizedStatus: (callback: (isMaximized: boolean) => void) => () => void
      onLibraryItemUpdated: (callback: (item: LibraryItem) => void) => () => void
    }
  }
}
