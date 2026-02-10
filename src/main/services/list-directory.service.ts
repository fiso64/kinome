import fs from 'fs/promises'
import path from 'path'

export interface DirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
}

/**
 * Lists directories (not files) in a given path.
 * Used during setup to browse the filesystem before the database exists.
 *
 * Security: Only call this after validating the path is within allowed boundaries
 * using pathsService.isPathInside().
 */
export async function listDirectory(absolutePath: string): Promise<DirectoryEntry[]> {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error(`Path must be absolute: ${absolutePath}`)
  }
  try {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true })

    // Filter to only directories
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(absolutePath, entry.name),
        isDirectory: true
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    return directories
  } catch (error: any) {
    // Handle permission errors, missing directories, etc.
    if (error.code === 'EACCES') {
      throw new Error(`Permission denied: ${absolutePath}`)
    }
    if (error.code === 'ENOENT') {
      throw new Error(`Directory not found: ${absolutePath}`)
    }
    throw new Error(`Failed to list directory: ${error.message}`)
  }
}
