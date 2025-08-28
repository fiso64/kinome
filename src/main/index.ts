// This MUST be the first import to ensure the library path is set before
// any other module that depends on it is loaded.
import './services/startup.service'

import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, is } from '@electron-toolkit/utils'
import { loadDbIntoMemory } from './services/library.service'
import { isRemoteLibrary, resolveLibraryPath } from './services/paths.service'
import { IpcTransport } from './transport/ipc.transport'
import { setTransport } from './transport.registry'

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
app.whenReady().then(async () => {
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
  app.on('browser-window-created', (_, window) => {
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
  })

  // Initialize services and transport layers
  const ipcTransport = new IpcTransport()
  setTransport(ipcTransport)

  await loadDbIntoMemory()
  ipcTransport.initialize()

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})