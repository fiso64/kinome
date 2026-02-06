import type {
  Settings,
  MediaFile,
  MediaFolder,
  LibraryItem,
  AutocompleteSuggestions,
  SearchIndexEntry,
  TmdbSearchResult,
  TmdbImageResults,
  MediaProperties,
  AppCapabilities,
  LibraryStatus,
  ScanStatus
} from '@shared/types'

export interface ApiClient {
  readonly capabilities: AppCapabilities

  // V2 Methods
  findV2(options: {
    fields?: string[]
    where?: Record<string, any>
    limit?: number
    offset?: number
    orderBy?: { field: string; direction: 'ASC' | 'DESC' }
    include?: string[]
  }): Promise<LibraryItem[]>

  getItemV2(id: string, include?: string[]): Promise<LibraryItem>
  getChildrenV2(
    parentId: string,
    options?: {
      limit?: number
      offset?: number
      include?: string[]
      orderBy?: string
      groupBy?: string
    }
  ): Promise<LibraryItem[]>
  getAncestors?: (itemId: string) => Promise<LibraryItem[]>

  performSearch(query: {
    text: string
    tags: { key: string; value: string }[]
    limit?: number
  }): Promise<SearchIndexEntry[]>
  debugPerformSearch(query: {
    text: string
    tags: { key: string; value: string }[]
    limit?: number
  }): Promise<Record<string, unknown>>
  getLibraryRoot(path?: string): Promise<LibraryStatus>
  listDirectory(path: string): Promise<{ name: string; path: string; isDirectory: boolean }[]>
  performScan(options?: { path?: string; initialFolderSettings?: Record<string, any> }): Promise<{ success: boolean }>
  playFile(file: MediaFile): Promise<boolean>
  playFileWith(file: MediaFile, command: string): Promise<boolean>
  recordPlayback(itemId: string): Promise<void>
  getItemDetails(itemId: string, fields?: string[]): Promise<LibraryItem | null>
  userUpdateItem(item: LibraryItem): Promise<void>
  getAutocompleteSuggestions(): Promise<AutocompleteSuggestions>
  getAutocompleteValues(key: string, query?: string, limit?: number): Promise<string[]>
  getGroupByKeys(): Promise<string[]>
  getItemById(itemId: string): Promise<LibraryItem | null>
  getChildren(
    parentId: string,
    options?: { isDetailView?: boolean; fields?: string[] }
  ): Promise<LibraryItem[] | null>
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
  applyManualMatch(
    itemId: string,
    result: TmdbSearchResult,
    mediaType: 'movie' | 'tv' | 'season'
  ): Promise<void>
  markAsWatched(itemId: string): Promise<void>
  markAsUnwatched(itemId: string): Promise<void>
  getFolderWatchedState(folderId: string): Promise<'fully' | 'partially' | 'unwatched' | 'none'>
  // Native file picking (selectLocalImage) removed in favor of future client-side upload or server-browser.
  setImage(
    itemId: string,
    imageType: 'poster' | 'backdrop' | 'logo',
    source: { type: 'tmdb'; path: string } | { type: 'local'; path: string }
  ): Promise<void>
  removeImage(itemId: string, imageType: 'poster' | 'backdrop' | 'logo'): Promise<void>
  uploadImage(itemId: string, imageType: 'poster' | 'backdrop' | 'logo', file: File): Promise<void>
  executeCustomAction(itemId: string, commandId: string): Promise<void>
  revealInExplorer(path: string): void
  trashItem(path: string): Promise<boolean>
  deleteItemFromDb(itemId: string): Promise<boolean>
  renameItem(oldPath: string, newName: string): Promise<boolean>
  getItemProperties(path: string): Promise<MediaProperties | null>
  // Native directory picking (selectLibraryDirectory, selectMediaSourceDirectory) removed.
  getSettings(): Promise<Settings>
  saveSettings(settings: Partial<Settings>): Promise<void>
  changePassword(password: string): Promise<void>
  resolveMediaSourcePath(args: {
    path: string
    isRelative: boolean
    libraryLocation?: string
  }): Promise<string>
  minimizeWindow(): void
  toggleMaximizeWindow(): void
  closeWindow(): void
  isWindowMaximized(): Promise<boolean>
  onWindowMaximizedStatus(callback: (isMaximized: boolean) => void): () => void
  onLibraryItemDeleted(callback: (itemId: string) => void): () => void
  onLibraryItemsUpdated(callback: (items: LibraryItem[]) => void): () => void
  onMetadataIndexUpdated(
    callback: (index: { suggestions: AutocompleteSuggestions; groupByKeys: string[] }) => void
  ): () => void
  onShowErrorDialog(
    callback: (options: { title: string; message: string; detail?: string }) => void
  ): () => void
  onForceReloadForNewLibrary(callback: () => void): () => void
  onSettingsPossiblyUpdated(callback: (newSettings: Settings) => void): () => void
  onScanStatusChanged(callback: (status: ScanStatus) => void): () => void
  connectWebSocket(token?: string): void
}

import { webApi } from './web-api'

import { authStore } from './auth-store.svelte'

/**
 * Returns a partial URL for a library asset.
 */
export function getAssetUrl(relativePath: string): string {
  if (!relativePath) return ''
  // Split query string to avoid encoding it
  const [path, query] = relativePath.split('?')
  const url = `/api/assets/${encodeURIComponent(path)}${query ? `?${query}` : ''}`
  const joiner = url.includes('?') ? '&' : '?'
  return authStore.token ? `${url}${joiner}token=${authStore.token}` : url
}

/**
 * Returns a full HTTP URL for a playlist.
 */
export function getPlaylistUrl(itemId: string): string {
  if (!itemId) return ''
  const url = `${window.location.origin}/api/playlist/${itemId}`
  return authStore.token ? `${url}?token=${authStore.token}` : url
}

/**
 * Returns a full HTTP URL for downloading a file.
 */
export function getDownloadUrl(itemId: string): string {
  if (!itemId) return ''
  const url = `${window.location.origin}/api/download/${itemId}`
  return authStore.token ? `${url}?token=${authStore.token}` : url
}

export const api: ApiClient = webApi
