import { app } from 'electron'
import path from 'path'

export const LIBRARY_DATA_DIR_NAME = 'library'

// This will be set at startup from global settings.
// The default value is used before settings are read, or if libraryLocation is not set.
let libraryDataPath: string = path.join(app.getPath('userData'), LIBRARY_DATA_DIR_NAME)

export function getLibraryDataPath(): string {
  return libraryDataPath
}

export function setLibraryDataPath(newPath: string): void {
  console.log(`[Paths] Library data path set to: ${newPath}`)
  libraryDataPath = newPath
}
