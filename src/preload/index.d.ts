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
    posterPath?: string // e.g. 'xxxx.jpg'
    backdropPath?: string
    tmdbId?: number | null
    mediaType?: 'movie' | 'tv'
    year?: number
    genres?: string[]
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
    posterPath?: string // e.g. 'xxxx.jpg'
    backdropPath?: string
    tmdbId?: number | null
    mediaType?: 'movie' | 'tv'
    year?: number
    genres?: string[]
  }

  type LibraryItem = MediaFile | MediaFolder

  interface Window {
    electron: ElectronAPI
    api: {
      getLibraryRoot: () => Promise<MediaFolder | null>
      scanLibrary: () => Promise<MediaFolder | null> // Used to set a new library path
      refreshLibrary: () => Promise<MediaFolder | null> // Used to scan for new/removed files
      // Settings
      getSettings: () => Promise<{ playerCommand: string; tmdbApiKey: string }>
      getLibraryMediaSourcePath: () => Promise<string | null>
      saveSettings: (settings: { playerCommand: string; tmdbApiKey: string }) => Promise<void>
      // Data
      getItemDetails: (itemId: string) => Promise<LibraryItem | null>
      // Playback
      playFile: (file: MediaFile) => Promise<boolean>
      minimizeWindow: () => void
      toggleMaximizeWindow: () => void
      closeWindow: () => void
      isWindowMaximized: () => Promise<boolean>
      onWindowMaximizedStatus: (callback: (isMaximized: boolean) => void) => () => void
      onLibraryItemUpdated: (callback: (item: LibraryItem) => void) => () => void
    }
  }
}