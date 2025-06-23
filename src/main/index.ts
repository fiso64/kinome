// This MUST be the first import to ensure the library path is set before
// any other module that depends on it is loaded.
import './startup'

import { app, shell, BrowserWindow, ipcMain, protocol, dialog } from 'electron'
import { join, resolve as resolvePath, relative, dirname } from 'path'
import { electronApp, is } from '@electron-toolkit/utils'
import { setupLibraryIpc, reapplyVirtualTagsAfterSettingsChange } from './library'
import { getLibraryDataPath, setLibraryDataPath } from './paths'
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

  protocol.registerFileProtocol('media-browser-asset', (request, callback) => {
    let pathString = request.url.substring('media-browser-asset://'.length)
    const queryIndex = pathString.indexOf('?')
    if (queryIndex !== -1) {
      pathString = pathString.substring(0, queryIndex)
    }
    const relativePath = decodeURIComponent(pathString)
    const absolutePath = resolvePath(getLibraryDataPath(), relativePath)
    callback({ path: absolutePath })
  })

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    if (is.dev) {
      window.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12') {
          if (window.webContents.isDevToolsOpened()) {
            window.webContents.closeDevTools()
          } else {
            window.webContents.openDevTools({ mode: 'right' })
          }
          event.preventDefault()
        }
        if (input.control && input.key.toLowerCase() === 'r') {
          window.webContents.reload()
          event.preventDefault()
        }
      })
    }
  })

  setupLibraryIpc()

  // --- Settings IPC Handlers ---
  ipcMain.handle('get-settings', async () => {
    return await readSettings()
  })

  ipcMain.handle('save-settings', async (_, settingsToSave: Partial<Settings>) => {
    const oldSettings = await readSettings()
    const { libraryLocation, ...otherSettings } = settingsToSave

    // Handle media path relativity conversion
    const newRelativity = otherSettings.mediaSourcePathIsRelative
    const oldRelativity = oldSettings.mediaSourcePathIsRelative

    if (
      newRelativity !== undefined &&
      newRelativity !== oldRelativity &&
      oldSettings.mediaSourcePath
    ) {
      if (newRelativity === true) {
        // from absolute to relative
        const libPath = libraryLocation ?? oldSettings.libraryLocation
        if (libPath) {
          let relativePath = relative(dirname(libPath), oldSettings.mediaSourcePath)
          relativePath = relativePath.replace(/\\/g, '/')

          if (relativePath === '') {
            otherSettings.mediaSourcePath = '.'
          } else if (relativePath.startsWith('../')) {
            otherSettings.mediaSourcePath = relativePath
          } else {
            otherSettings.mediaSourcePath = './' + relativePath
          }
        }
      } else {
        // from relative to absolute
        const libPath = oldSettings.libraryLocation
        if (libPath) {
          otherSettings.mediaSourcePath = resolvePath(
            dirname(libPath),
            oldSettings.mediaSourcePath
          )
        }
      }
    }

    if (libraryLocation !== undefined && libraryLocation !== oldSettings.libraryLocation) {
      await writeGlobalSettings({ libraryLocation })
      setLibraryDataPath(libraryLocation)
    }

    if (Object.keys(otherSettings).length > 0) {
      await writeLibrarySettings(otherSettings)
    }

    const newSettings = await readSettings()

    if (JSON.stringify(oldSettings.virtualTags) !== JSON.stringify(newSettings.virtualTags)) {
      await reapplyVirtualTagsAfterSettingsChange()
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
