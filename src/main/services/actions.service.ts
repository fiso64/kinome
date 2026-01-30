import { exec } from 'child_process'
import path from 'path'
import { URL } from 'url'
import fs, { readdir, stat } from 'fs/promises'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import * as repositoryService from './repository.service'
import type { MediaFile } from '../../shared/types'

type ErrorCallback = (options: { title: string; message: string; detail?: string }) => void

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Actions Service] ${message}`)
}

export async function getAbsolutePath(relativePath: string): Promise<string | null> {
  const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
  if (!mediaSourcePath) return null
  if (pathsService.isRemotePath(mediaSourcePath)) {
    return new URL(
      relativePath,
      mediaSourcePath + (mediaSourcePath.endsWith('/') ? '' : '/')
    ).toString()
  }
  return path.join(mediaSourcePath, relativePath)
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
  const absolutePath = pathsService.isRemotePath(mediaSourcePath)
    ? new URL(file.path, mediaSourcePath + (mediaSourcePath.endsWith('/') ? '' : '/')).toString()
    : path.join(mediaSourcePath, file.path)
  const commandToExecute = command.replace('{PATH}', `${absolutePath}`)
  log(`Executing: ${commandToExecute}`)
  exec(commandToExecute, (error) => {
    if (error) {
      onError({
        title: 'Player Error',
        message: 'Failed to launch the external player.',
        detail: `Command: ${commandToExecute}\nError: ${error.message}`
      })
    }
  })

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
  const absolutePath = path.join(mediaSourcePath, item.path)
  const title = item.title ?? item.name.replace(/\.[^/.]+$/, '')
  const commandToExecute = action.command
    .replace(/{path}/g, absolutePath)
    .replace(/{title}/g, title)
    .replace(/{type}/g, item.mediaType ?? '')
    .replace(/{year}/g, item.year?.toString() ?? '')
  log(`Executing custom action: ${commandToExecute}`)
  exec(commandToExecute, (error) => {
    if (error) {
      onError({
        title: 'Custom Action Error',
        message: 'Failed to execute the custom command.',
        detail: `Command: ${commandToExecute}\nError: ${error.message}`
      })
    }
  })
}

export async function revealInExplorer(relativePath: string): Promise<void> {
  const absolutePath = await getAbsolutePath(relativePath)
  if (!absolutePath) return

  if (pathsService.isRemotePath(absolutePath)) {
    log(`Open URL requested (No-op on server): ${absolutePath}`)
    return
  }

  log(`Revealing in explorer: ${absolutePath}`)
  const command =
    process.platform === 'win32'
      ? `explorer /select,"${absolutePath}"`
      : process.platform === 'darwin'
        ? `open -R "${absolutePath}"`
        : `xdg-open "${path.dirname(absolutePath)}"`

  exec(command)
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
  const oldAbsolutePath = path.resolve(mediaSourcePath, relativeOldPath)
  const newAbsolutePath = path.resolve(path.dirname(oldAbsolutePath), newName)
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
  const absolutePath = path.join(mediaSourcePath, relativePath)
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
