// Bun native child process handling via Bun.spawn
import path from 'path'
import { URL } from 'url'
import fs, { readdir, stat } from 'fs/promises'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import * as itemsRepo from '../database/repositories/filesystem.repo'
import * as repositoryService from './repository.service'
import type { MediaFile } from '@shared/types'

type ErrorCallback = (options: { title: string; message: string; detail?: string }) => void

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Actions Service] ${message}`)
}

/**
 * Resolves the absolute path for an item given its source UUID and relative path.
 */
export async function getAbsolutePath(sourceId: string, relativePath: string): Promise<string | null> {
  const absSourcePath = await settingsService.getAbsoluteSourcePath(sourceId)
  if (!absSourcePath) return null
  return pathsService.securePathJoin(absSourcePath, relativePath)
}

/**
 * Resolves the absolute path for an item by looking up its source_id from the database.
 */
export async function getAbsolutePathForItem(itemId: string, userId?: string | null): Promise<string | null> {
  const location = itemsRepo.getPresentItemLocation(itemId, undefined, userId)
  if (!location) return null
  return getAbsolutePath(location.sourceId, location.relativePath)
}

export async function playFileWith(
  file: MediaFile,
  command: string,
  onError: ErrorCallback
): Promise<boolean> {
  if (!command) return false
  if (!file.path) {
    onError({
      title: 'Path Error',
      message: 'File path is missing from the item.'
    })
    return false
  }
  const absolutePath = await getAbsolutePathForItem(file.id)
  if (!absolutePath) {
    onError({
      title: 'Security Error',
      message: 'Access denied: The requested path is outside the media library.'
    })
    return false
  }
  const commandToExecute = command.replace('{PATH}', `${absolutePath}`)
  log(`Executing (NOT IMPLEMENTED): ${commandToExecute}`)

  // This used to be an electron app, where the client and server ran on the same machine. It does not make any sense to launch a video player on the server. We do nothing for now.

  // The responsibility of updating the watched state is moved to the orchestrator (library.service).
  return true
}

export async function playFile(file: MediaFile, onError: ErrorCallback): Promise<boolean> {
  const { playerCommands } = await settingsService.readSettings()
  if (!playerCommands || playerCommands.length === 0 || !playerCommands[0].command) {
    onError({
      title: 'Configuration Error',
      message: 'Player command is not configured. Please set it in Settings.'
    })
    return false
  }
  return playFileWith(file, playerCommands[0].command, onError)
}

export async function executeCustomAction(
  itemId: string,
  commandId: string,
  onError: ErrorCallback,
  userId?: string | null
): Promise<void> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return
  const settings = await settingsService.readSettings()
  const action = settings.customActions.find((a) => a.id === commandId)
  if (!action) return
  const absolutePath = await getAbsolutePathForItem(itemId, userId)
  if (!absolutePath) return
  const title = item.title ?? item.name.replace(/\.[^/.]+$/, '')
  const commandToExecute = action.command
    .replace(/{path}/g, absolutePath)
    .replace(/{title}/g, title)
    .replace(/{type}/g, item.mediaType ?? '')
    .replace(/{year}/g, item.year?.toString() ?? '')
  log(`[SERVER-ONLY ACTION] Executing custom action: ${commandToExecute}`)
  log(`Custom actions are currently disabled for remote clients and logged as NO-OP.`)
  /*
  Bun.spawn(commandToExecute.split(' '), {
    onExit(_proc: any, exitCode: any, _signalCode: any, error: any) {
      if (error || exitCode !== 0) {
        onError({
          title: 'Custom Action Error',
          message: 'Failed to execute the custom command.',
          detail: `Command: ${commandToExecute}\nError: ${error?.message || 'Exit code ' + exitCode}`
        })
      }
    }
  })
  */
}

export async function revealInExplorer(itemId: string): Promise<void> {
  const absolutePath = await getAbsolutePathForItem(itemId)
  if (!absolutePath) return

  if (pathsService.isRemotePath(absolutePath)) {
    log(`Open URL requested (No-op on server): ${absolutePath}`)
    return
  }
  // TODO: Again, this does not make any sense on the server.
  log(`Revealing in explorer: ${absolutePath}`)
  const commandArray =
    process.platform === 'win32'
      ? ['explorer', '/select,' + absolutePath]
      : process.platform === 'darwin'
        ? ['open', '-R', absolutePath]
        : ['xdg-open', path.dirname(absolutePath)]

  Bun.spawn(commandArray)
}

export async function trashItem(itemId: string): Promise<boolean> {
  if (pathsService.isRemoteLibrary()) {
    throw new Error('Deleting files is not available for remote libraries.')
  }
  try {
    const absolutePath = await getAbsolutePathForItem(itemId)
    if (!absolutePath) {
      throw new Error(`Access denied: item "${itemId}" path could not be resolved.`)
    }

    log(`Deleting item (Direct delete on server): ${absolutePath}`)
    await fs.rm(absolutePath, { recursive: true, force: true })
    return true
  } catch (error) {
    console.error(`Failed to delete item: ${itemId}`, error)
    throw error
  }
}

export async function renameItem(itemId: string, newName: string, userId?: string | null): Promise<string> {
  if (pathsService.isRemoteLibrary()) {
    throw new Error('Renaming items is not available for remote libraries.')
  }
  if (!newName) {
    throw new Error('New name is required for renaming.')
  }

  const location = itemsRepo.getPresentItemLocation(itemId, undefined, userId)
  if (!location) throw new Error(`Item ${itemId} not found or has no present location.`)

  const absSourcePath = await settingsService.getAbsoluteSourcePath(location.sourceId)
  if (!absSourcePath) throw new Error('Media source path not configured.')

  const oldAbsolutePath = pathsService.securePathJoin(absSourcePath, location.relativePath)
  if (!oldAbsolutePath) {
    throw new Error('Access denied: Old path is outside the media library.')
  }

  const dirPath = path.dirname(oldAbsolutePath)
  const newAbsolutePath = path.join(dirPath, newName)

  if (!pathsService.isPathInside(absSourcePath, newAbsolutePath)) {
    throw new Error('Access denied: New path is outside the media library.')
  }

  try {
    await fs.rename(oldAbsolutePath, newAbsolutePath)
    return itemsRepo.relativePathFromAbsolute(absSourcePath, newAbsolutePath)
  } catch (error) {
    console.error(`Failed to rename item ${itemId} to ${newName}`, error)
    throw error
  }
}

async function getDirectoryContentStats(
  dirPath: string
): Promise<{ totalSize: number; fileCount: number; folderCount: number }> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  let totalSize = 0,
    fileCount = 0,
    folderCount = 0
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        folderCount++
        const subDirStats = await getDirectoryContentStats(fullPath)
        totalSize += subDirStats.totalSize
        fileCount += subDirStats.fileCount
        folderCount += subDirStats.folderCount
      } else if (entry.isFile()) {
        try {
          const stats = await stat(fullPath)
          totalSize += stats.size
          fileCount++
        } catch (e) {
          console.error(`Could not stat file ${fullPath}:`, e)
        }
      }
    })
  )
  return { totalSize, fileCount, folderCount }
}

export async function getItemProperties(itemId: string): Promise<any | null> {
  const absolutePath = await getAbsolutePathForItem(itemId)
  if (!absolutePath || pathsService.isRemotePath(absolutePath)) return null
  try {
    const stats = await fs.stat(absolutePath)
    const baseProperties = {
      name: path.basename(absolutePath),
      path: absolutePath,
      type: stats.isDirectory() ? ('Folder' as const) : ('File' as const),
      created: stats.birthtime.toISOString(),
      modified: stats.mtime.toISOString()
    }
    if (stats.isDirectory()) {
      const contentStats = await getDirectoryContentStats(absolutePath)
      return {
        ...baseProperties,
        size: contentStats.totalSize,
        contains: { files: contentStats.fileCount, folders: contentStats.folderCount }
      }
    } else {
      return { ...baseProperties, size: stats.size }
    }
  } catch (error) {
    console.error(`Failed to get properties for ${absolutePath}:`, error)
    return null
  }
}
