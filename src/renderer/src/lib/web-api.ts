import { io, Socket } from 'socket.io-client'
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
  AppCapabilities
} from '../../../shared/types'
import type { ApiClient } from './api'

const BASE_URL = 'http://localhost:3000'

class WebApiClient implements ApiClient {
  private socket: Socket
  public readonly capabilities: AppCapabilities

  constructor() {
    this.socket = io(BASE_URL)
    console.log('[WebApiClient] Initialized.')

    this.capabilities = {
      hasWindowControls: false,
      supportsLocalPlayback: false // Server cannot launch a player on the client's machine
    }
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${BASE_URL}${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers
      }
    })

    if (!response.ok) {
      throw new Error(`API Error: ${response.statusText}`)
    }

    if (response.status === 204) return null as any

    const text = await response.text()
    try {
      // Handle empty body (200 OK with no content)
      if (!text) return null as any
      return JSON.parse(text)
    } catch (e) {
      // Debugging: Log the actual content that failed to parse
      console.warn(
        `[WebApiClient] Non-JSON response received from ${path}. Status: ${response.status}. Body: "${text}"`
      )

      // Fallback: If the server sent "OK" (Express sendStatus(200)), treat it as success/void.
      // If it sent other text, return it as the result.
      return text as unknown as T
    }
  }

  // --- V2 API Methods ---

  /**
   * Generic V2 Find
   */
  findV2(options: {
    fields?: string[]
    where?: Record<string, any>
    limit?: number
    offset?: number
    orderBy?: { field: string; direction: 'ASC' | 'DESC' }
    include?: string[]
  }): Promise<LibraryItem[]> {
    const params = new URLSearchParams()
    if (options.fields) params.set('fields', options.fields.join(','))
    if (options.limit) params.set('limit', options.limit.toString())
    if (options.offset) params.set('offset', options.offset.toString())
    if (options.orderBy)
      params.set('orderBy', `${options.orderBy.field}:${options.orderBy.direction}`)
    if (options.include) params.set('include', options.include.join(','))

    if (options.where) {
      for (const [key, val] of Object.entries(options.where)) {
        if (val !== undefined && val !== null) params.set(key, String(val))
      }
    }

    return this.request(`/api/v2/items?${params.toString()}`)
  }

  getItemV2(id: string, include: string[] = []): Promise<LibraryItem> {
    if (!id || id === 'null' || id === 'undefined') {
      console.warn(`[WebApiClient] getItemV2 called with invalid ID: "${id}". Skipping request.`)
      return Promise.resolve(null as any)
    }
    const params = new URLSearchParams()
    if (include.length > 0) params.set('include', include.join(','))
    return this.request(`/api/v2/items/${encodeURIComponent(id)}?${params.toString()}`)
  }

  getChildrenV2(
    parentId: string,
    options: {
      limit?: number
      offset?: number
      include?: string[]
      orderBy?: string
      groupBy?: string
    } = {}
  ): Promise<LibraryItem[]> {
    if (!parentId || parentId === 'null' || parentId === 'undefined') {
      console.warn(
        `[WebApiClient] getChildrenV2 called with invalid parentId: "${parentId}". Skipping request.`
      )
      return Promise.resolve([])
    }
    const params = new URLSearchParams()
    if (options.limit) params.set('limit', options.limit.toString())
    if (options.offset) params.set('offset', options.offset.toString())
    if (options.include && options.include.length > 0)
      params.set('include', options.include.join(','))
    if (options.orderBy) params.set('orderBy', options.orderBy) // Expects "field:DESC" format or let backend decide
    if (options.groupBy) params.set('groupBy', options.groupBy)

    return this.request(
      `/api/v2/items/${encodeURIComponent(parentId)}/children?${params.toString()}`
    )
  }

  // --- Legacy / V1 Methods ---

  performSearch(query: {
    text: string
    tags: { key: string; value: string }[]
  }): Promise<SearchIndexEntry[]> {
    return this.request('/api/perform-search', { method: 'POST', body: JSON.stringify(query) })
  }

  debugPerformSearch(query: {
    text: string
    tags: { key: string; value: string }[]
  }): Promise<Record<string, unknown>> {
    return this.request('/api/perform-search', { method: 'POST', body: JSON.stringify(query) }) // Same endpoint for now
  }

  getLibraryRoot(): Promise<MediaFolder | null> {
    return this.request('/api/library-root')
  }

  performInitialScan(path?: string): Promise<MediaFolder | null> {
    return this.request('/api/perform-initial-scan', {
      method: 'POST',
      body: JSON.stringify({ path })
    })
  }

  performFullRescan(newPath: string): Promise<MediaFolder | null> {
    return this.request('/api/perform-full-rescan', {
      method: 'POST',
      body: JSON.stringify({ path: newPath })
    })
  }

  refreshLibrary(): Promise<MediaFolder | null> {
    return this.request('/api/refresh-library', { method: 'POST' })
  }

  playFile(file: MediaFile): Promise<boolean> {
    return this.request<{ success: boolean }>('/api/play-file', {
      method: 'POST',
      body: JSON.stringify({ file })
    }).then((r) => r.success)
  }

  playFileWith(file: MediaFile, command: string): Promise<boolean> {
    return this.request<{ success: boolean }>('/api/play-file-with', {
      method: 'POST',
      body: JSON.stringify({ file, command })
    }).then((r) => r.success)
  }

  recordPlayback(itemId: string): Promise<void> {
    return this.request('/api/record-playback', {
      method: 'POST',
      body: JSON.stringify({ itemId })
    })
  }

  getItemDetails(itemId: string): Promise<LibraryItem | null> {
    return this.request(`/api/item-details/${encodeURIComponent(itemId)}`)
  }

  userUpdateItem(item: LibraryItem): Promise<void> {
    return this.request('/api/user-update-item', { method: 'POST', body: JSON.stringify(item) })
  }

  getAutocompleteSuggestions(): Promise<AutocompleteSuggestions> {
    return this.request('/api/autocomplete-suggestions')
  }

  getItemById(itemId: string): Promise<LibraryItem | null> {
    return this.request(`/api/item-by-id/${encodeURIComponent(itemId)}`)
  }

  getChildren(parentId: string): Promise<LibraryItem[] | null> {
    return this.request(`/api/children/${encodeURIComponent(parentId)}`)
  }

  getHiddenChildren(parentId: string): Promise<LibraryItem[]> {
    return this.request(`/api/hidden-children/${encodeURIComponent(parentId)}`)
  }

  getParent(itemId: string): Promise<MediaFolder | null> {
    return this.request(`/api/parent/${encodeURIComponent(itemId)}`)
  }

  getContinueWatchingItems(): Promise<{ show: MediaFolder; nextEpisode: MediaFile }[]> {
    return this.request('/api/continue-watching-items')
  }

  getContinueWatchingForShow(
    showId: string
  ): Promise<{ show: MediaFolder; nextEpisode: MediaFile } | null> {
    return this.request(`/api/continue-watching-for-show/${encodeURIComponent(showId)}`)
  }

  setContinueWatchingDismissed(showId: string): Promise<void> {
    return this.request('/api/dismiss-continue-watching', {
      method: 'POST',
      body: JSON.stringify({ itemId: showId })
    })
  }

  setNextUpDismissed(showId: string): Promise<void> {
    return this.request('/api/dismiss-next-up', {
      method: 'POST',
      body: JSON.stringify({ itemId: showId })
    })
  }

  applyInitialFolderSettings(
    settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]
  ): Promise<void> {
    return this.request('/api/apply-initial-folder-settings', {
      method: 'POST',
      body: JSON.stringify({ settings })
    })
  }

  clearItemMetadata(itemId: string, childrenOnly: boolean): Promise<boolean> {
    return this.request<{ success: boolean }>('/api/clear-item-metadata', {
      method: 'POST',
      body: JSON.stringify({ itemId, childrenOnly })
    }).then((r) => r.success)
  }

  clearVirtualFolderMetadata(itemIds: string[]): Promise<boolean> {
    return this.request<{ success: boolean }>('/api/clear-virtual-folder-metadata', {
      method: 'POST',
      body: JSON.stringify({ itemIds })
    }).then((r) => r.success)
  }

  fetchCredits(itemId: string): Promise<void> {
    return this.request('/api/fetch-credits', { method: 'POST', body: JSON.stringify({ itemId }) })
  }

  assignSeasonsAndEpisodes(
    showId: string,
    seasonStrategy: 'smart' | 'alphabetic',
    episodeStrategy: 'smart' | 'alphabetic',
    fetchMetadata: boolean
  ): Promise<void> {
    return this.request('/api/assign-seasons-and-episodes', {
      method: 'POST',
      body: JSON.stringify({ showId, seasonStrategy, episodeStrategy, fetchMetadata })
    })
  }

  manualSearch(
    query: string,
    type: 'movie' | 'tv' | 'season',
    year?: string,
    tmdbId?: string
  ): Promise<TmdbSearchResult[]> {
    return this.request('/api/manual-search', {
      method: 'POST',
      body: JSON.stringify({ query, type, year, tmdbId })
    })
  }

  getTmdbImages(
    tmdbId: number,
    mediaType: 'movie' | 'tv',
    language: string
  ): Promise<TmdbImageResults> {
    return this.request('/api/get-tmdb-images', {
      method: 'POST',
      body: JSON.stringify({ tmdbId, mediaType, language })
    })
  }

  applyManualMatch(
    itemId: string,
    result: TmdbSearchResult,
    mediaType: 'movie' | 'tv' | 'season'
  ): Promise<void> {
    return this.request('/api/user-apply-tmdb-result', {
      method: 'POST',
      body: JSON.stringify({ itemId, result, mediaType })
    })
  }

  markAsWatched(itemId: string): Promise<void> {
    return this.request('/api/mark-watched', { method: 'POST', body: JSON.stringify({ itemId }) })
  }

  markAsUnwatched(itemId: string): Promise<void> {
    return this.request('/api/mark-unwatched', { method: 'POST', body: JSON.stringify({ itemId }) })
  }

  getFolderWatchedState(folderId: string): Promise<'fully' | 'partially' | 'unwatched' | 'none'> {
    return this.request<{ state: any }>(
      '/api/folder-watched-state/' + encodeURIComponent(folderId)
    ).then((r) => r.state)
  }

  setImage(
    itemId: string,
    imageType: 'poster' | 'backdrop' | 'logo',
    source: { type: 'tmdb'; path: string } | { type: 'local'; path: string }
  ): Promise<void> {
    return this.request('/api/user-set-image', {
      method: 'POST',
      body: JSON.stringify({ itemId, imageType, source })
    })
  }

  removeImage(itemId: string, imageType: 'poster' | 'backdrop' | 'logo'): Promise<void> {
    return this.request('/api/remove-image', {
      method: 'POST',
      body: JSON.stringify({ itemId, imageType })
    })
  }

  executeCustomAction(itemId: string, commandId: string): Promise<void> {
    return this.request('/api/execute-custom-action', {
      method: 'POST',
      body: JSON.stringify({ itemId, commandId })
    })
  }

  revealInExplorer(path: string): void {
    this.request('/api/reveal-in-explorer', { method: 'POST', body: JSON.stringify({ path }) })
  }

  trashItem(path: string): Promise<boolean> {
    return this.request<{ success: boolean }>('/api/trash-item', {
      method: 'POST',
      body: JSON.stringify({ path })
    }).then((r) => r.success)
  }

  deleteItemFromDb(itemId: string): Promise<boolean> {
    return this.request<{ success: boolean }>('/api/delete-item-from-db', {
      method: 'POST',
      body: JSON.stringify({ itemId })
    }).then((r) => r.success)
  }

  renameItem(oldPath: string, newName: string): Promise<boolean> {
    return this.request<{ success: boolean }>('/api/rename-item', {
      method: 'POST',
      body: JSON.stringify({ oldPath, newName })
    }).then((r) => r.success)
  }

  getItemProperties(path: string): Promise<MediaProperties | null> {
    return this.request(`/api/item-properties/${encodeURIComponent(path)}`)
  }

  getSettings(): Promise<Settings> {
    return this.request('/api/settings')
  }

  getLibraryMediaSourcePath(): Promise<string | null> {
    return this.request('/api/library-media-source-path')
  }

  saveSettings(settings: Partial<Settings>): Promise<void> {
    return this.request('/api/save-settings', { method: 'POST', body: JSON.stringify(settings) })
  }

  resolveMediaSourcePath(args: { path: string; isRelative: boolean }): Promise<string> {
    return this.request('/api/resolve-media-source-path', {
      method: 'POST',
      body: JSON.stringify(args)
    })
  }

  // --- No-ops for web mode ---
  minimizeWindow(): void {
    console.log('Minimize window (No-op on web)')
  }
  toggleMaximizeWindow(): void {
    console.log('Maximize window (No-op on web)')
  }
  closeWindow(): void {
    console.log('Close window (No-op on web)')
  }
  isWindowMaximized(): Promise<boolean> {
    return Promise.resolve(false)
  }

  // --- Real-time updates (Socket.io) ---

  onWindowMaximizedStatus(_callback: (isMaximized: boolean) => void): () => void {
    return () => { }
  }

  onLibraryItemDeleted(callback: (itemId: string) => void): () => void {
    const handler = (itemId: string) => callback(itemId)
    this.socket.on('library-item-deleted', handler)
    return () => this.socket.off('library-item-deleted', handler)
  }

  onLibraryItemsUpdated(callback: (items: LibraryItem[]) => void): () => void {
    const handler = (items: LibraryItem[]) => callback(items)
    this.socket.on('library-items-updated', handler)
    return () => this.socket.off('library-items-updated', handler)
  }

  onAutocompleteSuggestionsUpdated(
    callback: (suggestions: AutocompleteSuggestions) => void
  ): () => void {
    const handler = (suggestions: AutocompleteSuggestions) => callback(suggestions)
    this.socket.on('autocomplete-suggestions-updated', handler)
    return () => this.socket.off('autocomplete-suggestions-updated', handler)
  }

  onShowErrorDialog(
    _callback: (options: { title: string; message: string; detail?: string }) => void
  ): () => void {
    return () => { }
  }

  onForceReloadForNewLibrary(callback: () => void): () => void {
    const handler = () => callback()
    this.socket.on('force-reload-for-new-library', handler)
    return () => this.socket.off('force-reload-for-new-library', handler)
  }

  onSettingsPossiblyUpdated(callback: (newSettings: Settings) => void): () => void {
    const handler = (newSettings: Settings) => callback(newSettings)
    this.socket.on('settings-possibly-updated', handler)
    return () => this.socket.off('settings-possibly-updated', handler)
  }
}

export const webApi = new WebApiClient()
