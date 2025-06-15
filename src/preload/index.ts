import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { MediaFile, MediaFolder } from '../main/types'

// Custom APIs for renderer
const api = {
  getLibraryRoot: (): Promise<MediaFolder | null> => ipcRenderer.invoke('get-library-root'),
  scanLibrary: (): Promise<MediaFolder | null> => ipcRenderer.invoke('scan-library'),
  refreshLibrary: (): Promise<MediaFolder | null> => ipcRenderer.invoke('refresh-library'),
  playFile: (file: MediaFile): Promise<boolean> => ipcRenderer.invoke('play-file', file),
  getItemDetails: (itemId: string): Promise<LibraryItem | null> =>
    ipcRenderer.invoke('get-item-details', itemId),

  // Settings
  getSettings: (): Promise<{ playerCommand: string; tmdbApiKey: string }> =>
    ipcRenderer.invoke('get-settings'),
  getLibraryMediaSourcePath: (): Promise<string | null> =>
    ipcRenderer.invoke('get-library-media-source-path'),
  saveSettings: (settings: { playerCommand: string; tmdbApiKey: string }): Promise<void> =>
    ipcRenderer.invoke('save-settings', settings),

  // Window Controls
  minimizeWindow: (): void => ipcRenderer.send('window-minimize'),
  toggleMaximizeWindow: (): void => ipcRenderer.send('window-toggle-maximize'),
  closeWindow: (): void => ipcRenderer.send('window-close'),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke('is-window-maximized'),
  onWindowMaximizedStatus: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, isMaximized: boolean): void => callback(isMaximized)
    ipcRenderer.on('window-is-maximized', listener)
    return () => {
      ipcRenderer.removeListener('window-is-maximized', listener)
    }
  },
  onLibraryItemUpdated: (callback: (item: LibraryItem) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, item: LibraryItem): void => callback(item)
    ipcRenderer.on('library-item-updated', listener)
    return () => {
      ipcRenderer.removeListener('library-item-updated', listener)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}