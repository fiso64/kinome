import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  Settings as _Settings,
  ViewSettings as _ViewSettings,
  MediaFile as _MediaFile,
  MediaFolder as _MediaFolder,
  LibraryItem as _LibraryItem,
  AutocompleteSuggestions as _AutocompleteSuggestions,
  SearchIndexEntry as _SearchIndexEntry
} from '../../shared/types'

declare global {
  // Expose shared types to the global scope for Svelte components.
  // The `_` prefix is used to avoid name clashes within this file.
  type ViewSettings = _ViewSettings
  type Settings = _Settings
  type MediaFile = _MediaFile
  type MediaFolder = _MediaFolder
  type LibraryItem = _LibraryItem
  type AutocompleteSuggestions = _AutocompleteSuggestions
  type SearchIndexEntry = _SearchIndexEntry

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
      getHiddenChildren: (parentId: string) => Promise<LibraryItem[]>
      getParent: (itemId: string) => Promise<MediaFolder | null>
      applyInitialFolderSettings: (
        settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]
      ) => Promise<void>
      clearChildrenMetadata: (folderId: string) => Promise<boolean>
      clearVirtualFolderMetadata: (itemIds: string[]) => Promise<boolean>
      fetchCredits: (itemId: string) => Promise<void>
      // Manual Match
      manualSearch: (
        query: string,
        type: 'movie' | 'tv' | 'season',
        year?: string,
        tmdbId?: string
      ) => Promise<any[]>
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
      onShowErrorDialog: (
        callback: (options: { title: string; message: string; detail?: string }) => void
      ) => () => void
    }
  }
}
