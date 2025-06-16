import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import { exec } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import crypto from 'crypto'
import type { Database, MediaFolder, LibraryItem, MediaFile } from './types'
import {
  cacheGenreLists,
  fetchAndApplyMetadata,
  fetchItemDetails,
  refetchPoster,
  manualSearch,
  getTmdbImages,
  downloadImage
} from './retriever'
import { readSettings } from './settings'

const LIBRARY_DATA_DIR_NAME = 'library'
const DATABASE_FILE_NAME = 'database.json'
const DB_VERSION = 1

// --- In-Memory Database Cache ---
let db: Database | null = null

async function loadDbIntoMemory(): Promise<void> {
  console.log('[Database] Loading database into memory...')
  db = await readDb()
}
// --- End In-Memory Database Cache ---

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
    const parsedDb = JSON.parse(data) as Database
    if (parsedDb.version !== DB_VERSION) {
      console.warn(
        `Database version mismatch. Expected ${DB_VERSION}, got ${db.version}. Ignoring old DB.`
      )
      return null
    }
    return parsedDb
  } catch {
    // File doesn't exist or is corrupt, which is fine on first run
    return null
  }
}

async function writeDb(updatedDb: Database): Promise<void> {
  // Update the in-memory copy first
  db = updatedDb

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

// Recursively collects all items that need metadata or posters, based on folder flags.
function collectItemsToProcess(
  folder: MediaFolder,
  newItems: { item: LibraryItem; hint?: 'movie' | 'tv' }[],
  itemsMissingPosters: LibraryItem[]
) {
  // Process children of the current folder if the flag is set.
  if (folder.retrieve_children_metadata) {
    for (const child of folder.children) {
      if (typeof child.tmdbId === 'undefined') {
        newItems.push({ item: child, hint: folder.children_type_hint })
      } else if (child.tmdbId && !child.posterPath) {
        itemsMissingPosters.push(child)
      }
    }
  }

  // Always recurse into subfolders to check their flags.
  for (const child of folder.children) {
    if (child.type === 'folder') {
      collectItemsToProcess(child, newItems, itemsMissingPosters)
    }
  }
}

async function getAutocompleteSuggestions() {
  if (!db || !db.root) {
    return { genres: [], tagKeys: [], tagValues: {} }
  }

  const allItems = getAllItemsAsList(db.root)
  const genres = new Set<string>()
  const tagKeys = new Set<string>()
  const tagValues: Record<string, Set<string>> = {}

  for (const item of allItems) {
    // Collect genres
    if (item.genres) {
      item.genres.forEach((genre) => genres.add(genre.trim()))
    }

    // Collect tags
    if (item.tags) {
      for (const [key, value] of Object.entries(item.tags)) {
        if (key) {
          tagKeys.add(key.trim())
          if (!tagValues[key]) {
            tagValues[key] = new Set<string>()
          }
          // Split comma-separated values and add them individually
          value.split(',').forEach((v) => {
            const trimmedV = v.trim()
            if (trimmedV) {
              tagValues[key].add(trimmedV)
            }
          })
        }
      }
    }
  }

  const tagValuesAsArrays: Record<string, string[]> = {}
  for (const key in tagValues) {
    tagValuesAsArrays[key] = Array.from(tagValues[key]).sort()
  }

  return {
    genres: Array.from(genres).sort(),
    tagKeys: Array.from(tagKeys).sort(),
    tagValues: tagValuesAsArrays
  }
}

async function fetchMetadataForLibrary(db: Database, window: BrowserWindow, tmdbApiKey?: string) {
  const libraryDataPath = getLibraryDataPath()
  if (!tmdbApiKey || !db.root) {
    console.warn('Metadata fetch skipped: No API key or library root.')
    return
  }

  const newItemsToFetch: { item: LibraryItem; hint?: 'movie' | 'tv' }[] = []
  const itemsMissingPosters: LibraryItem[] = []
  collectItemsToProcess(db.root, newItemsToFetch, itemsMissingPosters)

  if (newItemsToFetch.length === 0 && itemsMissingPosters.length === 0) {
    console.log('[Metadata] No new items or missing posters to fetch based on folder settings.')
    return
  }

  // Fetch and cache the genre lists before processing items.
  await cacheGenreLists(tmdbApiKey)

  // Process new items by searching for them on TMDB.
  if (newItemsToFetch.length > 0) {
    console.log(`[Metadata] Starting fetch for ${newItemsToFetch.length} new items...`)
    const task = async (itemWithHint: {
      item: LibraryItem
      hint?: 'movie' | 'tv'
    }): Promise<void> => {
      const { item, hint } = itemWithHint
      await fetchAndApplyMetadata(item, tmdbApiKey, libraryDataPath, hint)
      if (item.posterPath || item.tmdbId === null) {
        window.webContents.send('library-item-updated', item)
      }
    }
    await processInChunks(newItemsToFetch, 17, task)
  }

  // Re-fetch posters for existing items that are missing them.
  if (itemsMissingPosters.length > 0) {
    console.log(`[Metadata] Starting poster refetch for ${itemsMissingPosters.length} items...`)
    const task = async (item: LibraryItem): Promise<void> => {
      await refetchPoster(item, tmdbApiKey, libraryDataPath)
      if (item.posterPath) {
        window.webContents.send('library-item-updated', item)
      }
    }
    await processInChunks(itemsMissingPosters, 17, task)
  }

  await writeDb(db)
  console.log('[Metadata] Finished all fetching and saved final DB.')
}

export function setupLibraryIpc(): void {
  // Load the database into memory when the app is ready
  loadDbIntoMemory()

  ipcMain.handle('get-library-root', async () => {
    // If db is not in memory, try loading it.
    if (!db) {
      await loadDbIntoMemory()
    }
    return db?.root ?? null
  })

  ipcMain.handle('get-library-media-source-path', async () => {
    return db?.mediaSourcePath ?? null
  })

  ipcMain.handle('refresh-library', async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    if (!focusedWindow) return null

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
          const oldFolderProps =
            oldItem.type === 'folder'
              ? {
                  layout: oldItem.layout,
                  childrenClickAction: oldItem.childrenClickAction,
                  retrieve_children_metadata: oldItem.retrieve_children_metadata,
                  children_type_hint: oldItem.children_type_hint
                }
              : {}

          Object.assign(item, {
            title: oldItem.title,
            overview: oldItem.overview,
            posterPath: oldItem.posterPath,
            backdropPath: oldItem.backdropPath,
            tmdbId: oldItem.tmdbId,
            mediaType: oldItem.mediaType,
            year: oldItem.year,
            genres: oldItem.genres,
            tags: oldItem.tags,
            _v: oldItem._v,
            ...oldFolderProps,
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
      fetchMetadataForLibrary(db, focusedWindow, settings.tmdbApiKey).catch((err) =>
        console.error('Background metadata fetch failed during refresh:', err)
      )

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
      return db?.root ?? null
    }

    const mediaSourcePath = result.filePaths[0]
    console.log(`Starting scan of: ${mediaSourcePath}`)

    try {
      // 1. Scan directory structure first.
      const rootNode = await scanDirectory(mediaSourcePath, mediaSourcePath)

      const newDb: Database = {
        version: DB_VERSION,
        mediaSourcePath,
        root: rootNode
      }

      // 2. Write the initial DB with file structure. This also updates our in-memory `db` variable.
      await writeDb(newDb)
      console.log('Initial scan complete. Database updated with file structure.')

      // 3. Start background metadata fetching without blocking.
      const settings = await readSettings()
      // Pass the new in-memory `db` object to the fetcher
      fetchMetadataForLibrary(db!, focusedWindow, settings.tmdbApiKey).catch((err) =>
        console.error('Background metadata fetch failed during initial scan:', err)
      )

      // 4. Return the initial structure immediately to the UI.
      return db!.root
    } catch (error) {
      console.error('Failed to scan directory:', error)
      return null
    }
  })

  ipcMain.handle('get-item-details', async (_, itemId: string): Promise<LibraryItem | null> => {
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
      item._v = Date.now() // Bust cache after image updates
      await writeDb(db) // Save changes to disk and memory

      // Notify the renderer that the item has been updated with new details.
      const focusedWindow = BrowserWindow.getFocusedWindow()
      focusedWindow?.webContents.send('library-item-updated', item)
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
      await writeDb(db) // Persist the change
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

  ipcMain.handle('get-autocomplete-suggestions', getAutocompleteSuggestions)

  ipcMain.handle('update-item', async (event, updatedItem: LibraryItem): Promise<void> => {
    if (!db || !db.root) {
      console.error('Cannot update item: database not found in memory.')
      return
    }

    const itemInDb = findItemById(updatedItem.id, db.root)
    if (itemInDb) {
      // The updatedItem from the renderer is a modified clone of the original.
      // We merge its properties into the item in our database.
      // This preserves properties not editable in the UI (like `path`) and
      // the object reference within the parent's `children` array.
      Object.assign(itemInDb, updatedItem)

      await writeDb(db) // Persist changes to disk and update in-memory `db`
      console.log(`Updated item ${updatedItem.id} in database.`)

      // Notify renderer about the update so UI can refresh everywhere.
      const window = BrowserWindow.fromWebContents(event.sender)
      window?.webContents.send('library-item-updated', itemInDb)
    } else {
      console.error(`Could not find item with id ${updatedItem.id} in DB to update.`)
    }
  })

  ipcMain.handle('manual-search', async (_, query: string, type: 'movie' | 'tv') => {
    const { tmdbApiKey } = await readSettings()
    if (!tmdbApiKey) {
      console.warn('Manual search skipped: No TMDB API key.')
      return []
    }
    return manualSearch(query, type, tmdbApiKey)
  })

  ipcMain.handle(
    'get-tmdb-images',
    async (_, tmdbId: number, mediaType: 'movie' | 'tv', language: string) => {
      const { tmdbApiKey } = await readSettings()
      if (!tmdbApiKey) {
        console.warn('Image fetch skipped: No TMDB API key.')
        return { posters: [], backdrops: [] }
      }
      return getTmdbImages(tmdbId, mediaType, tmdbApiKey, language)
    }
  )

  ipcMain.handle(
    'apply-tmdb-result',
    async (event, itemId: string, result: any, mediaType: 'movie' | 'tv') => {
      if (!db || !db.root) return
      const item = findItemById(itemId, db.root)
      if (!item) return

      const { tmdbApiKey } = await readSettings()
      const libraryDataPath = getLibraryDataPath()
      if (!tmdbApiKey) return

      // Clear old data that will be replaced
      item.overview = undefined
      item.backdropPath = undefined
      item.year = undefined
      item.genres = []
      item.posterPath = undefined // Clear poster so it gets re-fetched by fetchItemDetails

      // Set new core identifiers
      item.tmdbId = result.id
      item.mediaType = mediaType
      item.title = result.title

      // This will fetch poster, backdrop, and other details (overview, year, genres)
      await fetchItemDetails(item, tmdbApiKey, libraryDataPath)
      item._v = Date.now() // Bust cache after image updates

      // The details from TMDB might have a more accurate/complete title. Let's update it one last time.
      const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${result.id}?api_key=${tmdbApiKey}`
      try {
        const response = await fetch(detailUrl)
        if (response.ok) {
          const details = await response.json()
          item.title = details.title || details.name
        }
      } catch (e) {
        console.error('Could not re-verify title from TMDB details endpoint', e)
      }

      await writeDb(db)

      const window = BrowserWindow.fromWebContents(event.sender)
      window?.webContents.send('library-item-updated', item)
    }
  )

  ipcMain.handle('select-local-image', async (): Promise<string | null> => {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    if (!focusedWindow) return null

    const result = await dialog.showOpenDialog(focusedWindow, {
      properties: ['openFile'],
      title: 'Select Image',
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle(
    'set-image',
    async (
      event,
      itemId: string,
      imageType: 'poster' | 'backdrop',
      source: { type: 'tmdb'; path: string } | { type: 'local'; path: string }
    ) => {
      if (!db || !db.root) return
      const item = findItemById(itemId, db.root)
      if (!item) return

      const libraryDataPath = getLibraryDataPath()
      const imagesDir = path.join(libraryDataPath, 'images')
      const extension = source.type === 'local' ? path.extname(source.path) : '.jpg'
      const fileName =
        imageType === 'poster' ? `${item.id}${extension}` : `${item.id}-backdrop${extension}`
      const destPath = path.join(imagesDir, fileName)

      try {
        if (source.type === 'tmdb') {
          const size = imageType === 'poster' ? 'w500' : 'original'
          const url = `https://image.tmdb.org/t/p/${size}${source.path}`
          await downloadImage(url, destPath)
        } else {
          // local
          await fs.copyFile(source.path, destPath)
        }

        if (imageType === 'poster') item.posterPath = fileName
        else item.backdropPath = fileName

        item._v = Date.now() // Bust cache
        await writeDb(db)
        const window = BrowserWindow.fromWebContents(event.sender)
        window?.webContents.send('library-item-updated', item)
      } catch (err) {
        console.error(`Failed to set image for ${itemId}:`, err)
        dialog.showErrorBox('Image Error', `Failed to set image. Check logs for details.`)
      }
    }
  )

  ipcMain.handle('get-item-by-id', async (_, itemId: string): Promise<LibraryItem | null> => {
    if (!db || !db.root) {
      return null
    }
    // Return a deep copy to avoid issues with proxies and non-clonable objects
    const item = findItemById(itemId, db.root)
    return item ? JSON.parse(JSON.stringify(item)) : null
  })
}
