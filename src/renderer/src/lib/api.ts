import type {
  Settings,
  MediaFile,
  MediaFolder,
  LibraryItem,
  AutocompleteSuggestions,
  SearchIndexEntry,
  TmdbSearchResult,
  TmdbImageResults,
  MediaProperties
} from '../../../shared/types'

export interface ApiClient {
  performSearch(query: {
    text: string
    tags: { key: string; value: string }[]
  }): Promise<SearchIndexEntry[]>
  debugPerformSearch(query: {
    text: string
    tags: { key: string; value: string }[]
  }): Promise<Record<string, unknown>>
  getLibraryRoot(): Promise<MediaFolder | null>
  performInitialScan(): Promise<MediaFolder | null>
  performFullRescan(newPath: string): Promise<MediaFolder | null>
  refreshLibrary(): Promise<MediaFolder | null>
  playFile(file: MediaFile): Promise<boolean>
  playFileWith(file: MediaFile, command: string): Promise<boolean>
  getItemDetails(itemId: string): Promise<LibraryItem | null>
  userUpdateItem(item: LibraryItem): Promise<void>
  getAutocompleteSuggestions(): Promise<AutocompleteSuggestions>
  getItemById(itemId: string): Promise<LibraryItem | null>
  getChildren(parentId: string): Promise<LibraryItem[] | null>
  getHiddenChildren(parentId: string): Promise<LibraryItem[]>
  getParent(itemId: string): Promise<MediaFolder | null>
  getContinueWatchingItems(): Promise<{ show: MediaFolder; nextEpisode: MediaFile }[]>
  getContinueWatchingForShow(
    showId: string
  ): Promise<{ show: MediaFolder; nextEpisode: MediaFile } | null>
  setContinueWatchingDismissed(showId: string): Promise<void>
  setNextUpDismissed(showId: string): Promise<void>
  applyInitialFolderSettings(
    settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]
  ): Promise<void>
  clearItemMetadata(itemId: string, childrenOnly: boolean): Promise<boolean>
  clearVirtualFolderMetadata(itemIds: string[]): Promise<boolean>
  fetchCredits(itemId: string): Promise<void>
  assignSeasonsAndEpisodes(
    showId: string,
    seasonStrategy: 'smart' | 'alphabetic',
    episodeStrategy: 'smart' | 'alphabetic',
    fetchMetadata: boolean
  ): Promise<void>
  manualSearch(
    query: string,
    type: 'movie' | 'tv' | 'season',
    year?: string,
    tmdbId?: string
  ): Promise<TmdbSearchResult[]>
  getTmdbImages(
    tmdbId: number,
    mediaType: 'movie' | 'tv',
    language: string
  ): Promise<TmdbImageResults>
  applyTmdbResult(
    itemId: string,
    result: TmdbSearchResult,
    mediaType: 'movie' | 'tv' | 'season'
  ): Promise<void>
  markAsWatched(itemId: string): Promise<void>
  markAsUnwatched(itemId: string): Promise<void>
  getFolderWatchedState(folderId: string): Promise<'fully' | 'partially' | 'unwatched' | 'none'>
  selectLocalImage(): Promise<string | null>
  setImage(
    itemId: string,
    imageType: 'poster' | 'backdrop' | 'logo',
    source: { type: 'tmdb'; path: string } | { type: 'local'; path: string }
  ): Promise<void>
  removeImage(itemId: string, imageType: 'poster' | 'backdrop' | 'logo'): Promise<void>
  executeCustomAction(itemId: string, commandId: string): Promise<void>
  revealInExplorer(path: string): void
  trashItem(path: string): Promise<boolean>
  deleteItemFromDb(itemId: string): Promise<boolean>
  renameItem(oldPath: string, newName: string): Promise<boolean>
  getItemProperties(path: string): Promise<MediaProperties | null>
  selectLibraryDirectory(): Promise<string | null>
  selectMediaSourceDirectory(): Promise<string | null>
  getSettings(): Promise<Settings>
  getLibraryMediaSourcePath(): Promise<string | null>
  saveSettings(settings: Partial<Settings>): Promise<void>
  resolveMediaSourcePath(args: { path: string; isRelative: boolean }): Promise<string>
  minimizeWindow(): void
  toggleMaximizeWindow(): void
  closeWindow(): void
  isWindowMaximized(): Promise<boolean>
  onWindowMaximizedStatus(callback: (isMaximized: boolean) => void): () => void
  onLibraryItemDeleted(callback: (itemId: string) => void): () => void
  onLibraryItemsUpdated(callback: (items: LibraryItem[]) => void): () => void
  onAutocompleteSuggestionsUpdated(
    callback: (suggestions: AutocompleteSuggestions) => void
  ): () => void
  onShowErrorDialog(
    callback: (options: { title: string; message: string; detail?: string }) => void
  ): () => void
  onForceReloadForNewLibrary(callback: () => void): () => void
  onSettingsPossiblyUpdated(callback: (newSettings: Settings) => void): () => void
}

import { webApi } from './web-api'

const BASE_URL = 'http://localhost:3000'

/**
 * Returns a full HTTP URL for a library asset.
 * Replaces the old media-browser-asset:// protocol.
 */
export function getAssetUrl(relativePath: string): string {
  if (!relativePath) return ''
  return `${BASE_URL}/api/assets/${encodeURIComponent(relativePath)}`
}

export const api: ApiClient = webApi
