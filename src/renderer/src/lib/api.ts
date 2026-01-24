import type {
    Settings,
    MediaFile,
    MediaFolder,
    LibraryItem,
    AutocompleteSuggestions,
    SearchIndexEntry
} from '../../../shared/types'

export interface ApiClient {
    performSearch(query: {
        text: string
        tags: { key: string; value: string }[]
    }): Promise<SearchIndexEntry[]>
    debugPerformSearch(query: { text: string; tags: { key: string; value: string }[] }): Promise<any>
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
    ): Promise<any[]>
    getTmdbImages(
        tmdbId: number,
        mediaType: 'movie' | 'tv',
        language: string
    ): Promise<{ posters: any[]; backdrops: any[]; logos: any[] }>
    applyTmdbResult(
        itemId: string,
        result: any,
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
    getItemProperties(path: string): Promise<any | null>
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

// In the future, this class can be swapped for a REST/WebSocket client
class ElectronApiClient implements ApiClient {
    performSearch(query: {
        text: string
        tags: { key: string; value: string }[]
    }): Promise<SearchIndexEntry[]> {
        return window.api.performSearch(query)
    }
    debugPerformSearch(query: { text: string; tags: { key: string; value: string }[] }): Promise<any> {
        return window.api.debugPerformSearch(query)
    }
    getLibraryRoot(): Promise<MediaFolder | null> {
        return window.api.getLibraryRoot()
    }
    performInitialScan(): Promise<MediaFolder | null> {
        return window.api.performInitialScan()
    }
    performFullRescan(newPath: string): Promise<MediaFolder | null> {
        return window.api.performFullRescan(newPath)
    }
    refreshLibrary(): Promise<MediaFolder | null> {
        return window.api.refreshLibrary()
    }
    playFile(file: MediaFile): Promise<boolean> {
        return window.api.playFile(file)
    }
    playFileWith(file: MediaFile, command: string): Promise<boolean> {
        return window.api.playFileWith(file, command)
    }
    getItemDetails(itemId: string): Promise<LibraryItem | null> {
        return window.api.getItemDetails(itemId)
    }
    userUpdateItem(item: LibraryItem): Promise<void> {
        return window.api.userUpdateItem(item)
    }
    getAutocompleteSuggestions(): Promise<AutocompleteSuggestions> {
        return window.api.getAutocompleteSuggestions()
    }
    getItemById(itemId: string): Promise<LibraryItem | null> {
        return window.api.getItemById(itemId)
    }
    getChildren(parentId: string): Promise<LibraryItem[] | null> {
        return window.api.getChildren(parentId)
    }
    getHiddenChildren(parentId: string): Promise<LibraryItem[]> {
        return window.api.getHiddenChildren(parentId)
    }
    getParent(itemId: string): Promise<MediaFolder | null> {
        return window.api.getParent(itemId)
    }
    getContinueWatchingItems(): Promise<{ show: MediaFolder; nextEpisode: MediaFile }[]> {
        return window.api.getContinueWatchingItems()
    }
    getContinueWatchingForShow(
        showId: string
    ): Promise<{ show: MediaFolder; nextEpisode: MediaFile } | null> {
        return window.api.getContinueWatchingForShow(showId)
    }
    setContinueWatchingDismissed(showId: string): Promise<void> {
        return window.api.setContinueWatchingDismissed(showId)
    }
    setNextUpDismissed(showId: string): Promise<void> {
        return window.api.setNextUpDismissed(showId)
    }
    applyInitialFolderSettings(
        settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]
    ): Promise<void> {
        return window.api.applyInitialFolderSettings(settings)
    }
    clearItemMetadata(itemId: string, childrenOnly: boolean): Promise<boolean> {
        return window.api.clearItemMetadata(itemId, childrenOnly)
    }
    clearVirtualFolderMetadata(itemIds: string[]): Promise<boolean> {
        return window.api.clearVirtualFolderMetadata(itemIds)
    }
    fetchCredits(itemId: string): Promise<void> {
        return window.api.fetchCredits(itemId)
    }
    assignSeasonsAndEpisodes(
        showId: string,
        seasonStrategy: 'smart' | 'alphabetic',
        episodeStrategy: 'smart' | 'alphabetic',
        fetchMetadata: boolean
    ): Promise<void> {
        return window.api.assignSeasonsAndEpisodes(
            showId,
            seasonStrategy,
            episodeStrategy,
            fetchMetadata
        )
    }
    manualSearch(
        query: string,
        type: 'movie' | 'tv' | 'season',
        year?: string,
        tmdbId?: string
    ): Promise<any[]> {
        return window.api.manualSearch(query, type, year, tmdbId)
    }
    getTmdbImages(
        tmdbId: number,
        mediaType: 'movie' | 'tv',
        language: string
    ): Promise<{ posters: any[]; backdrops: any[]; logos: any[] }> {
        return window.api.getTmdbImages(tmdbId, mediaType, language)
    }
    applyTmdbResult(
        itemId: string,
        result: any,
        mediaType: 'movie' | 'tv' | 'season'
    ): Promise<void> {
        return window.api.applyTmdbResult(itemId, result, mediaType)
    }
    markAsWatched(itemId: string): Promise<void> {
        return window.api.markAsWatched(itemId)
    }
    markAsUnwatched(itemId: string): Promise<void> {
        return window.api.markAsUnwatched(itemId)
    }
    getFolderWatchedState(folderId: string): Promise<'fully' | 'partially' | 'unwatched' | 'none'> {
        return window.api.getFolderWatchedState(folderId)
    }
    selectLocalImage(): Promise<string | null> {
        return window.api.selectLocalImage()
    }
    setImage(
        itemId: string,
        imageType: 'poster' | 'backdrop' | 'logo',
        source: { type: 'tmdb'; path: string } | { type: 'local'; path: string }
    ): Promise<void> {
        return window.api.setImage(itemId, imageType, source)
    }
    removeImage(itemId: string, imageType: 'poster' | 'backdrop' | 'logo'): Promise<void> {
        return window.api.removeImage(itemId, imageType)
    }
    executeCustomAction(itemId: string, commandId: string): Promise<void> {
        return window.api.executeCustomAction(itemId, commandId)
    }
    revealInExplorer(path: string): void {
        window.api.revealInExplorer(path)
    }
    trashItem(path: string): Promise<boolean> {
        return window.api.trashItem(path)
    }
    deleteItemFromDb(itemId: string): Promise<boolean> {
        return window.api.deleteItemFromDb(itemId)
    }
    renameItem(oldPath: string, newName: string): Promise<boolean> {
        return window.api.renameItem(oldPath, newName)
    }
    getItemProperties(path: string): Promise<any | null> {
        return window.api.getItemProperties(path)
    }
    selectLibraryDirectory(): Promise<string | null> {
        return window.api.selectLibraryDirectory()
    }
    selectMediaSourceDirectory(): Promise<string | null> {
        return window.api.selectMediaSourceDirectory()
    }
    getSettings(): Promise<Settings> {
        return window.api.getSettings()
    }
    getLibraryMediaSourcePath(): Promise<string | null> {
        return window.api.getLibraryMediaSourcePath()
    }
    saveSettings(settings: Partial<Settings>): Promise<void> {
        return window.api.saveSettings(settings)
    }
    resolveMediaSourcePath(args: { path: string; isRelative: boolean }): Promise<string> {
        return window.api.resolveMediaSourcePath(args)
    }
    minimizeWindow(): void {
        window.api.minimizeWindow()
    }
    toggleMaximizeWindow(): void {
        window.api.toggleMaximizeWindow()
    }
    closeWindow(): void {
        window.api.closeWindow()
    }
    isWindowMaximized(): Promise<boolean> {
        return window.api.isWindowMaximized()
    }
    onWindowMaximizedStatus(callback: (isMaximized: boolean) => void): () => void {
        return window.api.onWindowMaximizedStatus(callback)
    }
    onLibraryItemDeleted(callback: (itemId: string) => void): () => void {
        return window.api.onLibraryItemDeleted(callback)
    }
    onLibraryItemsUpdated(callback: (items: LibraryItem[]) => void): () => void {
        return window.api.onLibraryItemsUpdated(callback)
    }
    onAutocompleteSuggestionsUpdated(
        callback: (suggestions: AutocompleteSuggestions) => void
    ): () => void {
        return window.api.onAutocompleteSuggestionsUpdated(callback)
    }
    onShowErrorDialog(
        callback: (options: { title: string; message: string; detail?: string }) => void
    ): () => void {
        return window.api.onShowErrorDialog(callback)
    }
    onForceReloadForNewLibrary(callback: () => void): () => void {
        return window.api.onForceReloadForNewLibrary(callback)
    }
    onSettingsPossiblyUpdated(callback: (newSettings: Settings) => void): () => void {
        return window.api.onSettingsPossiblyUpdated(callback)
    }
}

export const api = new ElectronApiClient()
