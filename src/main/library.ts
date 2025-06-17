import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import { exec } from 'child_process'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Main] ${message}`)
}
import path from 'path'
import fs from 'fs/promises'
import crypto from 'crypto'
import { evaluateVirtualTagsForItem } from './virtualTags'
import {
  createDbProxy,
  buildFullSearchIndex,
  updateIndexForItem,
  performSearch,
  debugPerformSearch
} from './search'
import type {
  Database,
  MediaFolder,
  LibraryItem,
  MediaFile,
  AutocompleteSuggestions
} from './types'
import {
  cacheGenreLists,
  fetchAndApplyMetadata,
  fetchItemDetails,
  refetchPoster,
  manualSearch,
  getTmdbImages,
  downloadImage
} from './retriever'
import { readSettings, type Settings } from './settings'

const LIBRARY_DATA_DIR_NAME = 'library'
const DATABASE_FILE_NAME = 'database.json'
const DB_VERSION = 1

// --- In-Memory Database Cache ---
let db: Database | null = null
let isBulkUpdating = false

export const getBulkUpdateStatus = (): boolean => isBulkUpdating
const setBulkUpdateStatus = (status: boolean): void => {
  isBulkUpdating = status
  console.log(`[Library] Bulk update mode: ${status ? 'ON' : 'OFF'}`)
}

/**
 * Recursively traverses the library tree and applies virtual tags to each item.
 * This function MUTATES the items in place.
 */
function applyVirtualTagsToAllItems(node: LibraryItem, settings: Settings) {
  node.virtualTags = evaluateVirtualTagsForItem(node, settings)
  if (node.type === 'folder') {
    for (const child of node.children) {
      applyVirtualTagsToAllItems(child, settings)
    }
  }
}

async function loadDbIntoMemory(): Promise<void> {
  log('Attempting to load database from disk...')
  const rawDb = await readDb()

  if (rawDb) {
    log('Database file found. Processing...')
    setBulkUpdateStatus(true)
    if (rawDb.root) {
      const settings = await readSettings()
      applyVirtualTagsToAllItems(rawDb.root, settings)
    }
    // Wrap the loaded database in our proxy, passing our status checker.
    db = createDbProxy(rawDb, getBulkUpdateStatus)
    log('Database wrapped in proxy.')
    // And build the initial search index
    buildFullSearchIndex(db.root)
    setBulkUpdateStatus(false)
    log('Finished loading DB into memory.')
  } else {
    log('No database file found or DB is invalid.')
    // Ensure db is null and the search index is cleared if no database was found.
    db = null
    buildFullSearchIndex(null)
  }
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
        `Database version mismatch. Expected ${DB_VERSION}, got ${parsedDb.version}. Ignoring old DB.`
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
  // This function now handles both new raw objects and our existing proxy.
  const libraryPath = getLibraryDataPath()
  await fs.mkdir(libraryPath, { recursive: true })
  const dbPath = getDbPath()

  const replacer = (key: string, value: unknown) => {
    if (key === 'virtualTags') return undefined
    return value
  }

  // Persist the data. JSON.stringify reads through proxies just fine.
  await fs.writeFile(dbPath, JSON.stringify(updatedDb, replacer, 2))

  // If we were given a new object (not our current proxy), we must wrap it
  // and update the global `db` reference.
  if (db !== updatedDb) {
    db = createDbProxy(updatedDb, getBulkUpdateStatus)
    // A completely new DB means the search index needs a full rebuild.
    buildFullSearchIndex(db.root)
  }
  // If `db === updatedDb`, then `db` is already the correct proxy and no-op is needed.
}

function generateId(relativePath: string): string {
  return crypto.createHash('sha256').update(relativePath).digest('hex')
}

/**
 * Creates a shallow, clonable copy of a library item.
 * For folders, it replaces the `children` array with a shallow copy where
 * each child's own `children` array is set to `null` to indicate they are not loaded.
 * This is the core of the lazy-loading mechanism.
 * @param item The item to create a shallow copy of.
 * @returns A plain JavaScript object ready for IPC.
 */
function createShallowClonableCopy(item: LibraryItem): LibraryItem {
  const plainItem = JSON.parse(JSON.stringify(item))

  if (plainItem.type === 'folder') {
    plainItem.children = plainItem.children.map((child: LibraryItem) => {
      if (child.type === 'folder') {
        // Mark nested children as not loaded
        child.children = null as any
      }
      return child
    })
  }

  return plainItem
}

function findItemById(id:string, node: MediaFolder): LibraryItem | null {
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
  if (item.logoPath) {
    try {
      await fs.access(path.join(imagesDir, item.logoPath))
    } catch {
      console.log(`Logo for "${item.name}" not found. Marking for re-download.`)
      item.logoPath = undefined
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

async function getAutocompleteSuggestions(): Promise<AutocompleteSuggestions> {
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
    if (!db) {
      await loadDbIntoMemory()
    }
    // This now correctly returns only the root with its immediate children,
    // enforcing a lazy-loading pattern on the frontend from the start.
    return db?.root ? createShallowClonableCopy(db.root) : null
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
      setBulkUpdateStatus(true)
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
                  children_type_hint: oldItem.children_type_hint,
                  groupBy: oldItem.groupBy,
                  virtualFolderSettings: oldItem.virtualFolderSettings
                }
              : {}

          Object.assign(item, {
            title: oldItem.title,
            overview: oldItem.overview,
            posterPath: oldItem.posterPath,
            backdropPath: oldItem.backdropPath,
            logoPath: oldItem.logoPath,
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

        await verifyImagePaths(item, imagesDir)

        if (item.type === 'folder') {
          await Promise.all(item.children.map(processItem))
        }
      }

      await processItem(newRoot)

      // Directly set the new root on our proxied DB. The proxy will detect this change.
      db.root = newRoot

      // Apply virtual tags. These changes will also be detected by the proxy.
      const currentSettings = await readSettings()
      applyVirtualTagsToAllItems(db.root, currentSettings)

      // Rebuild the search index now that all data is merged and updated.
      buildFullSearchIndex(db.root)
      setBulkUpdateStatus(false)

      await writeDb(db)
      console.log('Library refresh and search index rebuild complete. Database updated.')

      const settings = await readSettings()
      fetchMetadataForLibrary(db, focusedWindow, settings.tmdbApiKey).catch((err) =>
        console.error('Background metadata fetch failed during refresh:', err)
      )

      return db.root ? createShallowClonableCopy(db.root) : null
    } catch (error) {
      console.error('Failed to refresh library:', error)
      // On error, we can send a deep copy of the old root as a fallback.
      return db?.root ? JSON.parse(JSON.stringify(db.root)) : null
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

      setBulkUpdateStatus(true)
      const newDb: Database = {
        version: DB_VERSION,
        mediaSourcePath,
        root: rootNode
      }

      // 2. Apply virtual tags before creating the proxy.
      const settings = await readSettings()
      applyVirtualTagsToAllItems(rootNode, settings)
      setBulkUpdateStatus(false) // Turn off before metadata fetch starts.

      // 3. This will create the proxy, update the global `db`, and build the search index.
      await writeDb(newDb)
      console.log('Initial scan, DB write, and index build complete.')

      // 4. Start background metadata fetching without blocking.
      fetchMetadataForLibrary(db!, focusedWindow, settings.tmdbApiKey).catch((err) =>
        console.error('Background metadata fetch failed during initial scan:', err)
      )

      // 5. Return the initial structure immediately to the UI.
      return db!.root ? createShallowClonableCopy(db!.root) : null
    } catch (error) {
      console.error('Failed to scan directory:', error)
      return null
    }
  })

  ipcMain.handle('get-item-details', async (_, itemId: string): Promise<LibraryItem | null> => {
    if (!db || !db.root) {
      console.error('Cannot get item details: database not found.')
      return null
    }

    const item = findItemById(itemId, db.root)
    if (!item) {
      console.error(`Cannot get item details: item with id ${itemId} not found.`)
      return null
    }

    // Verify local image paths. This is a fast, local operation.
    await verifyImagePaths(item, path.join(getLibraryDataPath(), 'images'))

    const detailsAlreadyFetched =
      typeof item.backdropPath !== 'undefined' && typeof item.logoPath !== 'undefined'

    // --- Fire-and-Forget Background Fetch ---
    // If details are missing, start a background fetch but DO NOT wait for it to complete.
    if (!detailsAlreadyFetched) {
      // Use an IIFE (Immediately Invoked Function Expression) to run the async logic
      // without blocking the main handler's return.
      ;(async () => {
        console.log(`[Details] Starting background fetch for "${item.name}" (${item.id})`)
        const settings = await readSettings()
        if (settings.tmdbApiKey && item.tmdbId) {
          // The `item` object is a reference to the one in the `db` cache,
          // so `fetchItemDetails` will modify it directly.
          setBulkUpdateStatus(true)
          await fetchItemDetails(item, settings, getLibraryDataPath())
          item._v = Date.now()
          setBulkUpdateStatus(false)

          // Manually trigger a single, incremental re-index now that the fetch is complete.
          updateIndexForItem(item)

          await writeDb(db) // Save the updated database

          // Notify all renderer windows that the item has been updated.
          const plainItem = JSON.parse(JSON.stringify(item))
          BrowserWindow.getAllWindows().forEach((window) => {
            window.webContents.send('library-item-updated', plainItem)
          })
          console.log(`[Details] Background fetch complete for "${item.name}"`)
        }
      })().catch((err) => {
        // Catch errors within the fire-and-forget block to prevent unhandled rejections.
        console.error(`[Details] Background fetch for item ${itemId} failed:`, err)
      })
    }

    // --- Immediate Return ---
    // Return a deep copy to avoid issues with proxies and non-clonable objects over IPC.
    return item ? JSON.parse(JSON.stringify(item)) : null
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

  ipcMain.handle('update-item', async (_, updatedItem: LibraryItem): Promise<void> => {
    if (!db || !db.root) {
      console.error('Cannot update item: database not found in memory.')
      return
    }

    const itemInDb = findItemById(updatedItem.id, db.root)
    if (itemInDb) {
      setBulkUpdateStatus(true)
      // Defensively apply updates. We create a copy of the incoming item
      // and delete the properties we do not want to overwrite in the database.
      // This prevents structural properties like `children` from being overwritten
      // with `null` if the `updatedItem` object comes from a lazy-loaded part of the renderer.
      const safeUpdates = { ...updatedItem }
      delete (safeUpdates as Partial<MediaFolder>).children
      delete (safeUpdates as Partial<LibraryItem>).id
      delete (safeUpdates as Partial<LibraryItem>).path
      delete (safeUpdates as Partial<LibraryItem>).type

      Object.assign(itemInDb, safeUpdates)

      const settings = await readSettings()
      itemInDb.virtualTags = evaluateVirtualTagsForItem(itemInDb, settings)
      setBulkUpdateStatus(false)

      // The proxy was suppressed during the bulk update.
      // Manually trigger a single, incremental update for the item now.
      updateIndexForItem(itemInDb)

      await writeDb(db)
      console.log(`Updated item ${updatedItem.id} in database.`)

      const newSuggestions = await getAutocompleteSuggestions()

      const plainItem = JSON.parse(JSON.stringify(itemInDb))
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send('library-item-updated', plainItem)
        window.webContents.send('autocomplete-suggestions-updated', newSuggestions)
      })
    } else {
      console.error(`Could not find item with id ${updatedItem.id} in DB to update.`)
    }
  })

  ipcMain.handle('manual-search', async (_, query: string, type: 'movie' | 'tv', year?: string) => {
    const { tmdbApiKey } = await readSettings()
    if (!tmdbApiKey) {
      console.warn('Manual search skipped: No TMDB API key.')
      return []
    }
    return manualSearch(query, type, tmdbApiKey, year)
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

      const settings = await readSettings()
      const libraryDataPath = getLibraryDataPath()
      if (!settings.tmdbApiKey) return

      // Clear old data that will be replaced
      item.overview = undefined
      item.backdropPath = undefined
      item.logoPath = undefined
      item.year = undefined
      item.genres = []
      if (item.type === 'file') {
        item.opensAsFolder = true
      }
      item.posterPath = undefined // Clear poster so it gets re-fetched by fetchItemDetails

      // Set new core identifiers
      item.tmdbId = result.id
      item.mediaType = mediaType
      item.title = result.title

      // This will fetch poster, backdrop, and other details (overview, year, genres)
      await fetchItemDetails(item, settings, libraryDataPath)
      item._v = Date.now() // Bust cache after image updates

      // The details from TMDB might have a more accurate/complete title. Let's update it one last time.
      const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${result.id}?api_key=${settings.tmdbApiKey}`
      try {
        const response = await fetch(detailUrl)
        if (response.ok) {
          const details = await response.json()
          item.title = details.title || details.name
        }
      } catch (e) {
        console.error('Could not re-verify title from TMDB details endpoint', e)
      }

      // Re-evaluate virtual tags after all other properties have been updated.
      item.virtualTags = evaluateVirtualTagsForItem(item, settings)

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
      imageType: 'poster' | 'backdrop' | 'logo',
      source: { type: 'tmdb'; path: string } | { type: 'local'; path: string }
    ) => {
      if (!db || !db.root) return
      const item = findItemById(itemId, db.root)
      if (!item) return

      const libraryDataPath = getLibraryDataPath()
      const imagesDir = path.join(libraryDataPath, 'images')
      const extension = path.extname(source.path)
      let fileName = ''
      switch (imageType) {
        case 'poster':
          fileName = `${item.id}${extension || '.jpg'}`
          break
        case 'backdrop':
          fileName = `${item.id}-backdrop${extension || '.jpg'}`
          break
        case 'logo':
          fileName = `${item.id}-logo${extension || '.svg'}`
          break
      }
      const destPath = path.join(imagesDir, fileName)

      try {
        if (source.type === 'tmdb') {
          let size = 'original'
          if (imageType === 'poster') size = 'w500'
          if (imageType === 'logo') size = 'w500'
          const url = `https://image.tmdb.org/t/p/${size}${source.path}`
          await downloadImage(url, destPath)
        } else {
          // local
          await fs.copyFile(source.path, destPath)
        }

        if (imageType === 'poster') item.posterPath = fileName
        else if (imageType === 'backdrop') item.backdropPath = fileName
        else if (imageType === 'logo') item.logoPath = fileName

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

  ipcMain.handle(
    'remove-image',
    async (event, itemId: string, imageType: 'poster' | 'backdrop' | 'logo') => {
      if (!db || !db.root) return
      const item = findItemById(itemId, db.root)
      if (!item) return

      if (imageType === 'poster') item.posterPath = null
      else if (imageType === 'backdrop') item.backdropPath = null
      else if (imageType === 'logo') item.logoPath = null

      item._v = Date.now() // Bust cache
      await writeDb(db)
      const window = BrowserWindow.fromWebContents(event.sender)
      window?.webContents.send('library-item-updated', item)
    }
  )

  ipcMain.handle(
    'perform-search',
    async (_, query: { text: string; tags: { key: string; value: string }[] }) => {
      // Calls the lean, fast search function for the UI.
      return performSearch(query)
    }
  )

  ipcMain.handle(
    'debug-perform-search',
    async (_, query: { text: string; tags: { key: string; value: string }[] }) => {
      // Calls the verbose search function for the debug console.
      return debugPerformSearch(query)
    }
  )

  ipcMain.handle('get-item-by-id', async (_, itemId: string): Promise<LibraryItem | null> => {
    if (!db || !db.root) {
      return null
    }
    const item = findItemById(itemId, db.root)
    // Return a shallow, clonable copy. This is crucial for enforcing the
    // lazy-loading contract on the frontend. Any folder sent will have
    // its deeper children marked as not-loaded (`null`).
    return item ? createShallowClonableCopy(item) : null
  })

  ipcMain.handle('get-children', async (_, parentId: string): Promise<LibraryItem[] | null> => {
    if (!db || !db.root) return null

    const parent = findItemById(parentId, db.root)
    if (!parent || parent.type !== 'folder') return null

    // Create a shallow, clonable copy of each child.
    const clonableChildren = parent.children.map((child) => createShallowClonableCopy(child))
    return clonableChildren
  })
}
