import { URL } from 'url'
import path from 'path'

export const LIBRARY_DATA_DIR_NAME = 'library'

// This will be set at startup. It needs a default for the initial synchronous read in startup.service.
let userDataPath: string = '.'
export function setUserDataPath(path: string): void {
  userDataPath = path
}
export function getUserDataPath(): string {
  return userDataPath
}

// This will be set at startup from global settings.
// The default value is used before settings are read, or if libraryLocation is not set.
let libraryDataPath: string = path.join(userDataPath, LIBRARY_DATA_DIR_NAME)

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
 * Securely joins a base path and a relative path, ensuring the result is within the base.
 * Prevents path traversal attacks (e.g., using ../../ to access sensitive files).
 */
export function securePathJoin(base: string, relativePath: string): string | null {
  if (isRemotePath(base)) {
    const baseUrl = base.endsWith('/') ? base : base + '/'
    try {
      const url = new URL(relativePath, baseUrl).toString()
      if (!url.startsWith(baseUrl)) return null
      return url
    } catch {
      return null
    }
  }

  const absoluteBase = path.resolve(base)
  const absoluteResult = path.resolve(path.join(absoluteBase, relativePath))

  if (!absoluteResult.startsWith(absoluteBase)) {
    return null
  }

  return absoluteResult
}

/**
 * Resolves a relative path against the library data path.
 * Handles both local file paths and remote URLs correctly.
 * @param relativePath The path relative to the library root (e.g., 'library.db').
 * @returns An absolute file system path or a full remote URL, or null if escape detected.
 */
export function resolveLibraryPath(relativePath: string): string | null {
  return securePathJoin(libraryDataPath, relativePath)
}

/**
 * Resolves an asset path (e.g. posters, backdrops) against the library's images directory.
 */
export function resolveAssetPath(relativePath: string): string | null {
  const imagesBase = isRemoteLibrary()
    ? (libraryDataPath.endsWith('/') ? libraryDataPath : libraryDataPath + '/') + 'images/'
    : path.join(libraryDataPath, 'images')

  return securePathJoin(imagesBase, relativePath)
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

// Re-initialize the default library data path once the real user data path is known.
export function reinitializeDefaultLibraryPath(): void {
  libraryDataPath = path.join(userDataPath, LIBRARY_DATA_DIR_NAME)
}
