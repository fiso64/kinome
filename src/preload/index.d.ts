import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Settings {
    playerCommand: string
    tmdbApiKey: string
    useLogos?: boolean
    virtualTags?: { name: string; expression: string }[]
    defaultFolderLayout?: 'grid' | 'list' | 'tree'
    showDetailMediaSection?: boolean
    gridPosterSize?: number
  }

  interface MediaFile {
    id: string
    name: string
    path: string
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
    virtualTags?: Record<string, string>
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
    // View grouping
    groupBy?: string
    virtualFolderSettings?: Record<string, Record<string, Partial<MediaFolder>>>
    // Retriever settings
    retrieve_children_metadata?: boolean
    children_type_hint?: 'movie' | 'tv'
    virtualTags?: Record<string, string>
    _v?: number // Cache-busting version number
  }

  type LibraryItem = MediaFile | MediaFolder

  interface AutocompleteSuggestions {
    genres: string[]
    tagKeys: string[]
    tagValues: Record<string, string[]>
  }

  interface SearchIndexEntry {
    id: string
    title: string
    type: 'file' | 'folder'
    posterPath?: string | null
    overview?: string
    mediaType?: 'movie' | 'tv'
    year?: number
    genres?: string[]
    tags?: Record<string, string>
    virtualTags?: Record<string, string>
    _v?: number // Cache-busting version number
    staticScore: number
  }

  interface Window {
    electron: ElectronAPI
    api: {
      // Library
      performSearch: (query: {
        text: string
        tags: { key: string; value: string }[]
      }) => Promise<SearchIndexEntry[]>
      debugPerformSearch: (query: {
        text: string
        tags: { key: string; value: string }[]
      }) => Promise<any>
      getLibraryRoot: () => Promise<MediaFolder | null>
      scanLibrary: () => Promise<MediaFolder | null> // Used to set a new library path
      refreshLibrary: () => Promise<MediaFolder | null> // Used to scan for new/removed files
      // Settings
      getSettings: () => Promise<Settings>
      getLibraryMediaSourcePath: () => Promise<string | null>
      saveSettings: (settings: Partial<Settings>) => Promise<void>
      // Data
      getItemDetails: (itemId: string) => Promise<LibraryItem | null>
      updateItem: (item: LibraryItem) => Promise<void>
      getAutocompleteSuggestions: () => Promise<AutocompleteSuggestions>
      getItemById: (itemId: string) => Promise<LibraryItem | null>
      getChildren: (parentId: string) => Promise<LibraryItem[] | null>
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
      // Filesystem
      revealInExplorer: (path: string) => void
      trashItem: (path: string) => Promise<boolean>
      renameItem: (oldPath: string, newName: string) => Promise<boolean>
      getItemProperties: (path: string) => Promise<any | null>
      // Window
      minimizeWindow: () => void
      toggleMaximizeWindow: () => void
      closeWindow: () => void
      isWindowMaximized: () => Promise<boolean>
      onWindowMaximizedStatus: (callback: (isMaximized: boolean) => void) => () => void
      onLibraryItemUpdated: (callback: (item: LibraryItem) => void) => () => void
      onLibraryItemsUpdated: (callback: (items: LibraryItem[]) => void) => () => void
      onAutocompleteSuggestionsUpdated: (
        callback: (suggestions: AutocompleteSuggestions) => void
      ) => () => void
    }
  }
}
