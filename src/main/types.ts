export interface MediaFile {
  id: string // Stable ID (e.g., hash of relative path)
  name: string
  path: string // Full path to the file
  type: 'file'
  watched?: boolean
}

export interface MediaFolder {
  id: string // Stable ID (e.g., hash of relative path)
  name: string
  path: string // Full path to the folder
  type: 'folder'
  children: LibraryItem[]
}

export type LibraryItem = MediaFile | MediaFolder

export interface Database {
  version: number
  mediaSourcePath: string | null
  playerCommand: string | null
  root: MediaFolder | null
}
