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
import type { ApiClient } from './api'
import { authStore } from './auth-store.svelte'

const BASE_URL = ''
const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`

class WebApiClient implements ApiClient {
  private ws: WebSocket | null = null
  private retryTimeout: any = null
  private eventHandlers: Map<string, Set<(data: any) => void>> = new Map()
  public readonly capabilities: AppCapabilities

  constructor() {
    console.log('[WebApiClient] Initialized.')

    this.capabilities = {
      hasWindowControls: false,
      supportsLocalPlayback: false // Server cannot launch a player on the client's machine
    }
  }

  public connectWebSocket(token?: string) {
    this.connectWS(token)
  }

  private connectWS(token?: string) {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout)
      this.retryTimeout = null
    }

    if (this.ws) {
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }

    // GATING: Don't connect if we are not authenticated and server hasn't been confirmed as public
    if (!authStore.isAuthenticated && !authStore.allowUnauthenticated) {
      console.log('[WebApiClient] Waiting for authentication before connecting WebSocket.')
      return
    }

    const wsUrl = new URL(WS_URL)
    if (token) {
      wsUrl.searchParams.set('token', token)
    }

    console.log(`[WebApiClient] Connecting to WebSocket${token ? ' (Authenticated)' : ''}...`)
    this.ws = new WebSocket(wsUrl.toString())

    this.ws.onopen = () => {
      console.log('[WebApiClient] WebSocket connected.')
    }

    this.ws.onmessage = (event) => {
      try {
        const { type, data } = JSON.parse(event.data)

        // Log library updates specifically for debugging
        if (type === 'library-items-updated') {
          console.log(`[WebApiClient] Received '${type}' event with ${data?.length || 0} items`)
        } else {
          console.log(`[WebApiClient] Received '${type}' event`)
        }

        const handlers = this.eventHandlers.get(type)
        if (handlers) {
          console.log(`[WebApiClient] Dispatching '${type}' to ${handlers.size} handler(s)`)
          handlers.forEach((handler) => handler(data))
        } else {
          console.log(`[WebApiClient] No handlers registered for '${type}'`)
        }
      } catch (e) {
        console.error('[WebApiClient] Failed to parse WS message:', e)
      }
    }

    this.ws.onclose = () => {
      // Only retry if we are still supposed to be connected
      if (authStore.isAuthenticated || authStore.allowUnauthenticated) {
        console.warn('[WebApiClient] WebSocket closed. Retrying in 3s...')
        this.retryTimeout = setTimeout(() => this.connectWS(authStore.token), 3000)
      }
    }

    this.ws.onerror = (error) => {
      // Don't log full error object to console to reduce spam, just note the failure
      console.error('[WebApiClient] WebSocket connection failed.')
      this.ws?.close()
    }
  }

  private on(event: string, callback: (data: any) => void): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set())
    }
    this.eventHandlers.get(event)!.add(callback)
    console.log(`[WebApiClient] Registered handler for '${event}' (total: ${this.eventHandlers.get(event)!.size})`)
    return () => {
      this.eventHandlers.get(event)?.delete(callback)
      console.log(`[WebApiClient] Unregistered handler for '${event}' (remaining: ${this.eventHandlers.get(event)?.size || 0})`)
    }
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${BASE_URL}${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(authStore.token ? { Authorization: `Bearer ${authStore.token}` } : {}),
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

  // --- Unified Items API ---

  findItems(options: {
    fields?: string[]
    where?: Record<string, any>
    limit?: number
    offset?: number
    orderBy?: { field: string; direction: 'ASC' | 'DESC' }
    include?: string[]
    includeHidden?: boolean
  }): Promise<LibraryItem[]> {
    const params = new URLSearchParams()
    if (options.fields) params.set('fields', options.fields.join(','))
    if (options.limit) params.set('limit', options.limit.toString())
    if (options.offset) params.set('offset', options.offset.toString())
    if (options.orderBy)
      params.set('orderBy', `${options.orderBy.field}:${options.orderBy.direction}`)
    if (options.include) params.set('include', options.include.join(','))
    if (options.includeHidden !== undefined) params.set('includeHidden', String(options.includeHidden))

    if (options.where) {
      for (const [key, val] of Object.entries(options.where)) {
        if (val !== undefined && val !== null) params.set(key, String(val))
      }
    }

    return this.request(`/api/items?${params.toString()}`)
  }

  getItem(id: string, options: { fields?: string[]; include?: string[] } = {}): Promise<LibraryItem> {
    if (!id || id === 'null' || id === 'undefined') {
      console.warn(`[WebApiClient] getItem called with invalid ID: "${id}". Skipping request.`)
      return Promise.resolve(null as any)
    }

    const params = new URLSearchParams()
    if (options.fields) params.set('fields', options.fields.join(','))
    if (options.include) params.set('include', options.include.join(','))

    const q = params.toString() ? `?${params.toString()}` : ''
    return this.request(`/api/items/${encodeURIComponent(id)}${q}`)
  }

  getChildren(
    parentId: string,
    options: {
      limit?: number
      offset?: number
      fields?: string[]
      include?: string[]
      orderBy?: string
      groupBy?: string
      includeHidden?: boolean
    } = {}
  ): Promise<LibraryItem[]> {
    if (!parentId || parentId === 'null' || parentId === 'undefined') {
      console.warn(
        `[WebApiClient] getChildren called with invalid parentId: "${parentId}". Skipping request.`
      )
      return Promise.resolve([])
    }
    const params = new URLSearchParams()
    if (options.limit) params.set('limit', options.limit.toString())
    if (options.offset) params.set('offset', options.offset.toString())
    if (options.fields && options.fields.length > 0)
      params.set('fields', options.fields.join(','))
    if (options.include && options.include.length > 0)
      params.set('include', options.include.join(','))
    if (options.orderBy) params.set('orderBy', options.orderBy)
    if (options.groupBy) params.set('groupBy', options.groupBy)
    if (options.includeHidden !== undefined) params.set('includeHidden', String(options.includeHidden))

    return this.request(
      `/api/items/${encodeURIComponent(parentId)}/children?${params.toString()}`
    )
  }

  async userUpdateItem(item: Partial<LibraryItem>): Promise<void> {
    await this.request('/api/items', {
      method: 'PATCH',
      body: JSON.stringify(item)
    })
  }

  getAncestors(itemId: string): Promise<LibraryItem[]> {
    return this.request(`/api/items/${encodeURIComponent(itemId)}/ancestors`)
  }

  performSearch(query: {
    text: string
    tags: { key: string; value: string }[]
    limit?: number
  }): Promise<SearchIndexEntry[]> {
    return this.request('/api/perform-search', { method: 'POST', body: JSON.stringify(query) })
  }

  debugPerformSearch(query: {
    text: string
    tags: { key: string; value: string }[]
    limit?: number
  }): Promise<Record<string, unknown>> {
    return this.request('/api/perform-search', { method: 'POST', body: JSON.stringify(query) })
  }

  performScan(options: { path?: string; initialFolderSettings?: Record<string, any> } = {}): Promise<{ success: boolean }> {
    return this.request('/api/perform-scan', {
      method: 'POST',
      body: JSON.stringify(options)
    })
  }

  listDirectory(path: string): Promise<{ name: string; path: string; isDirectory: boolean }[]> {
    return this.request(`/api/list-directory?path=${encodeURIComponent(path)}`)
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


  getAutocompleteSuggestions(): Promise<AutocompleteSuggestions> {
    return this.request('/api/autocomplete/suggestions')
  }

  getAutocompleteValues(key: string, query?: string, limit?: number): Promise<string[]> {
    const params = new URLSearchParams()
    if (query) params.set('q', query)
    if (limit) params.set('limit', limit.toString())
    const q = params.toString() ? `?${params.toString()}` : ''
    return this.request(`/api/autocomplete/values/${encodeURIComponent(key)}${q}`)
  }

  getGroupByKeys(): Promise<string[]> {
    return this.request('/api/group-by-keys')
  }

  getItemById(itemId: string): Promise<LibraryItem | null> {
    return this.request(`/api/items/${encodeURIComponent(itemId)}`)
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

  getItemCredits(id: string): Promise<any | null> {
    return this.request(`/api/items/${encodeURIComponent(id)}/credits`)
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
        ...(authStore.token ? { Authorization: `Bearer ${authStore.token}` } : {})
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

  startHandlerTest(sessionId: string): Promise<{ success: boolean }> {
    return this.request('/api/start-handler-test', {
      method: 'POST',
      body: JSON.stringify({ sessionId })
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

  onMetadataIndexUpdated(
    callback: (index: { suggestions: AutocompleteSuggestions; groupByKeys: string[] }) => void
  ): () => void {
    return this.on('metadata-index-updated', callback)
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

  onHandlerTestSuccess(callback: (data: { sessionId: string }) => void): () => void {
    return this.on('handler-test-success', callback)
  }
}

export const webApi = new WebApiClient()
