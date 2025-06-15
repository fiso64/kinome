import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { MediaFile, MediaFolder } from '../main/types'

// Custom APIs for renderer
const api = {
  getLibraryRoot: (): Promise<MediaFolder | null> => ipcRenderer.invoke('get-library-root'),
  scanLibrary: (): Promise<MediaFolder | null> => ipcRenderer.invoke('scan-library'),
  getPlayerCommand: (): Promise<string | null> => ipcRenderer.invoke('get-player-command'),
  setPlayerCommand: (command: string): Promise<void> =>
    ipcRenderer.invoke('set-player-command', command),
  playFile: (file: MediaFile): Promise<boolean> => ipcRenderer.invoke('play-file', file),

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
