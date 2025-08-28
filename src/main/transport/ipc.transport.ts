import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import { dirname, resolve as resolvePath } from 'path'

import * as libraryService from '../services/library.service'
import * as settingsService from '../services/settings.service'
import * as pathService from '../services/paths.service'
import { loadDbIntoMemory } from '../services/library.service'
import { setLibraryDataPath } from '../services/paths.service'
import type { Settings, LibraryItem, AutocompleteSuggestions } from '../../shared/types'
import type { ITransport } from './transport.interface'

/**
 * A centralized error handler for IPC calls to show a dialog in the renderer.
 * @param options The title, message, and optional detail for the error dialog.
 */
function showErrorDialog(options: { title: string; message: string; detail?: string }) {
  BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', options)
}

/**
 * An Electron IPC implementation of the ITransport interface.
 * It handles communication between the core services and the renderer process.
 */
export class IpcTransport implements ITransport {
  // --- ITransport Implementation ---

  notifyLibraryItemsUpdated(items: LibraryItem[]): void {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send('library-items-updated', items)
    })
  }



  notifyAutocompleteSuggestionsUpdated(suggestions: AutocompleteSuggestions): void {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send('autocomplete-suggestions-updated', suggestions)
    })
  }

  notifyLibraryItemDeleted(itemId: string): void {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send('library-item-deleted', itemId)
    })
  }

  notifySettingsUpdated(newSettings: Settings): void {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send('settings-possibly-updated', newSettings)
    })
  }

  forceRendererReload(): void {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send('force-reload-for-new-library')
    })
  }

  /**
   * Registers all IPC handlers that bridge the renderer process to the service layer.
   * This should be called once at application startup.
   */
  initialize() {
    // --- Window Control IPC Handlers ---
    ipcMain.on('window-minimize', () => {
      BrowserWindow.getFocusedWindow()?.minimize()
    })
    ipcMain.on('window-toggle-maximize', () => {
      const window = BrowserWindow.getFocusedWindow()
      if (window) {
        if (window.isMaximized()) {
          window.unmaximize()
        } else {
          window.maximize()
        }
      }
    })
    ipcMain.on('window-close', () => {
      BrowserWindow.getFocusedWindow()?.close()
    })
    ipcMain.handle('is-window-maximized', (event) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      return window?.isMaximized() ?? false
    })

    // --- Library IPC Handlers ---
    ipcMain.handle('get-library-root', () => libraryService.getLibraryRoot())
    ipcMain.handle('get-library-media-source-path', () =>
      settingsService.getAbsoluteMediaSourcePath()
    )

    ipcMain.handle('refresh-library', async () => {
      try {
        const window = BrowserWindow.getFocusedWindow()
        if (!window) return null
        return await libraryService.refreshLibrary()
      } catch (e: any) {
        showErrorDialog({
          title: 'Refresh Failed',
          message: e.message || 'An unknown error occurred during the library refresh.',
          detail: e.detail
        })
        return await libraryService.getLibraryRoot()
      }
    })

    ipcMain.handle('perform-initial-scan', async (event) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return null
      try {
        const result = await dialog.showOpenDialog(window, {
          properties: ['openDirectory'],
          title: 'Select Media Folder'
        })
        if (result.canceled || result.filePaths.length === 0) {
          return await libraryService.getLibraryRoot()
        }
        return await libraryService.performInitialScan(result.filePaths[0])
      } catch (e: any) {
        showErrorDialog({ title: 'Initial Scan Failed', message: e.message })
        return null
      }
    })

    ipcMain.handle('perform-full-rescan', async (_, mediaSourcePath: string) => {
      try {
        return await libraryService.performFullRescan(mediaSourcePath)
      } catch (e: any) {
        showErrorDialog({ title: 'Full Rescan Failed', message: e.message })
        return null
      }
    })

    ipcMain.handle('get-item-details', (_, itemId: string) => libraryService.getItemDetails(itemId))
    ipcMain.handle('fetch-credits', (_, itemId: string) => libraryService.fetchCredits(itemId))
    ipcMain.handle('play-file-with', (_, file, command) =>
      libraryService.playFileWith(file, command, showErrorDialog)
    )
    ipcMain.handle('play-file', (_, file) => libraryService.playFile(file, showErrorDialog))

    ipcMain.handle('apply-initial-folder-settings', async (_, settings) => {
      libraryService.applyInitialFolderSettings(settings)
    })
    ipcMain.handle('clear-item-metadata', (_, itemId: string, childrenOnly: boolean) =>
      libraryService.clearItemMetadata(itemId, childrenOnly)
    )
    ipcMain.handle('clear-virtual-folder-metadata', (_, itemIds: string[]) =>
      libraryService.clearVirtualFolderMetadata(itemIds)
    )
    ipcMain.handle('get-autocomplete-suggestions', () =>
      libraryService.getAutocompleteSuggestions()
    )
    ipcMain.handle('user-update-item', (_, updatedItem) =>
      libraryService.updateItem(updatedItem, true)
    )


    ipcMain.handle('manual-search', async (_, query, type, year, tmdbId) => {
      const settings = await settingsService.readSettings()
      return libraryService.manualSearch(query, type, settings.tmdbApiKey, year, tmdbId)
    })

    ipcMain.handle('get-tmdb-images', async (_, tmdbId, mediaType, language) => {
      const settings = await settingsService.readSettings()
      return libraryService.getTmdbImages(tmdbId, mediaType, settings.tmdbApiKey, language)
    })
    ipcMain.handle('execute-custom-action', (_, itemId, commandId) =>
      libraryService.executeCustomAction(itemId, commandId, showErrorDialog)
    )
    ipcMain.handle('user-apply-tmdb-result', (_, itemId, result, mediaType) =>
      libraryService.applyTmdbResult(itemId, result, mediaType, showErrorDialog)
    )
    ipcMain.handle('mark-as-unwatched', (_, itemId) => libraryService.markAsUnwatched(itemId))
    ipcMain.handle('mark-as-watched', (_, itemId) => libraryService.markAsWatched(itemId))
    ipcMain.handle('get-folder-watched-state', (_, folderId) =>
      libraryService.getFolderWatchedState(folderId)
    )
    ipcMain.handle('assign-seasons-and-episodes', (_, showId, s1, s2, fm) =>
      libraryService.assignSeasonsAndEpisodes(showId, s1, s2, fm)
    )

    ipcMain.handle('select-local-image', async (event): Promise<string | null> => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return null
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        title: 'Select Image',
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    })

    ipcMain.handle('user-set-image', (_, itemId, imageType, source) =>
      libraryService.setImage(itemId, imageType, source, showErrorDialog)
    )
    ipcMain.handle('remove-image', (_, itemId, imageType) =>
      libraryService.removeImage(itemId, imageType)
    )

    ipcMain.on('reveal-in-explorer', async (_, relativePath: string) => {
      const absolutePath = await libraryService.getAbsolutePath(relativePath)
      if (!absolutePath) return
      if (pathService.isRemotePath(absolutePath)) {
        shell.openExternal(absolutePath)
      } else {
        shell.showItemInFolder(absolutePath)
      }
    })

    ipcMain.handle('trash-item', async (_, relativePath: string): Promise<boolean> => {
      if (pathService.isRemoteLibrary()) {
        showErrorDialog({
          title: 'Operation Not Supported',
          message: 'Deleting files is not available for remote libraries.'
        })
        return false
      }
      try {
        const absolutePath = await libraryService.getAbsolutePath(relativePath)
        if (!absolutePath) return false
        await shell.trashItem(absolutePath)
        // After successfully moving the item to trash, immediately update the
        // in-memory database to reflect the change without requiring a full refresh.
        await libraryService.handleItemRemovedByPath(relativePath)
        return true
      } catch (error: any) {
        showErrorDialog({
          title: 'Deletion Error',
          message: 'Failed to move item to trash. Check file permissions or see logs for details.',
          detail: (error as Error).message
        })
        return false
      }
    })

    ipcMain.handle('perform-search', (_, query) => libraryService.performSearch(query))
    ipcMain.handle('debug-perform-search', (_, query) => libraryService.debugPerformSearch(query))

    ipcMain.handle(
      'rename-item',
      async (_, relativeOldPath: string, newName: string): Promise<boolean> => {
        if (pathService.isRemoteLibrary()) {
          showErrorDialog({
            title: 'Operation Not Supported',
            message: 'Renaming items is not available for remote libraries.'
          })
          return false
        }
        const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
        if (!mediaSourcePath) return false
        const oldAbsolutePath = resolvePath(mediaSourcePath, relativeOldPath)
        const newAbsolutePath = resolvePath(dirname(oldAbsolutePath), newName)
        try {
          await settingsService.renameFS(oldAbsolutePath, newAbsolutePath)
          await libraryService.handleItemRenamed(relativeOldPath, newName)
          return true
        } catch (error: any) {
          showErrorDialog({
            title: 'Rename Error',
            message: 'Failed to rename item. Check file permissions or see logs for details.',
            detail: (error as Error).message
          })
          return false
        }
      }
    )

    ipcMain.handle('get-item-properties', (_, relativePath: string) =>
      libraryService.getItemProperties(relativePath)
    )

    ipcMain.handle('delete-item-from-db', async (_, itemId: string) => {
      return await libraryService.deleteItemFromDb(itemId)
    })

    ipcMain.handle('get-item-by-id', (_, itemId: string) => libraryService.getItemById(itemId))
    ipcMain.handle('get-children', (_, parentId: string) => libraryService.getChildren(parentId))
    ipcMain.handle('get-parent', (_, itemId: string) => libraryService.getParent(itemId))
    ipcMain.handle('get-hidden-children', (_, parentId: string) =>
      libraryService.getHiddenChildren(parentId)
    )
    ipcMain.handle('set-continue-watching-dismissed', (_, showId: string) =>
      libraryService.setContinueWatchingDismissed(showId)
    )
    ipcMain.handle('set-next-up-dismissed', (_, showId: string) =>
      libraryService.setNextUpDismissed(showId)
    )
    ipcMain.handle('get-continue-watching-items', () => libraryService.getContinueWatchingItems())
    ipcMain.handle('get-continue-watching-for-show', (_, showId) =>
      libraryService.getContinueWatchingForShow(showId)
    )

    // --- Settings IPC Handlers ---
    ipcMain.handle('get-settings', async () => settingsService.readSettings())
    ipcMain.handle(
      'resolve-media-source-path',
      (_, { path, isRelative }: { path: string; isRelative: boolean }) =>
        settingsService.resolveMediaSourcePath(path, isRelative)
    )

    ipcMain.handle('save-settings', async (_, settingsToSave: Partial<Settings>) => {
      const oldSettings = await settingsService.readSettings()

      if (
        settingsToSave.libraryLocation !== undefined &&
        settingsToSave.libraryLocation !== oldSettings.libraryLocation
      ) {
        console.log(
          `[IPC] Library location changing from "${oldSettings.libraryLocation}" to "${settingsToSave.libraryLocation}"`
        )
        await settingsService.writeGlobalSettings({
          libraryLocation: settingsToSave.libraryLocation
        })
        setLibraryDataPath(settingsToSave.libraryLocation)
        await loadDbIntoMemory()
        console.log('[IPC] New DB loaded. Forcing renderer reload.')
        this.forceRendererReload()
      } else {
        await settingsService.saveSettingsChanges(settingsToSave)
        const newSettings = await settingsService.readSettings()
        this.notifySettingsUpdated(newSettings)
      }
    })

    ipcMain.handle('select-library-directory', async (event) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return null
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory'],
        title: 'Select Library Data Folder'
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    })

    ipcMain.handle('select-media-source-directory', async (event) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return null
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory'],
        title: 'Select Media Folder'
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    })
  }
}
