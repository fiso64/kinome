import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import { exec } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import crypto from 'crypto'
import type { Database, MediaFolder, LibraryItem, MediaFile } from './types'

const LIBRARY_DATA_DIR_NAME = 'library'
const DATABASE_FILE_NAME = 'database.json'
const DB_VERSION = 1

function getLibraryDataPath(): string {
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
      console.warn(`Database version mismatch. Expected ${DB_VERSION}, got ${db.version}. Ignoring old DB.`)
      return null
    }
    return db
  } catch (error) {
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
      // For now, let's just add any file. We can filter by extension later.
      root.children.push({
        id: generateId(entryRelativePath),
        name: entry.name,
        path: entryPath,
        type: 'file'
      })
    }
  }
  return root
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
      const rootNode = await scanDirectory(mediaSourcePath, mediaSourcePath)
      const oldDb = await readDb()
      const db: Database = {
        version: DB_VERSION,
        mediaSourcePath,
        // Preserve player command if it exists, otherwise set a default
        playerCommand: oldDb?.playerCommand ?? 'mpv "{PATH}"',
        root: rootNode
      }
      await writeDb(db)
      console.log('Scan complete. Database updated.')
      return db.root
    } catch (error) {
      console.error('Failed to scan directory:', error)
      return null
    }
  })

  ipcMain.handle('get-player-command', async () => {
    const db = await readDb()
    return db?.playerCommand ?? null
  })

  ipcMain.handle('set-player-command', async (_, command: string) => {
    const db = await readDb()
    if (db) {
      db.playerCommand = command
      await writeDb(db)
    }
  })

  ipcMain.handle('play-file', async (_, file: MediaFile): Promise<boolean> => {
    const db = await readDb()
    if (!db || !db.root || !db.playerCommand) {
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
    const command = db.playerCommand.replace('{PATH}', `"${file.path}"`)
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
