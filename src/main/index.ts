console.log(`[${new Date().toISOString()}] [Main] Main process entry point.`)

import { app, shell, BrowserWindow, ipcMain, protocol } from 'electron'
import { join, resolve as resolvePath } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { setupLibraryIpc, getLibraryDataPath } from './library'
import { readSettings, writeSettings } from './settings'

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
    // The URL from the renderer now includes a cache-busting query parameter
    // (e.g., "media-browser-asset://images/someid.jpg?v=12345").
    // We need to strip this query string to find the actual file on disk.

    // 1. Remove the protocol prefix.
    let pathString = request.url.substring('media-browser-asset://'.length)

    // 2. Find the '?' that indicates the start of the query string.
    const queryIndex = pathString.indexOf('?')
    if (queryIndex !== -1) {
      // 3. If a query string exists, slice the string to remove it.
      pathString = pathString.substring(0, queryIndex)
    }

    // 4. Decode the path and resolve it to an absolute file path.
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
    optimizer.watchWindowShortcuts(window)
  })

  setupLibraryIpc()

  // --- Settings IPC Handlers ---
  ipcMain.handle('get-settings', async () => {
    return await readSettings()
  })

  ipcMain.handle('save-settings', async (_, settings) => {
    await writeSettings(settings)
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
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
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
