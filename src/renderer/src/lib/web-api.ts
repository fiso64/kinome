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
} from '../../../shared/types'
import type { ApiClient } from './api'
import { authStore } from './auth-store.svelte'

const BASE_URL = ''
const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`

class WebApiClient implements ApiClient {
  private ws: WebSocket | null = null
  private eventHandlers: Map<string, Set<(data: any) => void>> = new Map()
  public readonly capabilities: AppCapabilities

  constructor() {
    this.connectWS()
    console.log('[WebApiClient] Initialized.')

    this.capabilities = {
      hasWindowControls: false,
      supportsLocalPlayback: false // Server cannot launch a player on the client's machine
    }
  }

  private connectWS() {
    console.log('[WebApiClient] Connecting to WebSocket...')
    this.ws = new WebSocket(WS_URL)

    this.ws.onopen = () => {
      console.log('[WebApiClient] WebSocket connected.')
    }

    this.ws.onmessage = (event) => {
      try {
        const { type, data } = JSON.parse(event.data)
        const handlers = this.eventHandlers.get(type)
        if (handlers) {
          handlers.forEach((handler) => handler(data))
        }
      } catch (e) {
        console.error('[WebApiClient] Failed to parse WS message:', e)
      }
    }

    this.ws.onclose = () => {
      console.warn('[WebApiClient] WebSocket closed. Retrying in 3s...')
      setTimeout(() => this.connectWS(), 3000)
    }

    this.ws.onerror = (error) => {
      console.error('[WebApiClient] WebSocket error:', error)
      this.ws?.close()
    }
  }

  private on(event: string, callback: (data: any) => void): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set())
    }
    this.eventHandlers.get(event)!.add(callback)
    return () => {
      this.eventHandlers.get(event)?.delete(callback)
    }
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${BASE_URL}${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(authStore.token ? { 'Authorization': `Bearer ${authStore.token}` } : {}),
        ...options?.headers
      }
    })

    if (!response.ok) {
      if (response.status === 401) {
        authStore.logout()
      }
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


  performInitialScan(path: string): Promise<MediaFolder | null> {
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

  getItemDetails(itemId: string, fields?: string[]): Promise<LibraryItem | null> {
    const params = new URLSearchParams()
    if (fields && fields.length > 0) params.set('fields', fields.join(','))
    return this.request(`/api/v2/items/${encodeURIComponent(itemId)}?${params.toString()}`)
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

  getChildren(
    parentId: string,
    options: { isDetailView?: boolean; fields?: string[] } = {}
  ): Promise<LibraryItem[] | null> {
    const params = new URLSearchParams()
    if (options.fields && options.fields.length > 0) params.set('fields', options.fields.join(','))
    if (options.isDetailView) params.set('isDetailView', 'true')
    return this.request(
      `/api/v2/items/${encodeURIComponent(parentId)}/children?${params.toString()}`
    )
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

  uploadImage(
    itemId: string,
    imageType: 'poster' | 'backdrop' | 'logo',
    file: File
  ): Promise<void> {
    const formData = new FormData()
    formData.append('itemId', itemId)
    formData.append('imageType', imageType)
    formData.append('file', file)

    // Manual fetch because this.request handles JSON by default
    return fetch('/api/upload-image', {
      method: 'POST',
      body: formData,
      headers: {
        ...(authStore.token ? { 'Authorization': `Bearer ${authStore.token}` } : {})
      }
    }).then((res) => {
      if (!res.ok) throw new Error('Upload failed')
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


  saveSettings(settings: Partial<Settings>): Promise<void> {
    return this.request('/api/save-settings', { method: 'POST', body: JSON.stringify(settings) })
  }

  changePassword(password: string): Promise<void> {
    return this.request('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({ password })
    })
  }

  getLibraryRoot(path?: string): Promise<LibraryStatus> {
    const url = path ? `/api/library-root?path=${encodeURIComponent(path)}` : '/api/library-root'
    return this.request(url)
  }

  resolveMediaSourcePath(args: {
    path: string
    isRelative: boolean
    libraryLocation?: string
  }): Promise<string> {
    return this.request<{ path: string }>('/api/resolve-media-source-path', {
      method: 'POST',
      body: JSON.stringify(args)
    }).then((r) => r.path)
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

  // --- Real-time updates (Native WS) ---

  onWindowMaximizedStatus(_callback: (isMaximized: boolean) => void): () => void {
    return () => { }
  }

  onLibraryItemDeleted(callback: (itemId: string) => void): () => void {
    return this.on('library-item-deleted', callback)
  }

  onLibraryItemsUpdated(callback: (items: LibraryItem[]) => void): () => void {
    return this.on('library-items-updated', callback)
  }

  onAutocompleteSuggestionsUpdated(
    callback: (suggestions: AutocompleteSuggestions) => void
  ): () => void {
    return this.on('autocomplete-suggestions-updated', callback)
  }

  onShowErrorDialog(
    _callback: (options: { title: string; message: string; detail?: string }) => void
  ): () => void {
    return () => { }
  }

  onForceReloadForNewLibrary(callback: () => void): () => void {
    return this.on('force-reload-for-new-library', callback)
  }

  onSettingsPossiblyUpdated(callback: (newSettings: Settings) => void): () => void {
    return this.on('settings-possibly-updated', callback)
  }

  onScanStatusChanged(callback: (status: ScanStatus) => void): () => void {
    return this.on('scan-status-changed', callback)
  }
}

export const webApi = new WebApiClient()
