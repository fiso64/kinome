import { ElectronAPI } from '@electron-toolkit/preload'

export interface MediaFile {
  id: string
  name: string
  path: string
  type: 'file'
  watched?: boolean
}

export interface MediaFolder {
  id: string
  name: string
  path: string
  type: 'folder'
  children: LibraryItem[]
}

export type LibraryItem = MediaFile | MediaFolder

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getLibraryRoot: () => Promise<MediaFolder | null>
      scanLibrary: () => Promise<MediaFolder | null>
      getPlayerCommand: () => Promise<string | null>
      setPlayerCommand: (command: string) => Promise<void>
      playFile: (file: MediaFile) => Promise<boolean>
    }
  }
}
