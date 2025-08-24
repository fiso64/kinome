import { app } from 'electron'
import path from 'path'
import { URL } from 'url'

export const LIBRARY_DATA_DIR_NAME = 'library'

// This will be set at startup from global settings.
// The default value is used before settings are read, or if libraryLocation is not set.
let libraryDataPath: string = path.join(app.getPath('userData'), LIBRARY_DATA_DIR_NAME)

/**
 * Checks if a given path is a remote HTTP/HTTPS URL.
 */
export function isRemotePath(p: string): boolean {
  return p.startsWith('http://') || p.startsWith('https://')
}

/**
 * Checks if the currently configured library is remote.
 */
export function isRemoteLibrary(): boolean {
  return isRemotePath(libraryDataPath)
}

/**
 * Resolves a relative path against the library data path.
 * Handles both local file paths and remote URLs correctly.
 * @param relativePath The path relative to the library root (e.g., 'database.json').
 * @returns An absolute file system path or a full remote URL.
 */
export function resolveLibraryPath(relativePath: string): string {
  if (isRemoteLibrary()) {
    return new URL(relativePath, libraryDataPath).toString()
  }
  return path.join(libraryDataPath, relativePath)
}

export function getLibraryDataPath(): string {
  return libraryDataPath
}

export function setLibraryDataPath(newPath: string): void {
  let finalPath = newPath
  // Normalize remote URLs to always have a trailing slash for correct relative path resolution.
  if (isRemotePath(finalPath) && !finalPath.endsWith('/')) {
    finalPath = finalPath + '/'
  }
  console.log(`[Paths] Library data path set to: ${finalPath}`)
  libraryDataPath = finalPath
}
