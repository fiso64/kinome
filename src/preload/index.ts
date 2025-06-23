console.log(`[${new Date().toISOString()}] [Preload] Preload script execution start.`)

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  Settings,
  MediaFile,
  MediaFolder,
  LibraryItem,
  AutocompleteSuggestions,
  SearchIndexEntry
} from '../shared/types'

// Custom APIs for renderer
const api = {
  performSearch: (query: {
    text: string
    tags: { key: string; value: string }[]
  }): Promise<SearchIndexEntry[]> => ipcRenderer.invoke('perform-search', query),
  debugPerformSearch: (query: {
    text: string
    tags: { key: string; value: string }[]
  }): Promise<any> => ipcRenderer.invoke('debug-perform-search', query),
  getLibraryRoot: (): Promise<MediaFolder | null> => ipcRenderer.invoke('get-library-root'),
  performInitialScan: (): Promise<MediaFolder | null> =>
    ipcRenderer.invoke('perform-initial-scan'),
  performFullRescan: (newPath: string): Promise<MediaFolder | null> =>
    ipcRenderer.invoke('perform-full-rescan', newPath),
  refreshLibrary: (): Promise<MediaFolder | null> => ipcRenderer.invoke('refresh-library'),
  playFile: (file: MediaFile): Promise<boolean> => ipcRenderer.invoke('play-file', file),
  getItemDetails: (itemId: string): Promise<LibraryItem | null> =>
    ipcRenderer.invoke('get-item-details', itemId),
  userUpdateItem: (item: LibraryItem): Promise<void> =>
    ipcRenderer.invoke('user-update-item', item),
  getAutocompleteSuggestions: (): Promise<AutocompleteSuggestions> =>
    ipcRenderer.invoke('get-autocomplete-suggestions'),
  getItemById: (itemId: string): Promise<LibraryItem | null> =>
    ipcRenderer.invoke('get-item-by-id', itemId),
  getChildren: (parentId: string): Promise<LibraryItem[] | null> =>
    ipcRenderer.invoke('get-children', parentId),
  getHiddenChildren: (parentId: string): Promise<LibraryItem[]> =>
    ipcRenderer.invoke('get-hidden-children', parentId),
  getParent: (itemId: string): Promise<MediaFolder | null> =>
    ipcRenderer.invoke('get-parent', itemId),
  getContinueWatchingItems: (): Promise<{ show: MediaFolder; nextEpisode: MediaFile }[]> =>
    ipcRenderer.invoke('get-continue-watching-items'),
  getContinueWatchingForShow: (
    showId: string
  ): Promise<{ show: MediaFolder; nextEpisode: MediaFile } | null> =>
    ipcRenderer.invoke('get-continue-watching-for-show', showId),
  setContinueWatchingDismissed: (showId: string): Promise<void> =>
    ipcRenderer.invoke('set-continue-watching-dismissed', showId),
  applyInitialFolderSettings: (
    settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]
  ): Promise<void> => ipcRenderer.invoke('apply-initial-folder-settings', settings),
  clearItemMetadata: (itemId: string): Promise<boolean> =>
    ipcRenderer.invoke('clear-item-metadata', itemId),
  clearVirtualFolderMetadata: (itemIds: string[]): Promise<boolean> =>
    ipcRenderer.invoke('clear-virtual-folder-metadata', itemIds),
  fetchCredits: (itemId: string): Promise<void> => ipcRenderer.invoke('fetch-credits', itemId),
  assignSeasonsAndEpisodes: (
    showId: string,
    seasonStrategy: 'smart' | 'alphabetic',
    episodeStrategy: 'smart' | 'alphabetic',
    fetchMetadata: boolean
  ): Promise<void> =>
    ipcRenderer.invoke(
      'assign-seasons-and-episodes',
      showId,
      seasonStrategy,
      episodeStrategy,
      fetchMetadata
    ),

  // Manual Match
  manualSearch: (
    query: string,
    type: 'movie' | 'tv' | 'season',
    year?: string,
    tmdbId?: string
  ): Promise<any[]> => ipcRenderer.invoke('manual-search', query, type, year, tmdbId),
  getTmdbImages: (
    tmdbId: number,
    mediaType: 'movie' | 'tv',
    language: string
  ): Promise<{ posters: any[]; backdrops: any[]; logos: any[] }> =>
    ipcRenderer.invoke('get-tmdb-images', tmdbId, mediaType, language),
  applyTmdbResult: (itemId: string, result: any, mediaType: 'movie' | 'tv'): Promise<void> =>
    ipcRenderer.invoke('user-apply-tmdb-result', itemId, result, mediaType),
  markAsUnwatched: (itemId: string): Promise<void> =>
    ipcRenderer.invoke('mark-as-unwatched', itemId),
  selectLocalImage: (): Promise<string | null> => ipcRenderer.invoke('select-local-image'),
  setImage: (
    itemId: string,
    imageType: 'poster' | 'backdrop' | 'logo',
    source: { type: 'tmdb'; path: string } | { type: 'local'; path: string }
  ): Promise<void> => ipcRenderer.invoke('user-set-image', itemId, imageType, source),
  removeImage: (itemId: string, imageType: 'poster' | 'backdrop' | 'logo'): Promise<void> =>
    ipcRenderer.invoke('remove-image', itemId, imageType),

  // Filesystem
  revealInExplorer: (path: string): void => ipcRenderer.send('reveal-in-explorer', path),
  trashItem: (path: string): Promise<boolean> => ipcRenderer.invoke('trash-item', path),
  deleteItemFromDb: (itemId: string): Promise<boolean> =>
    ipcRenderer.invoke('delete-item-from-db', itemId),
  renameItem: (oldPath: string, newName: string): Promise<boolean> =>
    ipcRenderer.invoke('rename-item', oldPath, newName),
  getItemProperties: (path: string): Promise<any | null> =>
    ipcRenderer.invoke('get-item-properties', path),
  selectLibraryDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('select-library-directory'),
  selectMediaSourceDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('select-media-source-directory'),

  // Settings
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('get-settings'),
  getLibraryMediaSourcePath: (): Promise<string | null> =>
    ipcRenderer.invoke('get-library-media-source-path'),
  saveSettings: (settings: Partial<Settings>): Promise<void> =>
    ipcRenderer.invoke('save-settings', settings),
  saveMediaSourcePath: (newPath: string): Promise<void> =>
    ipcRenderer.invoke('save-media-source-path', newPath),

  // Window Controls
  minimizeWindow: (): void => ipcRenderer.send('window-minimize'),
  toggleMaximizeWindow: (): void => ipcRenderer.send('window-toggle-maximize'),
  closeWindow: (): void => ipcRenderer.send('window-close'),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke('is-window-maximized'),
  onWindowMaximizedStatus: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, isMaximized: boolean): void => callback(isMaximized)
    ipcRenderer.on('window-is-maximized', listener)
    return () => {
      ipcRenderer.removeListener('window-is-maximized', listener)
    }
  },
  onLibraryItemUpdated: (callback: (item: LibraryItem) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, item: LibraryItem): void => callback(item)
    ipcRenderer.on('library-item-updated', listener)
    return () => {
      ipcRenderer.removeListener('library-item-updated', listener)
    }
  },
  onLibraryItemDeleted: (callback: (itemId: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, itemId: string): void => callback(itemId)
    ipcRenderer.on('library-item-deleted', listener)
    return () => {
      ipcRenderer.removeListener('library-item-deleted', listener)
    }
  },
  onLibraryItemsUpdated: (callback: (items: LibraryItem[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, items: LibraryItem[]): void => callback(items)
    ipcRenderer.on('library-items-updated', listener)
    return () => {
      ipcRenderer.removeListener('library-items-updated', listener)
    }
  },
  onAutocompleteSuggestionsUpdated: (
    callback: (suggestions: AutocompleteSuggestions) => void
  ): (() => void) => {
    const listener = (_event: IpcRendererEvent, suggestions: AutocompleteSuggestions): void =>
      callback(suggestions)
    ipcRenderer.on('autocomplete-suggestions-updated', listener)
    return () => {
      ipcRenderer.removeListener('autocomplete-suggestions-updated', listener)
    }
  },
  onShowErrorDialog: (
    callback: (options: { title: string; message: string; detail?: string }) => void
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      options: { title: string; message: string; detail?: string }
    ): void => callback(options)
    ipcRenderer.on('show-error-dialog', listener)
    return () => {
      ipcRenderer.removeListener('show-error-dialog', listener)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
