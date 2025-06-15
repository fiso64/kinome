import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import { exec } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import crypto from 'crypto'
import type { Database, MediaFolder, LibraryItem, MediaFile } from './types'
import { fetchAndApplyMetadata, fetchItemDetails } from './retriever'
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

async function fetchMetadataForLibrary(db: Database, window: BrowserWindow, tmdbApiKey?: string) {
  const libraryDataPath = getLibraryDataPath()

  if (!tmdbApiKey || !db.root) {
    console.warn('Metadata fetch skipped: No API key or library root.')
    return
  }

  const itemsToProcess = [...db.root.children]
  console.log(`Starting metadata fetch for ${itemsToProcess.length} top-level items...`)

  const task = async (item: LibraryItem) => {
    // Check if item already has a poster to avoid re-fetching
    if (item.posterPath) return

    await fetchAndApplyMetadata(item, tmdbApiKey, libraryDataPath)

    // If metadata was successfully added, notify the renderer.
    if (item.posterPath) {
      window.webContents.send('library-item-updated', item)
    }
  }

  await processInChunks(itemsToProcess, 17, task)

  // Save the fully updated DB at the very end.
  await writeDb(db)
  console.log('Finished all metadata fetching and saved final DB.')
}

export function setupLibraryIpc(): void {
  ipcMain.handle('get-library-root', async () => {
    const db = await readDb()
    return db?.root ?? null
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

    if (!db || !db.root) {
      console.error('Cannot get item details: database not found.')
      return null
    }

    const item = findItemById(itemId, db.root)
    if (!item) {
      console.error(`Cannot get item details: item with id ${itemId} not found.`)
      return null
    }

    // If we have the details we need (backdrop), return immediately.
    if (item.backdropPath) {
      return item
    }

    // Otherwise, fetch them, update DB, and return updated item.
    if (settings.tmdbApiKey) {
      await fetchItemDetails(item, settings.tmdbApiKey, getLibraryDataPath())
      await writeDb(db) // Save changes
    } else {
      console.warn('Cannot fetch item details: TMDB API key not configured.')
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