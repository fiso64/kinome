import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import { exec } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import crypto from 'crypto'
import type { Database, MediaFolder, LibraryItem, MediaFile } from './types'
import { fetchAndApplyMetadata, fetchItemDetails, refetchPoster } from './retriever'
import { readSettings } from './settings'

const LIBRARY_DATA_DIR_NAME = 'library'
const DATABASE_FILE_NAME = 'database.json'
const DB_VERSION = 1

export function getLibraryDataPath(): string {
  return path.join(app.getPath('userData'), LIBRARY_DATA_DIR_NAME)
}

function getDbPath(): string {
  return path.join(getLibraryDataPath(), DATABASE_FILE_NAME)
}

async function readDb(): Promise<Database | null> {
  try {
    const dbPath = getDbPath()
    const data = await fs.readFile(dbPath, 'utf-8')
    const db = JSON.parse(data) as Database
    if (db.version !== DB_VERSION) {
      console.warn(
        `Database version mismatch. Expected ${DB_VERSION}, got ${db.version}. Ignoring old DB.`
      )
      return null
    }
    return db
  } catch {
    // File doesn't exist or is corrupt, which is fine on first run
    return null
  }
}

async function writeDb(db: Database): Promise<void> {
  const libraryPath = getLibraryDataPath()
  await fs.mkdir(libraryPath, { recursive: true })
  const dbPath = getDbPath()
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2))
}

function generateId(relativePath: string): string {
  return crypto.createHash('sha256').update(relativePath).digest('hex')
}

function findItemById(id: string, node: MediaFolder): LibraryItem | null {
  if (node.id === id) {
    return node
  }
  for (const child of node.children) {
    if (child.id === id) {
      return child
    }
    if (child.type === 'folder') {
      const found = findItemById(id, child)
      if (found) return found
    }
  }
  return null
}

function getAllItemsAsList(node: MediaFolder, list: LibraryItem[] = []): LibraryItem[] {
  list.push(node)
  for (const child of node.children) {
    if (child.type === 'folder') {
      getAllItemsAsList(child, list)
    } else {
      list.push(child)
    }
  }
  return list
}

function getAllItemsAsMap(
  node: MediaFolder,
  map: Map<string, LibraryItem> = new Map()
): Map<string, LibraryItem> {
  map.set(node.id, node)
  for (const child of node.children) {
    if (child.type === 'folder') {
      getAllItemsAsMap(child, map)
    }
    map.set(child.id, child)
  }
  return map
}

// Checks if image files exist on disk. If not, it nullifies the path in the item object.
async function verifyImagePaths(item: LibraryItem, imagesDir: string) {
  if (item.posterPath) {
    try {
      await fs.access(path.join(imagesDir, item.posterPath))
    } catch {
      console.log(`Poster for "${item.name}" not found. Marking for re-download.`)
      item.posterPath = undefined
    }
  }
  if (item.backdropPath) {
    try {
      await fs.access(path.join(imagesDir, item.backdropPath))
    } catch {
      console.log(`Backdrop for "${item.name}" not found. Marking for re-download.`)
      item.backdropPath = undefined
    }
  }
}

async function scanDirectory(dirPath: string, rootPath: string): Promise<MediaFolder> {
  const name = path.basename(dirPath)
  const relativePath = path.relative(rootPath, dirPath)
  const root: MediaFolder = {
    id: generateId(relativePath || '.'), // Use dot for root itself
    name: name || path.basename(rootPath), // Use root basename if name is empty
    path: dirPath,
    type: 'folder',
    children: []
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    const entryRelativePath = path.relative(rootPath, entryPath)
    if (entry.isDirectory()) {
      const subFolder = await scanDirectory(entryPath, rootPath)
      root.children.push(subFolder)
    } else if (entry.isFile()) {
      // Simple filter for common video files
      if (/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(entry.name)) {
        root.children.push({
          id: generateId(entryRelativePath),
          name: entry.name,
          path: entryPath,
          type: 'file'
        })
      }
    }
  }
  return root
}

// Helper to process tasks with a limit on concurrent executions.
async function processInChunks<T>(
  items: T[],
  concurrencyLimit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items]
  const active: Promise<void>[] = []

  while (queue.length > 0 || active.length > 0) {
    while (active.length < concurrencyLimit && queue.length > 0) {
      const item = queue.shift()!
      const promise = task(item).finally(() => {
        // Remove the promise from the active list once it's settled.
        const index = active.indexOf(promise)
        if (index !== -1) {
          active.splice(index, 1)
        }
      })
      active.push(promise)
    }
    // Wait for at least one of the active promises to complete.
    if (active.length > 0) {
      await Promise.race(active)
    }
  }
}

import {
  fetchAndApplyMetadata,
  fetchItemDetails,
  refetchPoster,
  cacheGenreLists
} from './retriever'

async function fetchMetadataForLibrary(db: Database, window: BrowserWindow, tmdbApiKey?: string) {
  const libraryDataPath = getLibraryDataPath()
  if (!tmdbApiKey || !db.root) {
    console.warn('Metadata fetch skipped: No API key or library root.')
    return
  }

  // Group 1: New items needing a full metadata search.
  const newItems = db.root.children.filter((item) => typeof item.tmdbId === 'undefined')
  // Group 2: Existing items that are just missing a poster.
  const itemsMissingPosters = db.root.children.filter(
    (item) => item.tmdbId && !item.posterPath
  )

  if (newItems.length === 0 && itemsMissingPosters.length === 0) {
    console.log('No new items or missing posters to fetch.')
    return
  }

  // Fetch and cache the genre lists before processing items.
  await cacheGenreLists(tmdbApiKey)

  // Process new items by searching for them on TMDB.
  if (newItems.length > 0) {
    console.log(`Starting metadata fetch for ${newItems.length} new top-level items...`)
    const task = async (item: LibraryItem): Promise<void> => {
      await fetchAndApplyMetadata(item, tmdbApiKey, libraryDataPath)
      if (item.posterPath || item.tmdbId === null) {
        window.webContents.send('library-item-updated', item)
      }
    }
    await processInChunks(newItems, 17, task)
  }

  // Re-fetch posters for existing items that are missing them.
  if (itemsMissingPosters.length > 0) {
    console.log(`Starting poster refetch for ${itemsMissingPosters.length} items...`)
    const task = async (item: LibraryItem): Promise<void> => {
      await refetchPoster(item, tmdbApiKey, libraryDataPath)
      if (item.posterPath) {
        window.webContents.send('library-item-updated', item)
      }
    }
    await processInChunks(itemsMissingPosters, 17, task)
  }

  await writeDb(db)
  console.log('Finished all metadata/poster fetching and saved final DB.')
}

export function setupLibraryIpc(): void {
  ipcMain.handle('get-library-root', async () => {
    const db = await readDb()
    return db?.root ?? null
  })

  ipcMain.handle('get-library-media-source-path', async () => {
    const db = await readDb()
    return db?.mediaSourcePath ?? null
  })

  ipcMain.handle('refresh-library', async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    if (!focusedWindow) return null

    const db = await readDb()
    if (!db || !db.mediaSourcePath) {
      console.log('Cannot refresh, no library configured.')
      return null
    }

    console.log(`Refreshing library from: ${db.mediaSourcePath}`)
    try {
      const imagesDir = path.join(getLibraryDataPath(), 'images')
      const newRoot = await scanDirectory(db.mediaSourcePath, db.mediaSourcePath)
      const oldItemsMap = db.root ? getAllItemsAsMap(db.root) : new Map()

      // This function merges old metadata and verifies image paths for all items.
      async function processItem(item: LibraryItem) {
        const oldItem = oldItemsMap.get(item.id)
        if (oldItem) {
          Object.assign(item, {
            title: oldItem.title,
            overview: oldItem.overview,
            posterPath: oldItem.posterPath,
            backdropPath: oldItem.backdropPath,
            tmdbId: oldItem.tmdbId,
            mediaType: oldItem.mediaType,
            year: oldItem.year,
            genres: oldItem.genres,
            watched: oldItem.type === 'file' && item.type === 'file' ? oldItem.watched : undefined
          })
        }

        // Verify image paths, nullifying them if files are missing.
        await verifyImagePaths(item, imagesDir)

        if (item.type === 'folder') {
          // Process children concurrently
          await Promise.all(item.children.map(processItem))
        }
      }

      await processItem(newRoot)

      db.root = newRoot
      await writeDb(db)
      console.log('Library refresh and image verification complete. Database updated.')

      const settings = await readSettings()
      fetchMetadataForLibrary(db, focusedWindow, settings.tmdbApiKey)

      return db.root
    } catch (error) {
      console.error('Failed to refresh library:', error)
      return db?.root ?? null // Return old root on failure
    }
  })

  ipcMain.handle('scan-library', async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    if (!focusedWindow) return null

    const result = await dialog.showOpenDialog(focusedWindow, {
      properties: ['openDirectory'],
      title: 'Select Media Folder'
    })

    if (result.canceled || result.filePaths.length === 0) {
      console.log('User canceled directory selection.')
      const db = await readDb()
      return db?.root ?? null
    }

    const mediaSourcePath = result.filePaths[0]
    console.log(`Starting scan of: ${mediaSourcePath}`)

    try {
      // 1. Scan directory structure first.
      const rootNode = await scanDirectory(mediaSourcePath, mediaSourcePath)

      const db: Database = {
        version: DB_VERSION,
        mediaSourcePath,
        root: rootNode
      }

      // 2. Write the initial DB with file structure.
      await writeDb(db)
      console.log('Initial scan complete. Database updated with file structure.')

      // 3. Start background metadata fetching without blocking.
      const settings = await readSettings()
      fetchMetadataForLibrary(db, focusedWindow, settings.tmdbApiKey)

      // 4. Return the initial structure immediately to the UI.
      return db.root
    } catch (error) {
      console.error('Failed to scan directory:', error)
      return null
    }
  })

  ipcMain.handle('get-item-details', async (_, itemId: string): Promise<LibraryItem | null> => {
    const db = await readDb()
    const settings = await readSettings()
    const libraryDataPath = getLibraryDataPath()

    if (!db || !db.root) {
      console.error('Cannot get item details: database not found.')
      return null
    }

    const item = findItemById(itemId, db.root)
    if (!item) {
      console.error(`Cannot get item details: item with id ${itemId} not found.`)
      return null
    }

    // Verify that the backdrop image file actually exists on disk.
    await verifyImagePaths(item, path.join(libraryDataPath, 'images'))

    // If we still have the backdrop after verification, return immediately.
    if (item.backdropPath) {
      return item
    }

    // Otherwise, fetch them, update DB, and return updated item.
    if (settings.tmdbApiKey && item.tmdbId) {
      await fetchItemDetails(item, settings.tmdbApiKey, libraryDataPath)
      await writeDb(db) // Save changes
    } else {
      if (!item.tmdbId) {
        console.warn(`Cannot fetch item details for "${item.name}": item has no TMDB ID.`)
      } else {
        console.warn('Cannot fetch item details: TMDB API key not configured.')
      }
    }
    return item // Return the (possibly updated) item
  })

  ipcMain.handle('play-file', async (_, file: MediaFile): Promise<boolean> => {
    const db = await readDb()
    const { playerCommand } = await readSettings()

    if (!db || !db.root || !playerCommand) {
      console.error('Cannot play file: database or player command not configured.')
      dialog.showErrorBox(
        'Configuration Error',
        'Player command is not configured. Please set it in Settings.'
      )
      return false
    }

    // Mark as watched in the database
    const itemInDb = findItemById(file.id, db.root)
    if (itemInDb && itemInDb.type === 'file') {
      itemInDb.watched = true
      await writeDb(db)
      console.log('Database updated with watched state for item:', file.id)
    } else {
      console.warn(`Could not find item with id ${file.id} in DB to mark as watched.`)
      // We can still try to play it, so we don't return false here.
    }

    // Launch the external player
    // The path is always quoted to handle spaces correctly.
    const command = playerCommand.replace('{PATH}', `"${file.path}"`)

    console.log(`Executing: ${command}`)
    exec(command, (error) => {
      if (error) {
        console.error(`Failed to execute player command: ${error.message}`)
        dialog.showErrorBox(
          'Player Error',
          `Failed to launch player. Please check your command in Settings.\n\nCommand: ${command}\n\nError: ${error.message}`
        )
      }
    })

    return true // Indicate that the attempt to play was processed.
  })
}