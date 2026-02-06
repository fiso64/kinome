// Bun native child process handling via Bun.spawn
import path from 'path'
import { URL } from 'url'
import fs, { readdir, stat } from 'fs/promises'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import * as repositoryService from './repository.service'
import type { MediaFile } from '@shared/types'

type ErrorCallback = (options: { title: string; message: string; detail?: string }) => void

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Actions Service] ${message}`)
}

export async function getAbsolutePath(relativePath: string): Promise<string | null> {
  const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
  if (!mediaSourcePath) return null
  return pathsService.securePathJoin(mediaSourcePath, relativePath)
}

export async function playFileWith(
  file: MediaFile,
  command: string,
  onError: ErrorCallback
): Promise<boolean> {
  if (!command) return false
  const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
  if (!mediaSourcePath) {
    onError({
      title: 'Configuration Error',
      message: 'Media source path is not configured. Please check your library settings.'
    })
    return false
  }
  if (!file.path) {
    onError({
      title: 'Path Error',
      message: 'File path is missing from the item.'
    })
    return false
  }
  const absolutePath = pathsService.securePathJoin(mediaSourcePath, file.path)
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
  onError: ErrorCallback
): Promise<void> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return
  const settings = await settingsService.readSettings()
  const action = settings.customActions.find((a) => a.id === commandId)
  if (!action || !item.path) return
  const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
  if (!mediaSourcePath) return
  const absolutePath = pathsService.securePathJoin(mediaSourcePath, item.path)
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

export async function revealInExplorer(relativePath: string): Promise<void> {
  const absolutePath = await getAbsolutePath(relativePath)
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

export async function trashItem(relativePath: string): Promise<boolean> {
  if (pathsService.isRemoteLibrary()) {
    throw new Error('Deleting files is not available for remote libraries.')
  }
  try {
    const absolutePath = await getAbsolutePath(relativePath)
    if (!absolutePath) return false

    log(`Deleteting item (Direct delete on server): ${absolutePath}`)
    await fs.rm(absolutePath, { recursive: true, force: true })
    return true
  } catch (error) {
    console.error(`Failed to delete item: ${relativePath}`, error)
    // Re-throw to be caught by the transport layer and shown to the user.
    throw error
  }
}

export async function renameItem(relativeOldPath: string, newName: string): Promise<void> {
  if (pathsService.isRemoteLibrary()) {
    throw new Error('Renaming items is not available for remote libraries.')
  }
  const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
  if (!mediaSourcePath) {
    throw new Error('Media source path not configured.')
  }
  const oldAbsolutePath = pathsService.securePathJoin(mediaSourcePath, relativeOldPath)
  if (!oldAbsolutePath) {
    throw new Error('Access denied: Old path is outside the media library.')
  }
  const dirPath = path.dirname(oldAbsolutePath)
  const newAbsolutePath = pathsService.securePathJoin(dirPath, newName)
  if (!newAbsolutePath || !newAbsolutePath.startsWith(dirPath)) {
    throw new Error('Access denied: New path is outside the directory.')
  }
  try {
    await fs.rename(oldAbsolutePath, newAbsolutePath)
  } catch (error) {
    console.error(`Failed to rename item from ${relativeOldPath} to ${newName}`, error)
    throw error // Re-throw to be caught by the transport layer.
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

export async function getItemProperties(relativePath: string): Promise<any | null> {
  const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
  if (!mediaSourcePath || pathsService.isRemotePath(mediaSourcePath)) return null
  const absolutePath = pathsService.securePathJoin(mediaSourcePath, relativePath)
  if (!absolutePath) return null
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
