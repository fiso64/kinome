// This MUST be the first import to ensure the library path is set before
// any other module that depends on it is loaded.
import './startup'

import { app, shell, BrowserWindow, ipcMain, protocol, dialog, net } from 'electron'
import { join, resolve as resolvePath, relative, dirname } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, is } from '@electron-toolkit/utils'
import { setupLibraryIpc, reapplyVirtualTagsAfterSettingsChange, loadDbIntoMemory } from './library'
import { setLibraryDataPath, isRemoteLibrary, resolveLibraryPath } from './paths'
import { readSettings, writeLibrarySettings, writeGlobalSettings } from './settings'
import type { Settings } from '../shared/types'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    title: 'Media Browser',
    frame: false,
    backgroundColor: '#1b1b1f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Start maximized
  mainWindow.maximize()

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-is-maximized', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-is-maximized', false)
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  console.log(`[${new Date().toISOString()}] [Main] App is ready.`)

  protocol.handle('media-browser-asset', (request) => {
    try {
      let pathString = request.url.substring('media-browser-asset://'.length)
      const queryIndex = pathString.indexOf('?')
      if (queryIndex !== -1) {
        pathString = pathString.substring(0, queryIndex)
      }
      const relativePath = decodeURIComponent(pathString)
      const fullPathOrUrl = resolveLibraryPath(relativePath)

      if (isRemoteLibrary()) {
        // For remote libraries, fetch the resource from the remote URL and return the response.
        return net.fetch(fullPathOrUrl)
      } else {
        // For local libraries, convert the absolute path to a file URL and fetch it.
        return net.fetch(pathToFileURL(fullPathOrUrl).toString())
      }
    } catch (e) {
      console.error(`[Protocol Handler] Failed to handle ${request.url}:`, e)
      // Return a 404 response on error.
      return new Response(null, { status: 404 })
    }
  })

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    // Removed if (is.dev) to allow F12 and Ctrl+R in production
    window.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') {
        if (window.webContents.isDevToolsOpened()) {
          window.webContents.closeDevTools()
        } else {
          // You might want to restrict the mode in production, e.g., mode: 'detach'
          // or only open if a specific flag is passed or setting is enabled.
          // For now, keeping it as 'right'.
          window.webContents.openDevTools({ mode: 'right' })
        }
        event.preventDefault()
      }
      // Ctrl+R for reloading the renderer process.
      // Be cautious with this in production as it might confuse users or lose state.
      if (input.control && input.key.toLowerCase() === 'r') {
        window.webContents.reload()
        event.preventDefault()
      }
    })
  })

  setupLibraryIpc()

  // --- Settings IPC Handlers ---
  ipcMain.handle('get-settings', async () => {
    return await readSettings()
  })

  ipcMain.handle('save-settings', async (_, settingsToSave: Partial<Settings>) => {
    const oldSettings = await readSettings() // Reads combined settings of the CURRENT library

    if (
      settingsToSave.libraryLocation !== undefined &&
      settingsToSave.libraryLocation !== oldSettings.libraryLocation
    ) {
      // --- Library Location IS Changing ---
      console.log(
        `[Main] Library location changing from "${oldSettings.libraryLocation}" to "${settingsToSave.libraryLocation}"`
      )
      await writeGlobalSettings({ libraryLocation: settingsToSave.libraryLocation })
      setLibraryDataPath(settingsToSave.libraryLocation)

      // The DB and settings for the new library will be loaded.
      // Any other settings in `settingsToSave` are for the *old* library context
      // and should NOT be written to the new library-settings.json at this stage.
      await loadDbIntoMemory() // This will now use the new library path and read its settings.
      console.log('[Main] New DB loaded. Forcing renderer reload.')
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send('force-reload-for-new-library')
      })
      // IMPORTANT: Do not proceed to write other settings from settingsToSave.
      // The renderer will reload and fetch fresh settings from the new library context.
    } else {
      // --- Library Location is NOT Changing (or not specified in settingsToSave) ---
      // We are saving settings for the CURRENT library.
      console.log('[Main] Saving settings for current library.')

      // Create a copy of settingsToSave, excluding libraryLocation as it's global.
      const { libraryLocation: discardedLibLoc, ...settingsForCurrentLibrary } = settingsToSave

      // Handle media path relativity conversion for the CURRENT library
      const newRelativity = settingsForCurrentLibrary.mediaSourcePathIsRelative
      const oldRelativity = oldSettings.mediaSourcePathIsRelative // from current library's settings

      if (
        newRelativity !== undefined &&
        newRelativity !== oldRelativity &&
        oldSettings.mediaSourcePath // only convert if mediaSourcePath exists for current library
      ) {
        console.log(
          `[Main] Converting mediaSourcePath relativity. New: ${newRelativity}, Old: ${oldRelativity}`
        )
        if (newRelativity === true) {
          // from absolute to relative
          if (oldSettings.libraryLocation) {
            // Use current libraryLocation for conversion
            let relativePath = relative(
              dirname(oldSettings.libraryLocation),
              oldSettings.mediaSourcePath
            )
            relativePath = relativePath.replace(/\\/g, '/')
            settingsForCurrentLibrary.mediaSourcePath =
              relativePath === ''
                ? '.'
                : relativePath.startsWith('../')
                  ? relativePath
                  : './' + relativePath
            console.log(
              `[Main] Converted to relative path: ${settingsForCurrentLibrary.mediaSourcePath}`
            )
          }
        } else {
          // from relative to absolute
          if (oldSettings.libraryLocation) {
            // Use current libraryLocation for conversion
            settingsForCurrentLibrary.mediaSourcePath = resolvePath(
              dirname(oldSettings.libraryLocation),
              oldSettings.mediaSourcePath
            )
            console.log(
              `[Main] Converted to absolute path: ${settingsForCurrentLibrary.mediaSourcePath}`
            )
          }
        }
      }

      if (Object.keys(settingsForCurrentLibrary).length > 0) {
        await writeLibrarySettings(settingsForCurrentLibrary) // Writes to current library's settings file
      }

      // Check if virtual tags specifically changed and reapply
      const newSettingsAfterSave = await readSettings() // Re-read to get the merged result
      if (
        JSON.stringify(oldSettings.virtualTags) !== JSON.stringify(newSettingsAfterSave.virtualTags)
      ) {
        console.log('[Main] Virtual tags changed, reapplying.')
        await reapplyVirtualTagsAfterSettingsChange()
      }
      // After saving, we should also let the renderer know that settings might have updated,
      // so it can re-fetch or react if necessary (e.g., TMDB API key change).
      // A simple way is to send all new settings back, or a specific event.
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send('settings-possibly-updated', newSettingsAfterSave)
      })
    }
  })

  ipcMain.handle('select-library-directory', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Select Library Data Folder'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('select-media-source-directory', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Select Media Folder'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  // --- End Settings IPC Handlers ---

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
  // --- End Window Control IPC Handlers ---

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
