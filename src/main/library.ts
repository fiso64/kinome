import { app, dialog, ipcMain, BrowserWindow, shell } from 'electron'
import { exec } from 'child_process'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Main] ${message}`)
}
import path from 'path'
import fs, { readdir, stat } from 'fs/promises'
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
  AutocompleteSuggestions,
  Settings
} from '../shared/types'
import {
  FOLDER_BEHAVIOR_SETTINGS_KEYS,
  METADATA_KEYS,
  RESETTABLE_METADATA_KEYS,
  VIEW_SETTINGS_KEYS
} from '../shared/types'
import {
  cacheGenreLists,
  fetchAndApplyMetadata,
  fetchItemDetails,
  fetchAndApplyCredits,
  applyTvShowData,
  fetchAndApplyEpisodeData,
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
    plainItem.children = plainItem.children
      .filter((child: LibraryItem) => !child.isHidden) // Filter out hidden items
      .map((child: LibraryItem) => {
        if (child.type === 'folder') {
          // Mark nested children as not loaded
          child.children = null as any
        }
        return child
      })
  }

  return plainItem
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

async function getDirectoryContentStats(dirPath: string): Promise<{
  totalSize: number
  fileCount: number
  folderCount: number
}> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  let totalSize = 0
  let fileCount = 0
  let folderCount = 0

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

function findParent(id: string, node: MediaFolder): MediaFolder | null {
  for (const child of node.children) {
    if (child.id === id) {
      return node
    }
    if (child.type === 'folder') {
      const found = findParent(id, child)
      if (found) return found
    }
  }
  return null
}

/**
 * Parses season and episode numbers from a filename.
 * @returns An object with season and episode, or null.
 */
/**
 * Parses season and episode numbers from a filename using several patterns.
 * @returns An object with season (optional), episode, and pattern, or null.
 */
function parseEpisodeInfo(
  name: string
): { season?: number; episode: number; pattern: 'sxxexx' | 'episode_xx' | 'exx' } | null {
  // 1. SxxExx pattern (highest precedence)
  const sxxexxPatterns = [/\bS(\d{1,2})\s?\.?\s?E(\d{1,3})\b/i, /S(\d{1,2})E(\d{1,3})/i]
  for (const pattern of sxxexxPatterns) {
    const match = name.match(pattern)
    if (match) {
      return { season: parseInt(match[1]), episode: parseInt(match[2]), pattern: 'sxxexx' }
    }
  }

  // 2. "Episode XX" pattern
  const episodeXXPattern = /\bEpisode\s*(\d{1,2})\b/i
  const episodeMatch = name.match(episodeXXPattern)
  if (episodeMatch) {
    return { episode: parseInt(episodeMatch[1]), pattern: 'episode_xx' }
  }

  // 3. "E_XX" pattern (stricter, to avoid matching other things)
  const exxPattern = /\bE(\d{2})\b/i
  const exxMatch = name.match(exxPattern)
  if (exxMatch) {
    return { episode: parseInt(exxMatch[1]), pattern: 'exx' }
  }

  return null
}

/**
 * Tries to assign episode numbers to a list of files based on a consistent naming pattern.
 * A pattern is considered successful if it matches all files, or if it matches at least 3
 * files and has no more than 2 mismatches.
 * This function MUTATES the file objects in the passed array.
 * @param files The array of MediaFile objects to process.
 * @param parentSeasonNumber A fallback season number if not present in the filename.
 * @returns `true` if a consistent pattern was found and applied, `false` otherwise.
 */
function processAndAssignEpisodeNumbers(files: MediaFile[], parentSeasonNumber?: number): boolean {
  if (files.length === 0) return true // Nothing to do

  const patterns: ('sxxexx' | 'episode_xx' | 'exx')[] = ['sxxexx', 'episode_xx', 'exx']

  // First, get all parsing results for all files to avoid re-parsing.
  const allParsedInfo = files.map((file) => ({ file, parsed: parseEpisodeInfo(file.name) }))

  for (const currentPattern of patterns) {
    const matches = allParsedInfo.filter((info) => info.parsed?.pattern === currentPattern)
    const mismatches = allParsedInfo.length - matches.length

    // Condition: up to 2 mismatches are allowed, but only if there are at least 3 matches.
    // Also succeeds if there are 0 mismatches (all files match).
    if (mismatches === 0 || (mismatches <= 2 && matches.length >= 3)) {
      // Success! This is our pattern.
      log(
        `TV Structure: Applying pattern "${currentPattern}". Matches: ${matches.length}, Mismatches: ${mismatches}`
      )

      // Apply the found numbers only to the files that matched the pattern.
      matches.forEach(({ file, parsed }) => {
        if (parsed) {
          file.mediaType = 'episode'
          file.episodeNumber = parsed.episode
          // For SxxExx, use the parsed season number. For others, use the parent folder's season number.
          file.seasonNumber = parsed.season ?? parentSeasonNumber
        }
      })
      // Files that didn't match the pattern will simply not have episode/season numbers assigned.
      return true
    }
  }

  // If no pattern met the criteria
  return false
}

const SPECIAL_FOLDER_NAMES_FOR_TV = ['extras', 'specials', 'deleted scenes', 'featurettes', 'nc']

/**
 * Analyzes a TV show's folder structure to assign season/episode numbers
 * to its children before any API calls. This function MUTATES the children.
 * @param showFolder The root folder of the TV show.
 */
function processTvShowStructure(showFolder: MediaFolder): void {
  log(`Processing TV structure for: "${showFolder.name}"`)
  const mediaFiles = showFolder.children.filter((c) => c.type === 'file') as MediaFile[]
  const subFolders = showFolder.children.filter(
    (c) => c.type === 'folder' && !SPECIAL_FOLDER_NAMES_FOR_TV.includes(c.name.toLowerCase())
  ) as MediaFolder[]

  // Heuristic 1: "Immediate Files" Rule
  if (mediaFiles.length > 0) {
    log(`TV Structure: Found ${mediaFiles.length} immediate files. Entering "File Mode".`)
    // Use the new advanced parser, assuming Season 1 for files in the root.
    const parsedSuccessfully = processAndAssignEpisodeNumbers(mediaFiles, 1)

    if (!parsedSuccessfully) {
      log(
        'TV Structure: High-confidence parsing failed, falling back to alphabetical sort for Season 1.'
      )
      // Alphabetical Fallback
      mediaFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      mediaFiles.forEach((file, index) => {
        file.seasonNumber = 1
        file.episodeNumber = index + 1
        file.mediaType = 'episode'
      })
    }
    return
  }

  // Heuristics 2 & 3 for subfolders
  if (subFolders.length > 0) {
    log(`TV Structure: Found ${subFolders.length} subfolders. Analyzing folder names.`)

    const seasonPattern = /\b(?:Season\s*|S)(\d{1,2})\b/i
    const parsedFolders: { folder: MediaFolder; season: number }[] = []

    // First pass: try to parse all folders.
    for (const folder of subFolders) {
      const seasonMatch = folder.name.match(seasonPattern)
      if (seasonMatch) {
        parsedFolders.push({ folder, season: parseInt(seasonMatch[1]) })
      }
    }

    // Heuristic 2: "Patterned Subfolders" Rule.
    // If we found at least one folder that looks like a season.
    if (parsedFolders.length > 0) {
      log(
        `TV Structure: Found ${parsedFolders.length} patterned season folders. Entering "Patterned" mode.`
      )
      // Only assign season numbers to folders that matched.
      for (const { folder, season } of parsedFolders) {
        folder.seasonNumber = season
        folder.mediaType = 'season'
      }
    } else {
      log(
        'TV Structure: No season folder name patterns matched, falling back to alphabetical sort.'
      )
      // Heuristic 3: "Alphabetical Subfolders" Rule (Final Fallback)
      subFolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      subFolders.forEach((folder, index) => {
        // Assign season number starting from 1
        folder.seasonNumber = index + 1
        folder.mediaType = 'season'
      })
    }
  }
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

async function scanDirectory(dirPath: string, rootPath: string): Promise<MediaFolder | null> {
  const name = path.basename(dirPath)
  const children: LibraryItem[] = []

  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    const entryRelativePath = path.relative(rootPath, entryPath)

    if (entry.isDirectory()) {
      const subFolder = await scanDirectory(entryPath, rootPath)
      if (subFolder) {
        children.push(subFolder)
      }
    } else if (entry.isFile()) {
      // Simple filter for common video files
      if (/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(entry.name)) {
        children.push({
          id: generateId(entryRelativePath),
          name: entry.name,
          path: entryPath,
          type: 'file'
        })
      }
    }
  }

  // If there are no children (no video files or non-empty subfolders), return null.
  if (children.length === 0) {
    return null
  }

  const relativePath = path.relative(rootPath, dirPath)
  const folder: MediaFolder = {
    id: generateId(relativePath || '.'), // Use dot for root itself
    name: name || path.basename(rootPath), // Use root basename if name is empty
    path: dirPath,
    type: 'folder',
    children
  }
  return folder
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
      // **THE FIX**: Do not process items that are marked as hidden.
      if (child.isHidden) {
        continue
      }
      if (typeof child.tmdbId === 'undefined') {
        newItems.push({ item: child, hint: folder.children_type_hint })
      } else if (child.tmdbId && !child.posterPath) {
        itemsMissingPosters.push(child)
      }
    }
  }

  // Always recurse into subfolders to check their flags, but skip hidden folders.
  for (const child of folder.children) {
    if (child.type === 'folder' && !child.isHidden) {
      collectItemsToProcess(child, newItems, itemsMissingPosters)
    }
  }
}

async function getAutocompleteSuggestions(): Promise<AutocompleteSuggestions> {
  if (!db || !db.root) {
    return { mediaTypes: [], genres: [], persons: [], tagKeys: [], virtualTagKeys: [], tagValues: {} }
  }

  const allItems = getAllItemsAsList(db.root)
  const mediaTypes = new Set<string>()
  const genres = new Set<string>()
  const persons = new Set<string>()
  const tagKeys = new Set<string>()
  const virtualTagKeys = new Set<string>()
  const tagValues: Record<string, Set<string>> = {}

  for (const item of allItems) {
    // Collect media types
    if (item.mediaType) {
      mediaTypes.add(item.mediaType.trim())
    }
    // Collect genres
    if (item.genres) {
      item.genres.forEach((genre) => genres.add(genre.trim()))
    }

    // Collect persons from credits
    if (item.tmdbCredits) {
      ;(item.tmdbCredits.cast ?? []).forEach((p) => p.name && persons.add(p.name.trim()))
      ;(item.tmdbCredits.crew ?? []).forEach((p) => p.name && persons.add(p.name.trim()))
    }

    // Collect custom tags
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

    // Collect virtual tags
    if (item.virtualTags) {
      for (const [key, value] of Object.entries(item.virtualTags)) {
        if (key) {
          virtualTagKeys.add(key.trim())
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
    mediaTypes: Array.from(mediaTypes).sort(),
    genres: Array.from(genres).sort(),
    persons: Array.from(persons).sort(),
    tagKeys: Array.from(tagKeys).sort(),
    virtualTagKeys: Array.from(virtualTagKeys).sort(),
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

  // A function to send batched updates to the renderer
  const sendBatchUpdate = (updatedItems: LibraryItem[]): void => {
    if (updatedItems.length > 0) {
      // Create a plain, clonable copy of the items before sending over IPC.
      const plainItems = JSON.parse(JSON.stringify(updatedItems))
      window.webContents.send('library-items-updated', plainItems)
    }
  }

  // Fetch and cache the genre lists before processing items.
  await cacheGenreLists(tmdbApiKey)

  // Process new items by searching for them on TMDB.
  if (newItemsToFetch.length > 0) {
    console.log(`[Metadata] Starting fetch for ${newItemsToFetch.length} new items...`)
    const updatedItemsBatch: LibraryItem[] = []
    const task = async (itemWithHint: {
      item: LibraryItem
      hint?: 'movie' | 'tv'
    }): Promise<void> => {
      const { item, hint } = itemWithHint
      await fetchAndApplyMetadata(item, tmdbApiKey, libraryDataPath, hint)
      if (item.posterPath || item.tmdbId === null) {
        updatedItemsBatch.push(item)
      }
    }
    await processInChunks(newItemsToFetch, 17, task)
    sendBatchUpdate(updatedItemsBatch)
  }

  // Re-fetch posters for existing items that are missing them.
  if (itemsMissingPosters.length > 0) {
    console.log(`[Metadata] Starting poster refetch for ${itemsMissingPosters.length} items...`)
    const updatedItemsBatch: LibraryItem[] = []
    const task = async (item: LibraryItem): Promise<void> => {
      await refetchPoster(item, tmdbApiKey, libraryDataPath)
      if (item.posterPath) {
        updatedItemsBatch.push(item)
      }
    }
    await processInChunks(itemsMissingPosters, 17, task)
    sendBatchUpdate(updatedItemsBatch)
  }

  await writeDb(db)
  console.log('[Metadata] Finished all fetching and saved final DB.')
}

export async function reapplyVirtualTagsAfterSettingsChange() {
  if (!db || !db.root) {
    log('Cannot re-apply virtual tags: database not loaded.')
    return
  }
  log('Re-applying virtual tags to all items due to settings change...')

  setBulkUpdateStatus(true) // Prevent proxy from firing a zillion updates

  const settings = await readSettings() // Read the latest settings
  applyVirtualTagsToAllItems(db.root, settings) // Mutate the items in-memory

  // After bulk mutation, it's safer and often faster to just rebuild the index.
  buildFullSearchIndex(db.root)

  setBulkUpdateStatus(false) // Turn proxy back on for future single updates.

  // Although virtual tags aren't saved to disk, other item properties might
  // have been affected by plugins or other logic in the future. It's safer to save.
  await writeDb(db!)

  // We need to notify all renderer windows that basically everything has changed.
  // The `onLibraryItemsUpdated` handler in the renderer is built to handle this.
  const allItems = getAllItemsAsList(db.root)
  log(`Broadcasting update for ${allItems.length} items.`)
  const plainItems = JSON.parse(JSON.stringify(allItems)) // deep clone for IPC
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('library-items-updated', plainItems)
  })

  // Also, autocomplete suggestions for virtual tags might have changed.
  const newSuggestions = await getAutocompleteSuggestions()
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('autocomplete-suggestions-updated', newSuggestions)
  })

  log('Finished re-applying virtual tags and notified renderer.')
}

async function resetItemMetadata(item: LibraryItem, imagesDir: string) {
  // Delete associated image files first, as their paths are part of the metadata being reset.
  if (item.posterPath) {
    try {
      await fs.unlink(path.join(imagesDir, item.posterPath))
    } catch (e) {
      /* ignore if file not found */
    }
  }
  if (item.backdropPath) {
    try {
      await fs.unlink(path.join(imagesDir, item.backdropPath))
    } catch (e) {
      /* ignore if file not found */
    }
  }
  if (item.logoPath) {
    try {
      await fs.unlink(path.join(imagesDir, item.logoPath))
    } catch (e) {
      /* ignore if file not found */
    }
  }

  // Loop through the centrally-defined list of resettable keys and set them to undefined.
  // This approach is more maintainable than a hardcoded list of assignments.
  // We cast `item` to `any` here to allow dynamic key assignment.
  for (const key of RESETTABLE_METADATA_KEYS) {
    // Only attempt to delete the key if it exists on the item. This prevents
    // us from adding properties to an object that shouldn't have them (e.g. `episodeNumber` on a folder).
    if (key in item) {
      ;(item as any)[key] = undefined
    }
  }

  // Bust the UI cache to reflect the changes.
  item._v = Date.now()
}

async function clearChildrenRecursively(
  folder: MediaFolder,
  imagesDir: string,
  modifiedItems: LibraryItem[]
): Promise<void> {
  for (const child of folder.children) {
    await resetItemMetadata(child, imagesDir)
    modifiedItems.push(child)
    if (child.type === 'folder') {
      await clearChildrenRecursively(child, imagesDir, modifiedItems)
    }
  }
}

async function finalizeMetadataClear(modifiedItems: LibraryItem[]) {
  // Re-apply virtual tags for all modified items
  const currentSettings = await readSettings()
  for (const item of modifiedItems) {
    item.virtualTags = evaluateVirtualTagsForItem(item, currentSettings)
  }

  setBulkUpdateStatus(false) // Turn off before re-indexing

  // Manually trigger re-indexing for all modified items.
  for (const item of modifiedItems) {
    updateIndexForItem(item)
  }

  await writeDb(db!)
  log(`Finished metadata clear for ${modifiedItems.length} items.`)

  // Broadcast the batch update to all windows. This allows the UI to update
  // reactively without a full library reload.
  const plainItems = JSON.parse(JSON.stringify(modifiedItems))
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('library-items-updated', plainItems)
  })
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
      async function processItem(item: LibraryItem | null) {
        if (!item) return // Handle null items from scanner
        const oldItem = oldItemsMap.get(item.id)
        if (oldItem) {
          // A helper to copy properties from a list of keys.
          const copyProperties = (keys: readonly string[]) => {
            for (const key of keys) {
              if (Object.prototype.hasOwnProperty.call(oldItem, key)) {
                ;(item as any)[key] = (oldItem as any)[key]
              }
            }
          }

          // Copy all metadata and settings using the centralized key definitions.
          copyProperties(METADATA_KEYS)
          copyProperties(VIEW_SETTINGS_KEYS)
          copyProperties(FOLDER_BEHAVIOR_SETTINGS_KEYS)

          // Copy other preserved properties not covered by the main groups.
          item.isHidden = oldItem.isHidden
          item._v = oldItem._v
          if (item.type === 'file' && oldItem.type === 'file') {
            item.watched = oldItem.watched
          }
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
      if (db.root) {
        applyVirtualTagsToAllItems(db.root, currentSettings)
      }

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
      if (rootNode) {
        applyVirtualTagsToAllItems(rootNode, settings)
      }
      setBulkUpdateStatus(false) // Turn off before metadata fetch starts.

      // 3. This will create the proxy, update the global `db`, and build the search index.
      await writeDb(newDb)
      console.log('Initial scan, DB write, and index build complete.')

      // 4. Do NOT start background metadata fetching. The renderer will prompt the user
      // and trigger it via a separate IPC call.

      // 5. Return a DEEP, de-proxied copy of the root for the initial settings modal.
      // This ensures the tree view in the modal has the full folder structure.
      if (db!.root) {
        const deepCopy = JSON.parse(JSON.stringify(db!.root))
        // We still don't want hidden items to show up in the initial setup.
        function filterHiddenRecursively(folder: MediaFolder) {
          folder.children = folder.children.filter((child) => !child.isHidden)
          folder.children.forEach((child) => {
            if (child.type === 'folder') {
              filterHiddenRecursively(child)
            }
          })
        }
        filterHiddenRecursively(deepCopy)
        return deepCopy
      }
      return null
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

    // --- TV Show Structure Processing ---
    // If it's a TV show root that hasn't had its episodes fetched yet, process its structure to assign season/episode numbers locally first.
    if (
      item.type === 'folder' &&
      item.mediaType === 'tv' &&
      (item as MediaFolder).process_tv_children !== false &&
      !(item as MediaFolder).tmdbEpisodesFetched
    ) {
      setBulkUpdateStatus(true)
      processTvShowStructure(item as MediaFolder)
      setBulkUpdateStatus(false)
    }

    // If it's a season folder that needs details, process its children to assign episode numbers locally.
    const isSeasonNeedingDetails =
      item.type === 'folder' &&
      item.mediaType === 'season' &&
      !(item as MediaFolder).tmdbEpisodesFetched
    if (isSeasonNeedingDetails) {
      const showFolder = findParent(item.id, db!.root!)
      // Only process if the parent TV show allows it.
      if (showFolder?.process_tv_children !== false) {
        setBulkUpdateStatus(true)
        const episodeFiles = (item as MediaFolder).children.filter(
          (c) => c.type === 'file'
        ) as MediaFile[]

        // Use the new advanced parser, passing the parent folder's season number.
        const parsedSuccessfully = processAndAssignEpisodeNumbers(
          episodeFiles,
          (item as MediaFolder).seasonNumber
        )

        if (!parsedSuccessfully) {
          log(
            `TV Structure: High-confidence parsing failed for season folder "${item.name}", falling back to alphabetical sort.`
          )
          // Alphabetical Fallback
          episodeFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
          episodeFiles.forEach((file, index) => {
            file.episodeNumber = index + 1
            // Use the parent folder's season number.
            file.seasonNumber = (item as MediaFolder).seasonNumber
            file.mediaType = 'episode'
          })
        }
        setBulkUpdateStatus(false)
      }
    }
    // --- End TV Show Structure Processing ---

    // Verify local image paths. This is a fast, local operation.
    await verifyImagePaths(item, path.join(getLibraryDataPath(), 'images'))

    // --- Fire-and-Forget Background Fetches ---

    // -- Fetch #1: Core Details (Backdrop, Logo, Genres, Episodes etc.) ---
    // This is the highest priority fetch.
    const needsDetailsFetch = !item.tmdbDetailsFetched && item.tmdbId
    const needsEpisodeFetch =
      item.type === 'folder' &&
      (item.mediaType === 'tv' || item.mediaType === 'season') &&
      !item.tmdbEpisodesFetched

    if (needsDetailsFetch || needsEpisodeFetch) {
      ;(async () => {
        setBulkUpdateStatus(true)
        try {
          const settings = await readSettings()
          if (!settings.tmdbApiKey) return

          // --- Case 1: The item's own details are missing. Fetch them. ---
          // The `fetchItemDetails` function will subsequently call `applyTvShowData` if needed.
          if (needsDetailsFetch) {
            log(`[Details] Item details missing. Starting full fetch for "${item.name}"`)
            await fetchItemDetails(item, settings, getLibraryDataPath())
          }
          // --- Case 2: The item's details are present, but its children's are not. ---
          else if (needsEpisodeFetch && item.type === 'folder') {
            if (item.mediaType === 'season') {
              const showFolder = findParent(item.id, db!.root!)
              if (showFolder && showFolder.tmdbId && showFolder.process_tv_children !== false) {
                // To fetch episodes, we need the parent's `tmdbSeasons` list.
                // If the parent's details haven't been fetched, do that first.
                if (!showFolder.tmdbDetailsFetched) {
                  log(
                    `[Details] Parent show "${showFolder.name}" details missing, fetching them first.`
                  )
                  await fetchItemDetails(showFolder, settings, getLibraryDataPath())
                }

                // After attempting to fetch, check if the seasons array is available.
                if (showFolder.tmdbSeasons) {
                  log(`[Details] Season episodes missing. Fetching for "${item.name}"`)
                  await fetchAndApplyEpisodeData(
                    item,
                    showFolder.tmdbId,
                    settings.tmdbApiKey,
                    getLibraryDataPath(),
                    showFolder.tmdbSeasons
                  )
                } else {
                  // This is the key fix: if we can't fetch episodes because the parent show isn't
                  // ready, we must still mark this season as 'processed' to prevent an infinite
                  // loop of the renderer re-requesting details.
                  item.tmdbEpisodesFetched = true
                  log(
                    `[Details] Could not fetch episodes for season "${item.name}" (parent has no season data). Marked as processed to prevent loops.`
                  )
                }
              } else {
                // This is the key fix: if we can't fetch episodes because the parent show isn't
                // ready, we must still mark this season as 'processed' to prevent an infinite
                // loop of the renderer re-requesting details.
                item.tmdbEpisodesFetched = true
                log(
                  `[Details] Could not fetch episodes for season "${item.name}" (preconditions not met). Marked as processed to prevent loops.`
                )
              }
            } else if (item.mediaType === 'tv') {
              log(`[Details] TV show episode data missing. Processing children for "${item.name}"`)
              await applyTvShowData(item, settings, getLibraryDataPath())
            }
          }

          item._v = Date.now() // Bust UI cache
        } catch (err) {
          // Catch errors within the fire-and-forget block to prevent unhandled rejections.
          console.error(`[Details] Background fetch for item ${itemId} failed:`, err)
        } finally {
          setBulkUpdateStatus(false) // Ensure bulk mode is always turned off.

          // Manually trigger a single, incremental re-index now that the fetch is complete.
          updateIndexForItem(item)

          await writeDb(db!) // Save the updated database

          // Notify all renderer windows that the item has been updated.
          const plainItem = JSON.parse(JSON.stringify(item))
          BrowserWindow.getAllWindows().forEach((window) => {
            window.webContents.send('library-item-updated', plainItem)
          })
          log(`[Details] Background processing complete for "${item.name}"`)
        }
      })()
    }

    // --- Immediate Return ---
    // Return a deep copy to avoid issues with proxies and non-clonable objects over IPC.
    if (item) {
      const deepCopy = JSON.parse(JSON.stringify(item))
      if (deepCopy.type === 'folder' && Array.isArray(deepCopy.children)) {
        deepCopy.children = deepCopy.children.filter((child: LibraryItem) => !child.isHidden)
      }
      return deepCopy
    }
    return null
  })

  ipcMain.handle('fetch-credits', async (_, itemId: string): Promise<void> => {
    if (!db || !db.root) return
    const item = findItemById(itemId, db.root)
    if (!item) {
      console.error(`[Credits] Cannot fetch, item ${itemId} not found.`)
      return
    }

    const needsCreditsFetch =
      !item.tmdbCreditsFetched &&
      item.tmdbId &&
      (item.mediaType === 'movie' || item.mediaType === 'tv')

    if (!needsCreditsFetch) {
      log(`[Credits] Fetch not needed for "${item.name}".`)
      return
    }

    try {
      const settings = await readSettings()
      // This check is slightly redundant as the renderer should not call this
      // if the setting is 'hidden', but it's a good safeguard.
      if (!settings.tmdbApiKey || settings.creditsDisplay === 'hidden') {
        if (settings.creditsDisplay === 'hidden') {
          item.tmdbCreditsFetched = true
          await writeDb(db)
        }
        return
      }

      await fetchAndApplyCredits(item, settings.tmdbApiKey)
      item._v = Date.now()
      await writeDb(db)

      const newSuggestions = await getAutocompleteSuggestions()
      const plainItem = JSON.parse(JSON.stringify(item))
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send('library-item-updated', plainItem)
        window.webContents.send('autocomplete-suggestions-updated', newSuggestions)
      })
      log(`[Credits] Fetch complete for "${item.name}"`)
    } catch (err) {
      console.error(`[Credits] Background fetch for item ${itemId} failed:`, err)
    }
  })

  ipcMain.handle('play-file', async (_, file: MediaFile): Promise<boolean> => {
    const { playerCommand } = await readSettings()

    if (!db || !db.root || !playerCommand) {
      console.error('Cannot play file: database or player command not configured.')
      BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', {
        title: 'Configuration Error',
        message: 'Player command is not configured. Please set it in Settings.'
      })
      return false
    }

    // Mark as watched in the database
    const itemInDb = findItemById(file.id, db.root)
    if (itemInDb && itemInDb.type === 'file') {
      itemInDb.watched = true
      await writeDb(db) // Persist the change
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
        BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', {
          title: 'Player Error',
          message: 'Failed to launch the external player.',
          detail: `Please check your player command in Settings.\n\nCommand: ${command}\nError: ${error.message}`
        })
      }
    })

    return true // Indicate that the attempt to play was processed.
  })

  ipcMain.handle(
    'apply-initial-folder-settings',
    async (_, settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]) => {
      const focusedWindow = BrowserWindow.getFocusedWindow()
      if (!focusedWindow || !db || !db.root) return

      try {
        setBulkUpdateStatus(true)
        for (const setting of settings) {
          const item = findItemById(setting.id, db.root)
          if (item && item.type === 'folder') {
            item.retrieve_children_metadata = setting.retrieve
            item.children_type_hint = setting.hint
          }
        }
        setBulkUpdateStatus(false)
        await writeDb(db)
        console.log('Applied initial folder settings and saved to DB.')

        // Now trigger the metadata fetch
        const appSettings = await readSettings()
        fetchMetadataForLibrary(db, focusedWindow, appSettings.tmdbApiKey).catch((err) =>
          console.error('Background metadata fetch failed after applying initial settings:', err)
        )
      } catch (error) {
        console.error('Failed to apply initial folder settings:', error)
      }
    }
  )

  ipcMain.handle('clear-children-metadata', async (_, folderId: string): Promise<boolean> => {
    if (!db || !db.root) {
      console.error('Cannot clear metadata: database not found.')
      return false
    }
    const parentFolder = findItemById(folderId, db.root)
    if (!parentFolder || parentFolder.type !== 'folder') {
      console.error(`Cannot clear metadata: folder with ID ${folderId} not found.`)
      return false
    }

    log(`Starting metadata clear for children of "${parentFolder.name}"...`)
    setBulkUpdateStatus(true)

    try {
      const imagesDir = path.join(getLibraryDataPath(), 'images')
      const modifiedItems: LibraryItem[] = []
      await clearChildrenRecursively(parentFolder, imagesDir, modifiedItems)

      // Also reset the flag on the parent folder itself and bust its UI cache.
      parentFolder.tmdbEpisodesFetched = undefined
      parentFolder._v = Date.now()
      modifiedItems.push(parentFolder)

      await finalizeMetadataClear(modifiedItems)
      return true
    } catch (error) {
      console.error('Failed during metadata clearing process:', error)
      setBulkUpdateStatus(false) // Ensure this is always turned off
      return false
    }
  })

  ipcMain.handle(
    'clear-virtual-folder-metadata',
    async (_, itemIds: string[]): Promise<boolean> => {
      if (!db || !db.root) return false
      log(`Starting metadata clear for ${itemIds.length} items from virtual folder...`)
      setBulkUpdateStatus(true)

      try {
        const imagesDir = path.join(getLibraryDataPath(), 'images')
        const modifiedItems: LibraryItem[] = []

        for (const itemId of itemIds) {
          const item = findItemById(itemId, db.root)
          if (!item) {
            console.warn(`Could not find item ${itemId} to clear metadata.`)
            continue
          }

          await resetItemMetadata(item, imagesDir)
          modifiedItems.push(item)
          if (item.type === 'folder') {
            await clearChildrenRecursively(item, imagesDir, modifiedItems)
          }
        }

        await finalizeMetadataClear(modifiedItems)
        return true
      } catch (error) {
        console.error('Failed during virtual folder metadata clearing process:', error)
        setBulkUpdateStatus(false)
        return false
      }
    }
  )

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

  ipcMain.handle(
    'manual-search',
    async (_, query: string, type: 'movie' | 'tv' | 'season', year?: string, tmdbId?: string) => {
      const { tmdbApiKey } = await readSettings()
      if (!tmdbApiKey) {
        console.warn('Manual search skipped: No TMDB API key.')
        return []
      }
      return manualSearch(query, type, tmdbApiKey, year, tmdbId)
    }
  )

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
    async (event, itemId: string, result: any, mediaType: 'movie' | 'tv' | 'season') => {
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
      item.posterPath = undefined // Clear poster so it gets re-fetched
      item.tmdbDetailsFetched = undefined // Clear the details flag to force a refetch
      item.tmdbCreditsFetched = undefined // Clear the credits flag to force a refetch
      item.tmdbCredits = undefined // Clear old credits

      // --- Invalidate TV Show specific data ---
      // If we are applying a new TV match to a folder, we need to clear out any
      // old, incorrect season and episode data that might be cached on its children.
      if (item.type === 'folder' && mediaType === 'tv') {
        item.tmdbSeasons = undefined // Clear cached season list from TMDB
        item.tmdbEpisodesFetched = undefined // Allow re-processing of show structure
        for (const season of item.children) {
          if (season.type === 'folder' && season.mediaType === 'season') {
            // Reset the flag to allow lazy-loading to trigger again.
            season.tmdbDetailsFetched = false
            season.tmdbEpisodesFetched = undefined // Allow re-processing of season
            // Clear out the old, incorrect episode posters and bust their cache.
            for (const episode of season.children) {
              if (episode.type === 'file' && episode.mediaType === 'episode') {
                episode.posterPath = undefined
                episode._v = Date.now()
              }
            }
          }
        }
      }

      // Bust cache for the main item itself immediately after clearing old data.
      item._v = Date.now()

      // Handle a season result differently
      if (mediaType === 'season' && item.type === 'folder') {
        item.mediaType = 'season'
        item.title = result.name // Seasons have 'name'
        item.overview = result.overview
        item.seasonNumber = result.season_number

        if (result.poster_path) {
          const posterUrl = `https://image.tmdb.org/t/p/w500${result.poster_path}`
          const imagesDir = path.join(libraryDataPath, 'images')
          const posterFileName = `${item.id}.jpg`
          const posterDestPath = path.join(imagesDir, posterFileName)
          try {
            await downloadImage(posterUrl, posterDestPath)
            item.posterPath = posterFileName
          } catch (e) {
            console.error('Failed to download season poster', e)
          }
        }

        // For seasons, we don't set a tmdbId on the item itself.
        // Mark that this season's details are now "fetched" via this manual match.
        item.tmdbDetailsFetched = true
        // Explicitly mark that its episodes have NOT been fetched yet, so the next
        // step will trigger.
        item.tmdbEpisodesFetched = undefined

        // --- Local Episode Number Assignment ---
        // We must assign episode numbers to the files within this folder before we can
        // fetch and map TMDB data to them. This mirrors the logic from get-item-details.
        setBulkUpdateStatus(true)
        const episodeFiles = item.children.filter((c) => c.type === 'file') as MediaFile[]
        const parsedSuccessfully = processAndAssignEpisodeNumbers(episodeFiles, item.seasonNumber)

        if (!parsedSuccessfully) {
          log(
            `[Manual Match] High-confidence parsing failed for "${item.name}", falling back to alphabetical sort.`
          )
          episodeFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
          episodeFiles.forEach((file, index) => {
            file.episodeNumber = index + 1
            file.seasonNumber = item.seasonNumber
            file.mediaType = 'episode'
          })
        }
        setBulkUpdateStatus(false)
        // --- End Local Episode Number Assignment ---

        // Now, immediately try to fetch the episodes for this newly matched season.
        // This makes the manual match a single, cohesive operation.
        const showFolder = findParent(item.id, db!.root!)
        if (showFolder && showFolder.tmdbId && settings.tmdbApiKey) {
          console.log(`[Manual Match] Season matched. Now fetching episodes for "${item.name}"...`)
          // We need the parent show's details to get the list of seasons.
          if (!showFolder.tmdbDetailsFetched) {
            await fetchItemDetails(showFolder, settings, libraryDataPath)
          }

          if (showFolder.tmdbSeasons) {
            await fetchAndApplyEpisodeData(
              item,
              showFolder.tmdbId,
              settings.tmdbApiKey,
              libraryDataPath,
              showFolder.tmdbSeasons
            )
          }
        }
      } else {
        // --- Existing logic for Movie/TV Show ---
        item.tmdbId = result.id
        item.mediaType = mediaType
        item.title = result.title // Movies/Shows have 'title' or 'name' (handled by manualSearch)

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
      }

      // Re-evaluate virtual tags after all other properties have been updated.
      item.virtualTags = evaluateVirtualTagsForItem(item, settings)

      await writeDb(db)

      const window = BrowserWindow.fromWebContents(event.sender)
      window?.webContents.send('library-item-updated', JSON.parse(JSON.stringify(item)))
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
        const plainItem = JSON.parse(JSON.stringify(item))
        const window = BrowserWindow.fromWebContents(event.sender)
        window?.webContents.send('library-item-updated', plainItem)
      } catch (err) {
        console.error(`Failed to set image for ${itemId}:`, err)
        BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', {
          title: 'Image Error',
          message: 'Failed to set the selected image. See logs for more details.'
        })
      }
    }
  )

  ipcMain.handle(
    'remove-image',
    async (event, itemId: string, imageType: 'poster' | 'backdrop' | 'logo') => {
      if (!db || !db.root) return
      const item = findItemById(itemId, db.root)
      if (!item) return

      // Explicitly set the path to `null` to prevent future automatic fetching.
      // This is a user action to permanently remove an unwanted image.
      if (imageType === 'poster') item.posterPath = null
      else if (imageType === 'backdrop') item.backdropPath = null
      else if (imageType === 'logo') item.logoPath = null

      item._v = Date.now() // Bust cache
      await writeDb(db)
      const plainItem = JSON.parse(JSON.stringify(item))
      const window = BrowserWindow.fromWebContents(event.sender)
      window?.webContents.send('library-item-updated', plainItem)
    }
  )

  ipcMain.on('reveal-in-explorer', (_, itemPath: string) => {
    shell.showItemInFolder(itemPath)
  })

  ipcMain.handle('trash-item', async (_, itemPath: string): Promise<boolean> => {
    try {
      await shell.trashItem(itemPath)
      return true
    } catch (error) {
      console.error(`Failed to trash item at ${itemPath}:`, error)
      BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', {
        title: 'Deletion Error',
        message: 'Failed to move item to trash. Check file permissions or see logs for details.',
        detail: (error as Error).message
      })
      return false
    }
  })

  ipcMain.handle(
    'perform-search',
    async (_, query: { text: string; tags: { key: string; value: string }[] }) => {
      // Calls the lean, fast search function for the UI.
      return performSearch(query)
    }
  )

  ipcMain.handle('rename-item', async (_, oldPath: string, newName: string): Promise<boolean> => {
    const newPath = path.join(path.dirname(oldPath), newName)
    try {
      await fs.rename(oldPath, newPath)
      return true
    } catch (error) {
      console.error(`Failed to rename from ${oldPath} to ${newPath}:`, error)
      BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', {
        title: 'Rename Error',
        message: 'Failed to rename item. Check file permissions or see logs for details.',
        detail: (error as Error).message
      })
      return false
    }
  })

  ipcMain.handle('get-item-properties', async (_, itemPath: string) => {
    try {
      const stats = await fs.stat(itemPath)
      const baseProperties = {
        name: path.basename(itemPath),
        path: itemPath,
        type: stats.isDirectory() ? 'Folder' : ('File' as 'File' | 'Folder'),
        created: stats.birthtime.toISOString(),
        modified: stats.mtime.toISOString()
      }

      if (stats.isDirectory()) {
        const contentStats = await getDirectoryContentStats(itemPath)
        return {
          ...baseProperties,
          size: contentStats.totalSize,
          contains: { files: contentStats.fileCount, folders: contentStats.folderCount }
        }
      } else {
        return { ...baseProperties, size: stats.size }
      }
    } catch (error) {
      console.error(`Failed to get properties for ${itemPath}:`, error)
      return null
    }
  })

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

  ipcMain.handle('get-parent', async (_, itemId: string): Promise<MediaFolder | null> => {
    if (!db || !db.root) return null
    const parent = findParent(itemId, db.root)
    return parent ? JSON.parse(JSON.stringify(parent)) : null
  })

  ipcMain.handle('get-hidden-children', async (_, parentId: string): Promise<LibraryItem[]> => {
    if (!db || !db.root) return []
    const parent = findItemById(parentId, db.root)
    if (!parent || parent.type !== 'folder') return []

    const hiddenChildren = parent.children.filter((child) => child.isHidden)
    return JSON.parse(JSON.stringify(hiddenChildren)) // Return deep copy
  })
}
