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
    mediaType?: 'movie' | 'tv'
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
    mediaType?: 'movie' | 'tv'
  }

  type LibraryItem = MediaFile | MediaFolder

  interface Window {
    electron: ElectronAPI
    api: {
      getLibraryRoot: () => Promise<MediaFolder | null>
      scanLibrary: () => Promise<MediaFolder | null>
      // Settings
      getSettings: () => Promise<{ playerCommand: string; tmdbApiKey: string }>
      saveSettings: (settings: { playerCommand: string; tmdbApiKey: string }) => Promise<void>
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
