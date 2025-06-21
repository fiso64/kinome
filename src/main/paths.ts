import { app } from 'electron'
import path from 'path'

export const LIBRARY_DATA_DIR_NAME = 'library'

export function getLibraryDataPath(): string {
  return path.join(app.getPath('userData'), LIBRARY_DATA_DIR_NAME)
}