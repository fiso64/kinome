import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface MediaFile {
    id: string
    name: string
    path: string
    type: 'file'
    watched?: boolean
  }

  interface MediaFolder {
    id: string
    name: string
    path: string
    type: 'folder'
    children: LibraryItem[]
  }

  type LibraryItem = MediaFile | MediaFolder

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
