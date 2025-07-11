import { dialog, ipcMain, BrowserWindow, shell } from 'electron'
import { exec } from 'child_process'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Main] ${message}`)
}
import path from 'path'
import fs, { readdir, stat } from 'fs/promises'
import { type Dirent } from 'fs'
import crypto from 'crypto'
import { evaluateVirtualTagsForItem } from './virtualTags'
import {
  createDbProxy,
  buildFullSearchIndex,
  updateIndexForItem,
  updateIndexForItems,
  performSearch,
  debugPerformSearch,
  removeItemAndDescendantsFromIndex
} from './search'
import type {
  Database,
  MediaFolder,
  LibraryItem,
  MediaFile,
  AutocompleteSuggestions,
  Settings
} from '../shared/types'
import { RESETTABLE_METADATA_KEYS } from '../shared/types'
import {
  cacheGenreLists,
  searchTmdbAndApplyMetadata,
  fetchItemDetails,
  fetchAndApplyCredits,
  applyTvShowData,
  refetchShowSeasons,
  fetchAndApplyEpisodeData,
  refetchPoster,
  manualSearch,
  getTmdbImages,
  downloadImage
} from './retriever'
import { readSettings, writeLibrarySettings } from './settings'
import { getLibraryDataPath } from './paths'

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

export async function loadDbIntoMemory(): Promise<void> {
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

async function getAbsoluteMediaSourcePath(): Promise<string | null> {
  const settings = await readSettings()
  if (!settings.mediaSourcePath) {
    return null
  }

  if (settings.mediaSourcePathIsRelative) {
    const libraryPath = getLibraryDataPath()
    // If library path is empty (should not happen if mediaSourcePath is set), return relative path as is.
    if (!libraryPath) return settings.mediaSourcePath
    return path.resolve(path.dirname(libraryPath), settings.mediaSourcePath)
  }

  return settings.mediaSourcePath
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

  // Persist the data. Paths are already relative, so no conversion needed.
  // JSON.stringify reads through proxies just fine.
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

/**
 * A centralized helper to finalize an item update. It saves the database,
 * broadcasts the changes to all renderer windows, and can optionally
 * update global autocomplete suggestions.
 * @param items The item or array of items that were updated.
 * @param options.updateSuggestions If true, regenerates and broadcasts autocomplete suggestions.
 */
async function _finalizeItemUpdate(
  items: LibraryItem | LibraryItem[],
  options: { updateSuggestions?: boolean } = {}
): Promise<void> {
  // 1. Persist all changes to the database
  if (!db) return
  await writeDb(db)

  const itemsArray = Array.isArray(items) ? items : [items]

  // 2. Broadcast the updated items to all renderer windows in a single batch.
  const plainItems = JSON.parse(JSON.stringify(itemsArray))
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('library-items-updated', plainItems)
  })

  // 3. Conditionally update and broadcast global data like suggestions.
  if (options.updateSuggestions) {
    const newSuggestions = await getAutocompleteSuggestions()
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send('autocomplete-suggestions-updated', newSuggestions)
    })
  }
  log(
    `[Library] Finalized update for ${itemsArray.length} item(s). Suggestions updated: ${!!options.updateSuggestions}`
  )
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

function findParent(id: string, node: MediaFolder): MediaFolder | null {
  if (!node || !node.children) return null
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

async function syncWithDisk(node: MediaFolder, mediaSourcePath: string): Promise<void> {
  const nodeAbsolutePath = path.join(mediaSourcePath, node.path)
  let diskChildEntries: Dirent[]

  try {
    await fs.access(nodeAbsolutePath)
    diskChildEntries = await fs.readdir(nodeAbsolutePath, { withFileTypes: true })

    // If an .ignore file exists, handle it based on user edits.
    if (diskChildEntries.some((entry) => entry.name === '.ignore' && entry.isFile())) {
      log(`Ignoring directory due to .ignore file: ${nodeAbsolutePath}`)

      if (node.isUserEdited) {
        // If user-edited, hide it but preserve it in the DB.
        const hideRecursively = (item: LibraryItem) => {
          item.isHidden = true
          item.isMissing = undefined // Ensure it's not marked as missing
          if (item.type === 'folder') {
            item.children.forEach(hideRecursively)
          }
        }
        hideRecursively(node)
      } else {
        // If not user-edited, treat it as missing so it gets pruned.
        node.isMissing = true
        const markAllChildrenMissing = (folder: MediaFolder) => {
          if (!folder.children) return
          folder.children.forEach((child) => {
            child.isMissing = true
            if (child.type === 'folder') markAllChildrenMissing(child)
          })
        }
        markAllChildrenMissing(node)
      }
      return // Stop processing this branch
    }

    // No .ignore file, proceed with normal sync.
    // Un-hide the node and its children if they were previously hidden by an .ignore file.
    if (node.isHidden) {
      const unhideRecursively = (item: LibraryItem) => {
        item.isHidden = undefined
        if (item.type === 'folder') {
          item.children.forEach(unhideRecursively)
        }
      }
      unhideRecursively(node)
    }
    node.isMissing = undefined
  } catch (e) {
    // Folder is genuinely missing from disk.
    node.isMissing = true
    const markAllChildrenMissing = (folder: MediaFolder) => {
      if (!folder.children) return
      folder.children.forEach((child) => {
        child.isMissing = true
        if (child.type === 'folder') markAllChildrenMissing(child)
      })
    }
    markAllChildrenMissing(node)
    return
  }

  const dbChildrenMap = new Map(node.children.map((child) => [child.name, child]))
  const diskChildrenNames = new Set(diskChildEntries.map((e) => e.name))

  // Add new items from disk to the DB node.
  for (const entry of diskChildEntries) {
    if (!dbChildrenMap.has(entry.name)) {
      const isVideoFile = entry.isFile() && /\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(entry.name)
      if (entry.isDirectory() || isVideoFile) {
        const childRelativePath = path.join(node.path, entry.name).replace(/\\/g, '/')
        const newChild: LibraryItem = {
          id: generateId(childRelativePath),
          name: entry.name,
          path: childRelativePath,
          type: entry.isDirectory() ? 'folder' : 'file',
          ...(entry.isDirectory() && { children: [] })
        } as any
        node.children.push(newChild)
      }
    }
  }

  // Sync all children (old and new).
  for (const child of node.children) {
    if (diskChildrenNames.has(child.name)) {
      child.isMissing = undefined
      if (child.type === 'folder') {
        await syncWithDisk(child, mediaSourcePath)
      }
    } else {
      child.isMissing = true
      if (child.type === 'folder') {
        const markDescendantsMissing = (folder: MediaFolder) => {
          if (!folder.children) return
          folder.children.forEach((c) => {
            c.isMissing = true
            if (c.type === 'folder') markDescendantsMissing(c)
          })
        }
        markDescendantsMissing(child)
      }
    }
  }
}

/**
 * Recursively removes items from the tree that are marked as `isMissing`
 * but have NOT been marked as `isUserEdited`.
 * @param node The folder to start pruning from.
 */
function pruneUntouchedMissingItems(node: MediaFolder) {
  if (!node.children) return

  // If the parent folder itself is missing, we do not prune its children.
  // This preserves the record of what it contained for the user to see.
  if (node.isMissing) {
    for (const child of node.children) {
      if (child.type === 'folder') {
        pruneUntouchedMissingItems(child)
      }
    }
    return
  }

  // The parent folder exists, so we can safely prune its missing children if they are not user-edited.
  node.children = node.children.filter((child) => {
    return !(child.isMissing && !child.isUserEdited)
  })

  // Recurse for the remaining children that are folders.
  for (const child of node.children) {
    if (child.type === 'folder') {
      pruneUntouchedMissingItems(child)
    }
  }
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
/**
 * Non-destructively assigns season/episode numbers to new files within a TV show folder.
 * This is used during automatic library refreshes.
 */
function processTvShowStructure(showFolder: MediaFolder): void {
  log(`[Sync] Analyzing TV structure for: "${showFolder.name}"`)

  const allSubFolders = showFolder.children.filter(
    (c) => c.type === 'folder' && !SPECIAL_FOLDER_NAMES_FOR_TV.includes(c.name.toLowerCase())
  ) as MediaFolder[]

  // Non-destructive file assignment helper
  const assignNewEpisodeNumbers = (files: MediaFile[], seasonNum: number) => {
    const unnumbered = files.filter((f) => typeof f.episodeNumber !== 'number')
    if (unnumbered.length === 0) return

    log(`[Sync] Found ${unnumbered.length} new episodes in Season ${seasonNum}.`)
    const maxExistingEpisode = Math.max(0, ...files.map((f) => f.episodeNumber ?? 0))
    unnumbered.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    unnumbered.forEach((file, i) => {
      file.episodeNumber = maxExistingEpisode + i + 1
      file.seasonNumber = seasonNum
      file.mediaType = 'episode'
    })
  }

  // Heuristic 1: "File Mode". If there are any files directly in the show folder.
  const immediateFiles = showFolder.children.filter((c) => c.type === 'file') as MediaFile[]
  if (immediateFiles.length > 0) {
    assignNewEpisodeNumbers(immediateFiles, 1)
    return // In file mode, we don't process subfolders as seasons.
  }

  // Heuristic 2: "Folder Mode". Process season subfolders.
  if (allSubFolders.length > 0) {
    const seasonPattern = /\b(?:Season\s*|S)(\d{1,2})\b/i
    const unnumberedFolders = allSubFolders.filter((f) => typeof f.seasonNumber !== 'number')

    // First, assign numbers to any folders that match a pattern like "S01".
    for (const folder of unnumberedFolders) {
      const match = folder.name.match(seasonPattern)
      if (match) {
        folder.seasonNumber = parseInt(match[1])
        folder.mediaType = 'season'
      }
    }

    // Then, for any folders *still* unnumbered, assign alphabetically after the highest existing number.
    const stillUnnumbered = allSubFolders.filter((f) => typeof f.seasonNumber !== 'number')
    if (stillUnnumbered.length > 0) {
      const maxExistingSeason = Math.max(0, ...allSubFolders.map((f) => f.seasonNumber ?? 0))
      stillUnnumbered.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      stillUnnumbered.forEach((folder, i) => {
        folder.seasonNumber = maxExistingSeason + i + 1
        folder.mediaType = 'season'
      })
    }

    // Finally, process the episodes inside every season folder.
    for (const seasonFolder of allSubFolders) {
      if (typeof seasonFolder.seasonNumber === 'number') {
        const episodeFiles = seasonFolder.children.filter((c) => c.type === 'file') as MediaFile[]
        assignNewEpisodeNumbers(episodeFiles, seasonFolder.seasonNumber)
      }
    }
  }
}

function assignEpisodesByStrategy(
  files: MediaFile[],
  seasonNumber: number,
  strategy: 'smart' | 'alphabetic'
) {
  if (strategy === 'alphabetic') {
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    files.forEach((file, index) => {
      file.seasonNumber = seasonNumber
      file.episodeNumber = index + 1
      file.mediaType = 'episode'
    })
    return
  }

  // smart strategy
  const parsedSuccessfully = processAndAssignEpisodeNumbers(files, seasonNumber)
  if (!parsedSuccessfully) {
    log(
      'TV Structure (Smart Fallback): High-confidence parsing failed, falling back to alphabetical.'
    )
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    files.forEach((file, index) => {
      file.seasonNumber = seasonNumber
      file.episodeNumber = index + 1
      file.mediaType = 'episode'
    })
  }
}

function assignSeasonsAndEpisodes(
  showFolder: MediaFolder,
  seasonStrategy: 'smart' | 'alphabetic',
  episodeStrategy: 'smart' | 'alphabetic'
) {
  const mediaFiles = showFolder.children.filter((c) => c.type === 'file') as MediaFile[]
  const subFolders = showFolder.children.filter(
    (c) => c.type === 'folder' && !SPECIAL_FOLDER_NAMES_FOR_TV.includes(c.name.toLowerCase())
  ) as MediaFolder[]

  const assignEpisodeFunc = (files: MediaFile[], season: number) =>
    assignEpisodesByStrategy(files, season, episodeStrategy)

  if (mediaFiles.length > 0) {
    assignEpisodeFunc(mediaFiles, 1)
    return
  }

  if (subFolders.length > 0) {
    if (seasonStrategy === 'smart') {
      const seasonPattern = /\b(?:Season\s*|S)(\d{1,2})\b/i
      const parsedFolders: { folder: MediaFolder; season: number }[] = []

      for (const folder of subFolders) {
        const seasonMatch = folder.name.match(seasonPattern)
        if (seasonMatch) {
          parsedFolders.push({ folder, season: parseInt(seasonMatch[1]) })
        }
      }

      if (parsedFolders.length > 0) {
        for (const { folder, season } of parsedFolders) {
          folder.seasonNumber = season
          folder.mediaType = 'season'
          const episodeFiles = folder.children.filter((c) => c.type === 'file') as MediaFile[]
          assignEpisodeFunc(episodeFiles, season)
        }
        return // Smart season assignment succeeded
      }
    }

    // Fallback for smart or explicit alphabetic
    subFolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    subFolders.forEach((folder, index) => {
      const season = index + 1
      folder.seasonNumber = season
      folder.mediaType = 'season'
      const episodeFiles = folder.children.filter((c) => c.type === 'file') as MediaFile[]
      assignEpisodeFunc(episodeFiles, season)
    })
  }
}

async function clearTvStructureMetadata(
  folder: MediaFolder,
  imagesDir: string,
  modifiedItems: Set<LibraryItem>
): Promise<void> {
  for (const child of folder.children) {
    let wasModified = false // Reset properties for this child

    if (child.posterPath) {
      try {
        await fs.unlink(path.join(imagesDir, child.posterPath))
      } catch (e) {
        /* ignore if file not found */
      }
      child.posterPath = undefined
      wasModified = true
    }

    if (child.title) {
      child.title = undefined
      wasModified = true
    }
    if (child.overview) {
      child.overview = undefined
      wasModified = true
    }
    if (child.mediaType === 'season' || child.mediaType === 'episode') {
      child.mediaType = undefined
      wasModified = true
    }
    if ('seasonNumber' in child && child.seasonNumber !== undefined) {
      child.seasonNumber = undefined
      wasModified = true
    }
    if ('episodeNumber' in child && child.episodeNumber !== undefined) {
      child.episodeNumber = undefined
      wasModified = true
    } // Reset cache flags to allow re-fetching

    if ('tmdbDetailsFetched' in child && child.tmdbDetailsFetched) {
      child.tmdbDetailsFetched = false
      wasModified = true
    }
    if ('tmdbEpisodesFetched' in child && child.tmdbEpisodesFetched) {
      child.tmdbEpisodesFetched = false
      wasModified = true
    }
    if ('tmdbEpisodes' in child && child.tmdbEpisodes) {
      child.tmdbEpisodes = undefined
      wasModified = true
    }

    if (wasModified) {
      modifiedItems.add(child)
    }

    if (child.type === 'folder') {
      await clearTvStructureMetadata(child, imagesDir, modifiedItems)
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

  // Check if an .ignore file exists in the directory.
  if (entries.some((entry) => entry.name === '.ignore' && entry.isFile())) {
    log(`Ignoring directory due to .ignore file: ${dirPath}`)
    return null
  }

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    const entryRelativePath = path.relative(rootPath, entryPath).replace(/\\/g, '/')

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
          path: entryRelativePath,
          type: 'file'
        })
      }
    }
  }

  // If there are no children (no video files or non-empty subfolders), return null.
  if (children.length === 0) {
    return null
  }

  const relativePath = path.relative(rootPath, dirPath).replace(/\\/g, '/')
  const folder: MediaFolder = {
    id: generateId(relativePath || '.'), // Use dot for root itself
    name: name || path.basename(rootPath), // Use root basename if name is empty
    path: relativePath || '.', // Store relative path, using '.' for the root itself
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

// Recursively collects items for processing.
function collectItemsToProcess(
  folder: MediaFolder,
  newItems: { item: LibraryItem; hint?: 'movie' | 'tv' }[],
  itemsMissingPosters: LibraryItem[],
  itemsMissingCredits: LibraryItem[],
  tvShows: MediaFolder[]
) {
  if (folder.isHidden || folder.isMissing) {
    return
  }

  // Collect the TV show itself for local analysis, regardless of flags.
  if (folder.mediaType === 'tv') {
    tvShows.push(folder)
  }

  // Process children of the current folder if the flag is set.
  if (folder.retrieve_children_metadata) {
    for (const child of folder.children) {
      if (child.isHidden || child.isMissing) {
        continue
      }
      if (typeof child.tmdbId === 'undefined') {
        newItems.push({ item: child, hint: folder.children_type_hint })
      } else if (child.tmdbId) {
        if (!child.posterPath) {
          itemsMissingPosters.push(child)
        }
        if (
          !child.tmdbCreditsFetched &&
          (child.mediaType === 'movie' || child.mediaType === 'tv')
        ) {
          itemsMissingCredits.push(child)
        }
      }
    }
  }

  // Recurse into subfolders to check their flags.
  for (const child of folder.children) {
    if (child.type === 'folder') {
      collectItemsToProcess(child, newItems, itemsMissingPosters, itemsMissingCredits, tvShows)
    }
  }
}

async function getAutocompleteSuggestions(): Promise<AutocompleteSuggestions> {
  if (!db || !db.root) {
    return {
      mediaTypes: [],
      genres: [],
      persons: [],
      tagKeys: [],
      virtualTagKeys: [],
      tagValues: {}
    }
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

async function fetchMetadataForLibrary(
  db: Database,
  window: BrowserWindow,
  settings: Settings | null
) {
  const libraryDataPath = getLibraryDataPath()
  if (!settings || !settings.tmdbApiKey || !db.root) {
    console.warn('Metadata fetch skipped: No settings, API key or library root.')
    return
  }
  const tmdbApiKey = settings.tmdbApiKey

  const newItemsToFetch: { item: LibraryItem; hint?: 'movie' | 'tv' }[] = []
  const itemsMissingPosters: LibraryItem[] = []
  const itemsMissingCredits: LibraryItem[] = []
  const allTvShows: MediaFolder[] = []

  // A single pass to collect everything needed for all subsequent steps.
  collectItemsToProcess(
    db.root,
    newItemsToFetch,
    itemsMissingPosters,
    itemsMissingCredits,
    allTvShows
  )

  // --- Phase 1: Local Analysis ---
  // This phase runs before any network calls. It analyzes the local file structure
  // for TV shows to assign season/episode numbers to new files and to detect if
  // a full metadata refresh for a show or season is necessary.

  if (allTvShows.length > 0) {
    console.log(`[Metadata] Performing local analysis for ${allTvShows.length} TV shows.`)
    for (const show of allTvShows) {
      // 1. Re-analyze folder structure. This is now non-destructive and only
      // assigns numbers to newly added files/folders.
      processTvShowStructure(show)

      // 2. Check if a season metadata refresh is needed. This happens if a local season
      //    exists that isn't represented in the cached TMDB season data.
      if (show.tmdbSeasons && show.tmdbDetailsFetched) {
        const localSeasonNumbers = new Set<number>()
        show.children.forEach((child) => {
          if ('seasonNumber' in child && typeof child.seasonNumber === 'number') {
            localSeasonNumbers.add(child.seasonNumber)
          }
        })

        // No local seasons to check against, so nothing to do here.
        if (localSeasonNumbers.size > 0) {
          const cachedSeasonNumbers = new Set(show.tmdbSeasons.map((s) => s.season_number))

          let needsRefetch = false
          for (const localNum of localSeasonNumbers) {
            if (!cachedSeasonNumbers.has(localNum)) {
              needsRefetch = true
              break
            }
          }

          // Also check for unprocessed seasons as a fallback (e.g., if a previous refetch failed).
          const hasUnprocessedSeason = show.children.some(
            (c) =>
              c.type === 'folder' &&
              c.mediaType === 'season' &&
              c.seasonNumber != null &&
              !c.title
          )

          if (needsRefetch || hasUnprocessedSeason) {
            console.log(
              `[Metadata] New or unprocessed seasons detected for "${show.name}". Fetching updated season list.`
            )
            await refetchShowSeasons(show, settings, libraryDataPath)
          }
        }
      }

      // 3. For each season, invalidate episode cache if new episodes are detected.
      const seasonFolders = show.children.filter(
        (c) => c.type === 'folder' && c.mediaType === 'season'
      ) as MediaFolder[]

      for (const season of seasonFolders) {
        if (season.tmdbEpisodes && season.tmdbEpisodesFetched) {
          const localEpisodes = season.children.filter((c) => c.type === 'file') as MediaFile[]
          const maxLocalEpisode = Math.max(0, ...localEpisodes.map((e) => e.episodeNumber ?? 0))
          const maxCachedEpisode = Math.max(0, ...season.tmdbEpisodes.map((e) => e.episode_number))

          if (
            maxLocalEpisode > maxCachedEpisode &&
            maxLocalEpisode > (season._lastSeenLocalMaxEpisode ?? 0)
          ) {
            console.log(
              `[Metadata] New episode for "${show.name} S${season.seasonNumber}" (new local max: ${maxLocalEpisode}, last: ${season._lastSeenLocalMaxEpisode}). Invalidating episode cache.`
            )
            season.tmdbEpisodesFetched = false // This will trigger an on-demand refetch.
          }
          // Always update the last seen max episode, so we don't re-trigger for the same number.
          season._lastSeenLocalMaxEpisode = maxLocalEpisode
        }
      }
    }
  }

  // --- Phase 2: Network Fetching ---
  if (
    newItemsToFetch.length === 0 &&
    itemsMissingPosters.length === 0 &&
    itemsMissingCredits.length === 0
  ) {
    console.log(
      '[Metadata] No new items, missing posters, or missing credits to fetch based on folder settings.'
    )
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
      await searchTmdbAndApplyMetadata(item, tmdbApiKey, libraryDataPath, hint)
      if (item.type === 'folder' && item.mediaType === 'tv') {
        processTvShowStructure(item as MediaFolder)
      }
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

  // Fetch credits for existing items that are missing them.
  if (itemsMissingCredits.length > 0) {
    console.log(`[Metadata] Starting credits fetch for ${itemsMissingCredits.length} items...`)
    const updatedItemsBatch: LibraryItem[] = []
    const task = async (item: LibraryItem): Promise<void> => {
      await fetchAndApplyCredits(item, tmdbApiKey)
      // We push to the batch if tmdbCreditsFetched is now true.
      if (item.tmdbCreditsFetched) {
        updatedItemsBatch.push(item)
      }
    }
    await processInChunks(itemsMissingCredits, 17, task)
    sendBatchUpdate(updatedItemsBatch)
  }

  await writeDb(db)
  console.log('[Metadata] Finished all fetching and saved final DB.')

  // After all items are processed, regenerate suggestions which now include new people/genres.
  const newSuggestions = await getAutocompleteSuggestions()
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('autocomplete-suggestions-updated', newSuggestions)
  })
  console.log('[Metadata] Autocomplete suggestions have been updated and broadcasted.')
}

// This helper will be called from get-continue-watching handlers.
// It will do the fetch, and then call _finalizeItemUpdate to persist and notify.
// This is an inline, awaited fetch, not fire-and-forget.
async function fetchEpisodeDataForContinueWatching(show: MediaFolder, episode: MediaFile) {
  if (episode.title && episode.posterPath) {
    return // Already has data
  }
  if (!show.tmdbId || !show.tmdbSeasons || !db) {
    return
  }

  const seasonFolder = show.children.find(
    (c) => c.type === 'folder' && c.seasonNumber === episode.seasonNumber
  ) as MediaFolder | undefined

  let itemsToUpdate: LibraryItem[] = []

  const wasBulkUpdating = getBulkUpdateStatus()
  setBulkUpdateStatus(true)
  try {
    const settings = await readSettings()
    if (!settings.tmdbApiKey) return

    if (seasonFolder) {
      // Standard case: season is a subfolder
      if (!seasonFolder.tmdbEpisodesFetched) {
        log(
          `[Continue Watching] Next episode "${episode.name}" is in an unfetched season. Fetching S${seasonFolder.seasonNumber}...`
        )
        const modifiedEpisodes = await fetchAndApplyEpisodeData(
          seasonFolder,
          show.tmdbId,
          settings.tmdbApiKey,
          getLibraryDataPath(),
          show.tmdbSeasons
        )
        itemsToUpdate = [seasonFolder, ...modifiedEpisodes]
      }
    } else {
      // File Mode case: episodes are loose in the show folder
      if (!show.tmdbEpisodesFetched) {
        log(
          `[Continue Watching] Next episode "${episode.name}" is a loose file in an unfetched show. Fetching all loose episodes...`
        )
        const modifiedEpisodes = await applyTvShowData(show, settings, getLibraryDataPath())
        itemsToUpdate = [show, ...modifiedEpisodes]
      }
    }
  } catch (err) {
    console.error('[Continue Watching] Failed to fetch data:', err)
  } finally {
    setBulkUpdateStatus(wasBulkUpdating)
  }

  if (itemsToUpdate.length > 0) {
    // We have mutated items in the DB, now we need to save and broadcast.
    // We only update suggestions if we fetched a whole show's worth of episodes.
    const updateSuggestions = !seasonFolder
    await _finalizeItemUpdate(itemsToUpdate, { updateSuggestions })
  }
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

  // Loop through the centrally-defined list of resettable keys and set them to a value
  // that will be propagated over IPC (i.e. not `undefined`).
  // We cast `item` to `any` here to allow dynamic key assignment.
  for (const key of RESETTABLE_METADATA_KEYS) {
    // Only attempt to delete the key if it exists on the item. This prevents
    // us from adding properties to an object that shouldn't have them (e.g. `episodeNumber` on a folder).
    if (key in item) {
      const itemAsAny = item as any
      switch (key) {
        case 'tags':
          itemAsAny[key] = {}
          break
        case 'genres':
          itemAsAny[key] = []
          break
        case 'tmdbDetailsFetched':
        case 'tmdbEpisodesFetched':
        case 'tmdbCreditsFetched':
          itemAsAny[key] = false
          break
        case 'virtualTags':
          // This one is special, it gets re-evaluated later anyway.
          itemAsAny[key] = undefined
          break
        case 'posterPath':
        case 'backdropPath':
        case 'logoPath':
          // Set to undefined to trigger re-fetch, null means "user explicitly removed".
          // We already unlinked the files, so a re-fetch is desired.
          itemAsAny[key] = undefined
          break
        default:
          // All other properties (title, overview, year, tmdbId, tmdbCredits, tmdbSeasons etc.) can be safely set to null.
          itemAsAny[key] = null
          break
      }
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

/**
 * A helper to mark an item and its ancestors as user-edited.
 * This protects them from being pruned if they go missing from the filesystem.
 * Only "valuable" user edit channels should call this channel.
 * Some user actions like play-file (which sets watched state) are user actions that result in the
 * db getting modified, but are on their own not sufficiently "valuable" to prevent pruning.
 * Any "valuable" user edit calling this should have a channel name prefixed with user-, like user-update-item
 * and user-set-image.
 */
function markAsUserEdited(itemId: string, dbRoot: MediaFolder | null) {
  if (!dbRoot) return
  const item = findItemById(itemId, dbRoot)
  if (item) {
    item.isUserEdited = true
    let parent = findParent(item.id, dbRoot)
    while (parent) {
      parent.isUserEdited = true
      parent = findParent(parent.id, dbRoot)
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

  log(`Finished metadata clear for ${modifiedItems.length} items.`)
  // Use the centralized helper to save, notify, and update suggestions.
  // Clearing metadata definitely warrants an update to suggestions.
  await _finalizeItemUpdate(modifiedItems, { updateSuggestions: true })
}

function getFolderWatchedState(folder: MediaFolder): 'fully' | 'partially' | 'unwatched' | 'none' {
  let hasWatched = false
  let hasUnwatched = false
  let hasFiles = false

  function traverse(item: LibraryItem) {
    if (hasWatched && hasUnwatched) return // Optimization

    if (item.type === 'file') {
      hasFiles = true
      if (item.watched) {
        hasWatched = true
      } else {
        hasUnwatched = true
      }
    } else if (item.type === 'folder' && item.children) {
      for (const child of item.children) {
        traverse(child)
      }
    }
  }

  traverse(folder)

  if (!hasFiles) return 'none'
  if (hasWatched && hasUnwatched) return 'partially'
  if (hasWatched) return 'fully'
  return 'unwatched'
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
    const settings = await readSettings()
    return settings.mediaSourcePath ?? null
  })

  ipcMain.handle('refresh-library', async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    if (!focusedWindow) return null
    const mediaSourcePath = await getAbsoluteMediaSourcePath()

    if (!db || !db.root || !mediaSourcePath) {
      log('Cannot refresh, no library configured.')
      BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', {
        title: 'Refresh Failed',
        message: 'Cannot refresh the library.',
        detail:
          'The library database or media source path has not been configured yet. Please set it up in Settings.'
      })
      return null
    }

    const refreshId = crypto.randomBytes(4).toString('hex')
    log(`[Refresh ${refreshId}] Starting refresh from: ${mediaSourcePath}`)
    const t0 = performance.now()

    try {
      try {
        await fs.access(mediaSourcePath)
      } catch (e) {
        log(`Media source path not found: ${mediaSourcePath}`)
        BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', {
          title: 'Refresh Failed',
          message: 'The configured media source path could not be found.',
          detail: `Path: ${mediaSourcePath}`
        })
        return db?.root ? createShallowClonableCopy(db.root) : null // Return current state without changing anything
      }

      setBulkUpdateStatus(true)

      // Start the recursive sync process. This modifies the existing `db.root` in place.
      await syncWithDisk(db.root, mediaSourcePath)
      const t1 = performance.now()
      log(`[Refresh ${refreshId}] syncWithDisk took ${(t1 - t0).toFixed(2)}ms`)

      // After syncing, prune items that are missing and have not been manually edited.
      pruneUntouchedMissingItems(db.root)
      const t2 = performance.now()
      log(`[Refresh ${refreshId}] pruneUntouchedMissingItems took ${(t2 - t1).toFixed(2)}ms`)

      const imagesDir = path.join(getLibraryDataPath(), 'images')
      await verifyImagePaths(db.root, imagesDir)
      const t3 = performance.now()
      log(`[Refresh ${refreshId}] verifyImagePaths took ${(t3 - t2).toFixed(2)}ms`)

      const currentSettings = await readSettings()
      applyVirtualTagsToAllItems(db.root, currentSettings)
      const t4 = performance.now()
      log(`[Refresh ${refreshId}] applyVirtualTagsToAllItems took ${(t4 - t3).toFixed(2)}ms`)

      buildFullSearchIndex(db.root)
      const t5 = performance.now()
      log(`[Refresh ${refreshId}] buildFullSearchIndex took ${(t5 - t4).toFixed(2)}ms`)

      setBulkUpdateStatus(false) // Re-enable single-item updates from here

      await writeDb(db)
      const t6 = performance.now()
      log(`[Refresh ${refreshId}] writeDb took ${(t6 - t5).toFixed(2)}ms`)
      log(`[Refresh ${refreshId}] Library refresh and sync complete.`)

      const settings = await readSettings()
      fetchMetadataForLibrary(db, focusedWindow, settings).catch((err) =>
        console.error('Background metadata fetch failed during refresh:', err)
      )
      const t7 = performance.now()
      log(`[Refresh ${refreshId}] Total time before returning: ${(t7 - t0).toFixed(2)}ms`)

      const memoryUsage = process.memoryUsage()
      log(
        `[Refresh ${refreshId}] Memory: RSS=${(memoryUsage.rss / 1024 / 1024).toFixed(2)}MB, HeapTotal=${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)}MB, HeapUsed=${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`
      )

      return db.root ? createShallowClonableCopy(db.root) : null
    } catch (error) {
      console.error('Failed to refresh library:', error)
      setBulkUpdateStatus(false) // Ensure bulk status is reset on error
      return db?.root ? JSON.parse(JSON.stringify(db.root)) : null
    }
  })

  ipcMain.handle('perform-initial-scan', async () => {
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
      // 1. Save the new media source path to settings. This is now the source of truth.
      const settings = await readSettings()
      let pathToSave = mediaSourcePath
      if (settings.mediaSourcePathIsRelative) {
        const libraryPath = getLibraryDataPath()
        let relativePath = path.relative(path.dirname(libraryPath), mediaSourcePath)
        relativePath = relativePath.replace(/\\/g, '/')

        if (relativePath === '') {
          pathToSave = '.'
        } else if (relativePath.startsWith('../')) {
          pathToSave = relativePath
        } else {
          pathToSave = './' + relativePath
        }
      }
      await writeLibrarySettings({ mediaSourcePath: pathToSave })

      // 2. Scan directory structure. This returns a tree with relative paths, which is what we want now.
      const rootNode = await scanDirectory(mediaSourcePath, mediaSourcePath)

      setBulkUpdateStatus(true)
      const newDb: Database = {
        version: DB_VERSION,
        root: rootNode
      }

      // 3. Apply virtual tags before creating the proxy.
      if (rootNode) {
        applyVirtualTagsToAllItems(rootNode, settings)
      }
      setBulkUpdateStatus(false) // Turn off before metadata fetch starts.

      // 4. This will create the proxy, update the global `db` (with absolute paths),
      // build the search index, and write to disk (with relative paths).
      await writeDb(newDb)
      console.log('Initial scan, DB write, and index build complete.')

      // 5. Do NOT start background metadata fetching. The renderer will prompt the user
      // and trigger it via a separate IPC call.

      // 6. Return a DEEP, de-proxied copy of the root for the initial settings modal.
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

  ipcMain.handle('perform-full-rescan', async (_, mediaSourcePath: string) => {
    if (!mediaSourcePath) {
      console.error('Full rescan called without a mediaSourcePath.')
      return null
    }

    console.log(`Starting full rescan of: ${mediaSourcePath}`)

    try {
      const settings = await readSettings()
      let pathToSave = mediaSourcePath
      if (settings.mediaSourcePathIsRelative) {
        const libraryPath = getLibraryDataPath()
        let relativePath = path.relative(path.dirname(libraryPath), mediaSourcePath)
        relativePath = relativePath.replace(/\\/g, '/')
        if (relativePath === '') {
          pathToSave = '.'
        } else if (relativePath.startsWith('../')) {
          pathToSave = relativePath
        } else {
          pathToSave = './' + relativePath
        }
      }
      await writeLibrarySettings({ mediaSourcePath: pathToSave })

      const rootNode = await scanDirectory(mediaSourcePath, mediaSourcePath)

      setBulkUpdateStatus(true)
      const newDb: Database = {
        version: DB_VERSION,
        root: rootNode
      }

      if (rootNode) {
        applyVirtualTagsToAllItems(rootNode, settings)
      }
      setBulkUpdateStatus(false)

      await writeDb(newDb)
      console.log('Full rescan, DB write, and index build complete.')

      if (db!.root) {
        const deepCopy = JSON.parse(JSON.stringify(db!.root))
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
      console.error('Failed to perform full rescan:', error)
      return null
    }
  })

  ipcMain.handle('save-media-source-path', async (_, newPath: string) => {
    const settings = await readSettings()
    let pathToSave = newPath
    if (settings.mediaSourcePathIsRelative) {
      const libraryPath = getLibraryDataPath()
      let relativePath = path.relative(path.dirname(libraryPath), newPath)
      relativePath = relativePath.replace(/\\/g, '/')
      if (relativePath === '') {
        pathToSave = '.'
      } else if (relativePath.startsWith('../')) {
        pathToSave = relativePath
      } else {
        pathToSave = './' + relativePath
      }
    }
    await writeLibrarySettings({ mediaSourcePath: pathToSave })
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

    // --- Local TV structure analysis is now handled by the main library refresh ---

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
        const allModifiedItems: LibraryItem[] = []
        try {
          const settings = await readSettings()
          if (!settings.tmdbApiKey) return

          // --- Case 1: The item's own details are missing. Fetch them. ---
          if (needsDetailsFetch) {
            log(`[Details] Item details missing. Starting full fetch for "${item.name}"`)
            const modified = await fetchItemDetails(item, settings, getLibraryDataPath())
            allModifiedItems.push(...modified)
          }
          // --- Case 2: The item's details are present, but its children's are not. ---
          else if (needsEpisodeFetch && item.type === 'folder') {
            if (item.mediaType === 'season') {
              const showFolder = findParent(item.id, db!.root!)
              if (showFolder && showFolder.tmdbId && showFolder.process_tv_children !== false) {
                if (!showFolder.tmdbDetailsFetched) {
                  log(
                    `[Details] Parent show "${showFolder.name}" details missing, fetching them first.`
                  )
                  const modifiedParent = await fetchItemDetails(
                    showFolder,
                    settings,
                    getLibraryDataPath()
                  )
                  allModifiedItems.push(...modifiedParent)
                }

                if (showFolder.tmdbSeasons) {
                  log(`[Details] Season episodes missing. Fetching for "${item.name}"`)
                  const modifiedEpisodes = await fetchAndApplyEpisodeData(
                    item,
                    showFolder.tmdbId,
                    settings.tmdbApiKey,
                    getLibraryDataPath(),
                    showFolder.tmdbSeasons
                  )
                  allModifiedItems.push(item, ...modifiedEpisodes)
                } else {
                  item.tmdbEpisodesFetched = true
                  log(
                    `[Details] Could not fetch episodes for season "${item.name}" (parent has no season data). Marked as processed to prevent loops.`
                  )
                }
              } else {
                item.tmdbEpisodesFetched = true
                log(
                  `[Details] Could not fetch episodes for season "${item.name}" (preconditions not met). Marked as processed to prevent loops.`
                )
              }
            } else if (item.mediaType === 'tv') {
              log(`[Details] TV show episode data missing. Processing children for "${item.name}"`)
              const modifiedChildren = await applyTvShowData(item, settings, getLibraryDataPath())
              allModifiedItems.push(item, ...modifiedChildren)
            }
          }

          item._v = Date.now() // Bust UI cache
        } catch (err) {
          // Catch errors within the fire-and-forget block to prevent unhandled rejections.
          console.error(`[Details] Background fetch for item ${itemId} failed:`, err)
        } finally {
          setBulkUpdateStatus(false) // Ensure bulk mode is always turned off.

          const uniqueItems = [...new Map(allModifiedItems.map((it) => [it.id, it])).values()]
          const itemsToUpdate = uniqueItems.length > 0 ? uniqueItems : [item]

          for (const modifiedItem of itemsToUpdate) {
            updateIndexForItem(modifiedItem)
          }

          // Use the centralized helper. Fetching details can update genres, so update suggestions.
          await _finalizeItemUpdate(itemsToUpdate, { updateSuggestions: true })

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

      // Use the centralized helper to save, notify, and update suggestions.
      await _finalizeItemUpdate(item, { updateSuggestions: true })

      log(`[Credits] Fetch complete for "${item.name}"`)
    } catch (err) {
      console.error(`[Credits] Background fetch for item ${itemId} failed:`, err)
    }
  })

  ipcMain.handle(
    'play-file-with',
    async (_, file: MediaFile, command: string): Promise<boolean> => {
      if (!command) {
        console.error('Cannot play file: no command provided.')
        return false
      }

      const mediaSourcePath = await getAbsoluteMediaSourcePath()
      if (!mediaSourcePath) {
        console.error('Cannot play file: media source path is not configured.')
        BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', {
          title: 'Configuration Error',
          message: 'Media source path is not configured. Please check your library settings.'
        })
        return false
      }

      const absolutePath = path.join(mediaSourcePath, file.path)
      const commandToExecute = command.replace('{PATH}', `${absolutePath}`)

      console.log(`Executing: ${commandToExecute}`)
      exec(commandToExecute, (error) => {
        if (error) {
          console.error(`Failed to execute player command: ${error.message}`)
          BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', {
            title: 'Player Error',
            message: 'Failed to launch the external player.',
            detail: `Please check your player command in Settings.\n\nCommand: ${commandToExecute}\nError: ${error.message}`
          })
        }
      })

      // Fire-and-forget the update logic.
      ;(async () => {
        if (!db || !db.root) {
          console.warn('DB not ready, cannot mark item as watched.')
          return
        }

        const itemInDb = findItemById(file.id, db.root)
        if (itemInDb && itemInDb.type === 'file') {
          itemInDb.watched = true
          ;(itemInDb as MediaFile).lastWatched = Date.now()
        // if playing an episode, un-dismiss the show
        let parent = findParent(itemInDb.id, db.root)
        let show: MediaFolder | null = null
        while (parent) {
          if (parent.mediaType === 'tv') {
            show = parent
            break
          }
          parent = findParent(parent.id, db.root)
        }
        if (show) {
          if (show.continueWatchingDismissed) {
            show.continueWatchingDismissed = false
          }
          if (show.nextUpDismissed) {
            show.nextUpDismissed = false
          }
        }
        await _finalizeItemUpdate(itemInDb)
        } else {
          console.warn(`Could not find item with id ${file.id} in DB to mark as watched.`)
        }
      })()

      return true // Indicate that the attempt to play was processed.
    }
  )

  ipcMain.handle('play-file', async (_, file: MediaFile): Promise<boolean> => {
    // --- Phase 1: Launch Player ASAP ---
    const { playerCommands } = await readSettings()

    if (!playerCommands || playerCommands.length === 0 || !playerCommands[0].command) {
      console.error('Cannot play file: no player commands configured or default command is empty.')
      BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', {
        title: 'Configuration Error',
        message: 'Player command is not configured. Please set it in Settings.'
      })
      return false
    }

    const mediaSourcePath = await getAbsoluteMediaSourcePath()
    if (!mediaSourcePath) {
      console.error('Cannot play file: media source path is not configured.')
      BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', {
        title: 'Configuration Error',
        message: 'Media source path is not configured. Please check your library settings.'
      })
      return false
    }

    const absolutePath = path.join(mediaSourcePath, file.path)
    // Use the first player command as the default
    const commandToExecute = playerCommands[0].command.replace('{PATH}', `${absolutePath}`)

    console.log(`Executing: ${commandToExecute}`)
    exec(commandToExecute, (error) => {
      if (error) {
        console.error(`Failed to execute player command: ${error.message}`)
        BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', {
          title: 'Player Error',
          message: 'Failed to launch the external player.',
          detail: `Please check your player command in Settings.\n\nCommand: ${commandToExecute}\nError: ${error.message}`
        })
      }
    })
    // --- Phase 2: Update Database in Background ---
    // Fire-and-forget the update logic.
    ;(async () => {
      if (!db || !db.root) {
        console.warn('DB not ready, cannot mark item as watched.')
        return
      }

      const itemInDb = findItemById(file.id, db.root)
      if (itemInDb && itemInDb.type === 'file') {
        itemInDb.watched = true
        ;(itemInDb as MediaFile).lastWatched = Date.now()
        // if playing an episode, un-dismiss the show
        let parent = findParent(itemInDb.id, db.root)
        let show: MediaFolder | null = null
        while (parent) {
          if (parent.mediaType === 'tv') {
            show = parent
            break
          }
          parent = findParent(parent.id, db.root)
        }
        if (show) {
          if (show.continueWatchingDismissed) {
            show.continueWatchingDismissed = false
          }
          if (show.nextUpDismissed) {
            show.nextUpDismissed = false
          }
        }
        await _finalizeItemUpdate(itemInDb)
      } else {
        console.warn(`Could not find item with id ${file.id} in DB to mark as watched.`)
      }
    })()

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
        fetchMetadataForLibrary(db, focusedWindow, appSettings).catch((err) =>
          console.error('Background metadata fetch failed after applying initial settings:', err)
        )
      } catch (error) {
        console.error('Failed to apply initial folder settings:', error)
      }
    }
  )

  ipcMain.handle('clear-item-metadata', async (_, itemId: string): Promise<boolean> => {
    if (!db || !db.root) {
      console.error('Cannot clear metadata: database not found.')
      return false
    }
    const item = findItemById(itemId, db.root)
    if (!item) {
      console.error(`Cannot clear metadata: item with ID ${itemId} not found.`)
      return false
    }

    log(`Starting metadata clear for item "${item.name}" and its children (if any)...`)
    setBulkUpdateStatus(true)

    try {
      const imagesDir = path.join(getLibraryDataPath(), 'images')
      const modifiedItems: LibraryItem[] = []

      // Reset the item itself
      await resetItemMetadata(item, imagesDir)
      modifiedItems.push(item)

      // If it's a folder, reset its children recursively
      if (item.type === 'folder') {
        await clearChildrenRecursively(item, imagesDir, modifiedItems)
      }

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

  async function _updateItem(updatedItem: LibraryItem): Promise<void> {
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

      // Use the centralized helper to save, notify, and update suggestions.
      await _finalizeItemUpdate(itemInDb, { updateSuggestions: true })

      console.log(`Updated item ${updatedItem.id} in database.`)
    } else {
      console.error(`Could not find item with id ${updatedItem.id} in DB to update.`)
    }
  }

  ipcMain.handle('user-update-item', async (_, updatedItem: LibraryItem): Promise<void> => {
    if (!db?.root) return
    log(
      `Marking item as user-edited: "${updatedItem.title ?? updatedItem.name}" (ID: ${updatedItem.id})`
    )
    markAsUserEdited(updatedItem.id, db.root)
    await _updateItem(updatedItem)
  })

  // handle to update item without marking as user-edited. Currently unused in the app.
  // rename to 'update-item' before use.
  ipcMain.handle('___update-item', async (_, updatedItem: LibraryItem): Promise<void> => {
    await _updateItem(updatedItem)
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
    'user-apply-tmdb-result',
    async (_event, itemId: string, result: any, mediaType: 'movie' | 'tv' | 'season') => {
      if (!db || !db.root) return
      markAsUserEdited(itemId, db.root)
      const item = findItemById(itemId, db.root)
      if (!item) return

      const settings = await readSettings()
      const libraryDataPath = getLibraryDataPath()
      if (!settings.tmdbApiKey) return

      // --- Start Bulk Update ---
      // This prevents the proxy from sending intermediate "cleared" states to the UI,
      // which was causing the tab-switching bug.
      setBulkUpdateStatus(true)
      try {
        // Clear old data that will be replaced.
        item.overview = null
        item.year = null
        item.genres = []
        if (item.type === 'file') {
          item.opensAsFolder = true
        }

        // Set image paths to undefined to trigger re-fetch in fetchItemDetails.
        // `null` means "user explicitly removed", `undefined` means "not yet fetched".
        item.posterPath = undefined
        item.backdropPath = undefined
        item.logoPath = undefined

        // Reset fetch state flags so they are re-evaluated.
        item.tmdbDetailsFetched = false
        item.tmdbCreditsFetched = false
        item.tmdbCredits = null

        // --- Invalidate TV Show specific data ---
        if (item.type === 'folder' && mediaType === 'tv') {
          item.tmdbSeasons = null
          item.tmdbEpisodesFetched = false // Allow re-processing of show structure
          for (const season of item.children) {
            if (season.type === 'folder' && season.mediaType === 'season') {
              season.tmdbDetailsFetched = false
              season.tmdbEpisodesFetched = undefined
              for (const episode of season.children) {
                if (episode.type === 'file' && episode.mediaType === 'episode') {
                  episode.posterPath = undefined
                }
              }
            }
          }
        }

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
          item.tmdbDetailsFetched = true
          item.tmdbEpisodesFetched = undefined // Ensure episodes will be fetched

          const episodeFiles = item.children.filter((c) => c.type === 'file') as MediaFile[]

          // Check if any episode files already have episode numbers
          const alreadyNumbered = episodeFiles.some((ef) => typeof ef.episodeNumber !== 'undefined')

          if (!alreadyNumbered) {
            // If no files are numbered, attempt to assign them using smart parsing for this season.
            log(
              `[Manual Match] No episodes numbered in season "${item.name}". Attempting smart parsing.`
            )
            const parsedSuccessfully = processAndAssignEpisodeNumbers(
              episodeFiles,
              item.seasonNumber
            )
            if (!parsedSuccessfully) {
              log(
                `[Manual Match] Smart parsing failed for episodes in "${item.name}", falling back to alphabetical.`
              )
              // Alphabetical Fallback if smart parsing didn't work
              episodeFiles.sort((a, b) =>
                a.name.localeCompare(b.name, undefined, { numeric: true })
              )
              episodeFiles.forEach((file, index) => {
                file.episodeNumber = index + 1
                file.seasonNumber = item.seasonNumber // Ensure season number is set
                file.mediaType = 'episode'
              })
            }
          } else {
            log(
              `[Manual Match] Episodes in season "${item.name}" already have numbers. Skipping local assignment.`
            )
          }

          // Now, fetch and apply TMDB episode data using the (now potentially assigned) local episode numbers.
          const showFolder = findParent(item.id, db!.root!)
          if (showFolder && showFolder.tmdbId && settings.tmdbApiKey) {
            console.log(
              `[Manual Match] Season matched. Now fetching TMDB episode data for "${item.name}"...`
            )
            if (!showFolder.tmdbDetailsFetched) {
              // Ensure parent show details (which include tmdbSeasons) are fetched if not already
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
            } else {
              // If parent show doesn't have tmdbSeasons (e.g., TV processing disabled for the show),
              // call fetchAndApplyEpisodeData without it. The function will use item.seasonNumber.
              log(
                `[Manual Match] Parent show "${showFolder.name}" has no cached TMDB seasons. Fetching episodes directly for S${item.seasonNumber} of "${item.name}".`
              )
              await fetchAndApplyEpisodeData(
                item, // This is the seasonFolder
                showFolder.tmdbId,
                settings.tmdbApiKey,
                libraryDataPath
                // tmdbSeasons argument is omitted
              )
            }
          } else {
            log(
              `[Manual Match] Cannot fetch episodes for "${item.name}": Parent show folder, TMDB ID, or API key missing.`
            )
          }
        } else {
          // --- Existing logic for Movie/TV Show ---
          item.tmdbId = result.id
          item.mediaType = mediaType
          item.title = result.title // Movies/Shows have 'title' or 'name' (handled by manualSearch)

          // If we're applying a TV show result after a metadata clear, we need to
          // re-run the local structure analysis to identify season folders BEFORE
          // we fetch and apply the new details.
          if (
            item.type === 'folder' &&
            mediaType === 'tv' &&
            (item as MediaFolder).process_tv_children !== false
          ) {
            log('[Manual Match] Re-processing local TV structure before fetching details.')
            processTvShowStructure(item as MediaFolder)
          }

          await fetchItemDetails(item, settings, libraryDataPath)
          // Also fetch credits to make the item fully populated immediately.
          if (mediaType === 'movie' || mediaType === 'tv') {
            await fetchAndApplyCredits(item, settings.tmdbApiKey)
          }
        }
      } finally {
        setBulkUpdateStatus(false) // --- End Bulk Update ---
      }

      // Bust the UI cache to reflect all the new data and images.
      item._v = Date.now()

      // Re-evaluate virtual tags after all other properties have been updated.
      // This is safe to do outside the bulk update.
      item.virtualTags = evaluateVirtualTagsForItem(item, settings)

      // Use the centralized helper to save and broadcast the final, complete item.
      await _finalizeItemUpdate(item, { updateSuggestions: true })
    }
  )

  ipcMain.handle('mark-as-unwatched', async (_, itemId: string): Promise<void> => {
    if (!db || !db.root) return

    const item = findItemById(itemId, db.root)
    if (!item) {
      console.error(`Cannot mark as unwatched: item ${itemId} not found.`)
      return
    }

    const modifiedItems: LibraryItem[] = []
    function setUnwatchedRecursively(node: LibraryItem) {
      if (node.type === 'file' && node.watched) {
        node.watched = false
        node.lastWatched = undefined
        modifiedItems.push(node)
      }
      if (node.type === 'folder') {
        let wasModified = false
        if (node.continueWatchingDismissed) {
          node.continueWatchingDismissed = false
          wasModified = true
        }
        if (node.nextUpDismissed) {
          node.nextUpDismissed = false
          wasModified = true
        }
        if (wasModified) {
          modifiedItems.push(node)
        }

        if (node.children) {
          for (const child of node.children) {
            setUnwatchedRecursively(child)
          }
        }
      }
    }

    setBulkUpdateStatus(true)
    setUnwatchedRecursively(item)
    setBulkUpdateStatus(false)

    if (modifiedItems.length > 0) {
      updateIndexForItems(modifiedItems)
      await _finalizeItemUpdate(modifiedItems, { updateSuggestions: false })
    }
  })

  ipcMain.handle('mark-as-watched', async (_, itemId: string): Promise<void> => {
    if (!db || !db.root) return

    const item = findItemById(itemId, db.root)
    if (!item) {
      console.error(`Cannot mark as watched: item ${itemId} not found.`)
      return
    }

    const modifiedItems: LibraryItem[] = []
    function setWatchedRecursively(node: LibraryItem) {
      if (node.type === 'file' && !node.watched) {
        node.watched = true
        ;(node as MediaFile).lastWatched = Date.now()
        modifiedItems.push(node)
      }
      if (node.type === 'folder' && node.children) {
        for (const child of node.children) {
          setWatchedRecursively(child)
        }
      }
    }

    setBulkUpdateStatus(true)
    setWatchedRecursively(item)
    setBulkUpdateStatus(false)

    if (modifiedItems.length > 0) {
      updateIndexForItems(modifiedItems)
      await _finalizeItemUpdate(modifiedItems, { updateSuggestions: false })
    }
  })

  ipcMain.handle(
    'get-folder-watched-state',
    async (_, folderId: string): Promise<'fully' | 'partially' | 'unwatched' | 'none'> => {
      if (!db?.root) return 'none'
      const folder = findItemById(folderId, db.root)
      if (!folder || folder.type !== 'folder') return 'none'
      return getFolderWatchedState(folder)
    }
  )

  ipcMain.handle(
    'assign-seasons-and-episodes',
    async (
      _,
      showId: string,
      seasonStrategy: 'smart' | 'alphabetic',
      episodeStrategy: 'smart' | 'alphabetic',
      fetchMetadata: boolean
    ) => {
      if (!db?.root) return

      const show = findItemById(showId, db.root)
      if (!show || show.type !== 'folder') {
        log(`[Assign Seasons] Could not find show with ID ${showId}`)
        return
      }

      log(`[Assign Seasons] Starting assignment for "${show.name}"...`)
      setBulkUpdateStatus(true)

      try {
        const modifiedItems = new Set<LibraryItem>()
        modifiedItems.add(show) // 1. Clear old data from the show object itself and all children

        log(`[Assign Seasons] Clearing old season/episode data...`)
        show.tmdbSeasons = undefined
        show.tmdbEpisodesFetched = undefined
        const imagesDir = path.join(getLibraryDataPath(), 'images')
        await clearTvStructureMetadata(show, imagesDir, modifiedItems) // 2. Assign new data

        log(
          `[Assign Seasons] Assigning new data with strategy: ${seasonStrategy}/${episodeStrategy}`
        )
        assignSeasonsAndEpisodes(show, seasonStrategy, episodeStrategy) // 3. Re-collect all modified items after assignment to ensure they are marked dirty

        getAllItemsAsList(show, []).forEach((item) => modifiedItems.add(item))

        const settings = await readSettings() // 4. Optionally fetch new metadata using the targeted season refetch logic

        if (fetchMetadata || show.process_tv_children !== false) {
          log(`[Assign Seasons] Triggering targeted season fetch for "${show.name}"...`) // This function now returns all modified items (the show and its children)

          const fetchedItems = await refetchShowSeasons(show, settings, getLibraryDataPath())
          for (const item of fetchedItems) {
            modifiedItems.add(item)
          }
        } // 5. Re-apply virtual tags and update search index for all changed items

        log(
          `[Assign Seasons] Re-applying virtual tags and re-indexing for ${modifiedItems.size} items...`
        )
        for (const item of modifiedItems) {
          item.virtualTags = evaluateVirtualTagsForItem(item, settings)
          updateIndexForItem(item)
        }

        setBulkUpdateStatus(false) // 6. Finalize update (save DB, notify UI)

        log(`[Assign Seasons] Finalizing update for ${modifiedItems.size} items...`)
        await _finalizeItemUpdate(Array.from(modifiedItems), { updateSuggestions: true })

        log(`[Assign Seasons] Assignment complete for "${show.name}".`)
      } catch (error) {
        console.error(`[Assign Seasons] Failed during assignment for show ${showId}:`, error)
        setBulkUpdateStatus(false)
      }
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
    'user-set-image',
    async (
      _event,
      itemId: string,
      imageType: 'poster' | 'backdrop' | 'logo',
      source: { type: 'tmdb'; path: string } | { type: 'local'; path: string }
    ) => {
      if (!db || !db.root) return
      markAsUserEdited(itemId, db.root)
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

        // Use the centralized helper. No need to update suggestions for an image change.
        await _finalizeItemUpdate(item, { updateSuggestions: false })
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
    async (_event, itemId: string, imageType: 'poster' | 'backdrop' | 'logo') => {
      if (!db || !db.root) return
      const item = findItemById(itemId, db.root)
      if (!item) return

      // Explicitly set the path to `null` to prevent future automatic fetching.
      // This is a user action to permanently remove an unwanted image.
      if (imageType === 'poster') item.posterPath = null
      else if (imageType === 'backdrop') item.backdropPath = null
      else if (imageType === 'logo') item.logoPath = null

      item._v = Date.now() // Bust cache

      // Use the centralized helper. No need to update suggestions for an image change.
      await _finalizeItemUpdate(item, { updateSuggestions: false })
    }
  )

  ipcMain.on('reveal-in-explorer', async (_, relativePath: string) => {
    const mediaSourcePath = await getAbsoluteMediaSourcePath()
    if (mediaSourcePath) {
      const absolutePath = path.join(mediaSourcePath, relativePath)
      shell.showItemInFolder(absolutePath)
    }
  })

  ipcMain.handle('trash-item', async (_, relativePath: string): Promise<boolean> => {
    const mediaSourcePath = await getAbsoluteMediaSourcePath()
    if (!mediaSourcePath) return false
    const absolutePath = path.join(mediaSourcePath, relativePath)
    try {
      await shell.trashItem(absolutePath)
      return true
    } catch (error) {
      console.error(`Failed to trash item at ${absolutePath}:`, error)
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

  ipcMain.handle(
    'rename-item',
    async (_, relativeOldPath: string, newName: string): Promise<boolean> => {
      const mediaSourcePath = await getAbsoluteMediaSourcePath()
      if (!mediaSourcePath) return false
      if (!db || !db.root) return false

      function findItemByPath(p: string, node: MediaFolder): LibraryItem | null {
        if (node.path === p) return node
        if (!node.children) return null
        for (const child of node.children) {
          if (child.path === p) return child
          if (child.type === 'folder') {
            const found = findItemByPath(p, child)
            if (found) return found
          }
        }
        return null
      }
      const itemToRename = findItemByPath(relativeOldPath, db.root)
      if (!itemToRename) {
        console.error(`[Rename] Could not find item in DB: ${relativeOldPath}`)
        return false
      }

      const oldAbsolutePath = path.join(mediaSourcePath, relativeOldPath)
      const newAbsolutePath = path.join(path.dirname(oldAbsolutePath), newName)

      try {
        await fs.rename(oldAbsolutePath, newAbsolutePath)

        setBulkUpdateStatus(true)

        const parent = findParent(itemToRename.id, db.root)
        if (!parent) {
          setBulkUpdateStatus(false)
          console.error(`[Rename] Could not find parent for item: ${itemToRename.name}`)
          return false
        }
        const settings = await readSettings()

        function updatePathsAndIds(item: LibraryItem, newParentPath: string) {
          removeItemAndDescendantsFromIndex(item)

          if (item.path === relativeOldPath) item.name = newName

          item.path = path.join(newParentPath, item.name).replace(/\\/g, '/')
          item.id = generateId(item.path)
          item.virtualTags = evaluateVirtualTagsForItem(item, settings)

          if (item.type === 'folder') {
            item.children.forEach((child) => updatePathsAndIds(child, item.path))
          }
          updateIndexForItem(item)
        }

        updatePathsAndIds(itemToRename, parent.path === '.' ? '' : parent.path)

        setBulkUpdateStatus(false)
        await writeDb(db)

        return true
      } catch (error) {
        console.error(`Failed to rename from ${oldAbsolutePath} to ${newAbsolutePath}:`, error)
        BrowserWindow.getFocusedWindow()?.webContents.send('show-error-dialog', {
          title: 'Rename Error',
          message: 'Failed to rename item. Check file permissions or see logs for details.',
          detail: (error as Error).message
        })
        return false
      }
    }
  )

  ipcMain.handle('get-item-properties', async (_, relativePath: string) => {
    const mediaSourcePath = await getAbsoluteMediaSourcePath()
    if (!mediaSourcePath) return null
    const absolutePath = path.join(mediaSourcePath, relativePath)
    try {
      const stats = await fs.stat(absolutePath)
      const baseProperties = {
        name: path.basename(absolutePath),
        path: absolutePath,
        type: stats.isDirectory() ? 'Folder' : ('File' as 'File' | 'Folder'),
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
  })

  ipcMain.handle(
    'debug-perform-search',
    async (_, query: { text: string; tags: { key: string; value: string }[] }) => {
      // Calls the verbose search function for the debug console.
      return debugPerformSearch(query)
    }
  )

  ipcMain.handle('delete-item-from-db', async (_, itemId: string): Promise<boolean> => {
    if (!db || !db.root) return false

    const parent = findParent(itemId, db.root)
    if (!parent) {
      log(`[DB Delete] Could not find parent for item ${itemId}. Deletion failed.`)
      return false
    }

    const itemIndex = parent.children.findIndex((c) => c.id === itemId)
    if (itemIndex === -1) {
      log(`[DB Delete] Item ${itemId} not found in parent's children. Deletion failed.`)
      return false
    }

    const [itemToDelete] = parent.children.splice(itemIndex, 1)

    // This recursively cleans up all in-memory indexes and maps
    removeItemAndDescendantsFromIndex(itemToDelete)

    await writeDb(db)

    // Notify all windows that an item was deleted.
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send('library-item-deleted', itemId)
    })

    log(`[DB Delete] Successfully deleted item ${itemToDelete.id} from database.`)
    return true
  })

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

  ipcMain.handle('set-continue-watching-dismissed', async (_, showId: string) => {
    if (!db || !db.root) return
    const show = findItemById(showId, db.root)
    if (show && show.type === 'folder') {
      show.continueWatchingDismissed = true
      await _finalizeItemUpdate(show, { updateSuggestions: false })
    }
  })

  ipcMain.handle('set-next-up-dismissed', async (_, showId: string) => {
    if (!db || !db.root) return
    const show = findItemById(showId, db.root)
    if (show && show.type === 'folder') {
      show.nextUpDismissed = true
      show.continueWatchingDismissed = true // Also dismiss on home screen
      await _finalizeItemUpdate(show, { updateSuggestions: false })
    }
  })

  ipcMain.handle(
    'get-continue-watching-items',
    async (): Promise<{ show: MediaFolder; nextEpisode: MediaFile }[]> => {
      if (!db?.root) return []

      const allItems = getAllItemsAsList(db.root)
      const parentMap = new Map<string, string>()
      function buildParentMap(node: MediaFolder) {
        if (!node.children) return
        for (const child of node.children) {
          parentMap.set(child.id, node.id)
          if (child.type === 'folder') {
            buildParentMap(child)
          }
        }
      }
      buildParentMap(db.root)

      const shows = new Map<string, MediaFolder>()
      const episodesByShow = new Map<string, MediaFile[]>()

      for (const item of allItems) {
        if (item.type === 'folder' && item.mediaType === 'tv') {
          shows.set(item.id, item)
          episodesByShow.set(item.id, [])
        }
      }

      for (const item of allItems) {
        if (item.type === 'file' && item.mediaType === 'episode') {
          let currentParentId = parentMap.get(item.id)
          let showId: string | null = null
          while (currentParentId) {
            const parent = findItemById(currentParentId, db.root)
            if (parent?.type === 'folder' && parent.mediaType === 'tv') {
              showId = parent.id
              break
            }
            currentParentId = parentMap.get(currentParentId)
          }

          if (showId && episodesByShow.has(showId)) {
            episodesByShow.get(showId)!.push(item as MediaFile)
          }
        }
      }

      const getComparableEpisodeNumber = (ep: MediaFile) =>
        (ep.seasonNumber ?? 0) * 10000 + (ep.episodeNumber ?? 0)

      const continueWatchingItems: {
        show: MediaFolder
        nextEpisode: MediaFile
        lastWatched: number
      }[] = []

      for (const [showId, show] of shows.entries()) {
        if (show.continueWatchingDismissed) continue

        const episodes = episodesByShow.get(showId)!
        if (episodes.length === 0) continue

        const watchedEpisodes = episodes.filter((ep) => ep.watched)
        if (watchedEpisodes.length === 0) continue

        const allEpisodesSorted = [...episodes].sort(
          (a, b) => getComparableEpisodeNumber(a) - getComparableEpisodeNumber(b)
        )

        const maxWatchedEpisode = watchedEpisodes.reduce((max, ep) =>
          getComparableEpisodeNumber(ep) > getComparableEpisodeNumber(max) ? ep : max
        )

        let nextUnwatchedEpisode: MediaFile | undefined
        for (const episode of allEpisodesSorted) {
          if (getComparableEpisodeNumber(episode) > getComparableEpisodeNumber(maxWatchedEpisode)) {
            if (!episode.watched) {
              nextUnwatchedEpisode = episode
              break
            }
          }
        }

        if (nextUnwatchedEpisode) {
          await fetchEpisodeDataForContinueWatching(show, nextUnwatchedEpisode)
          const lastWatchedTime = Math.max(0, ...watchedEpisodes.map((ep) => ep.lastWatched ?? 0))
          continueWatchingItems.push({
            show: createShallowClonableCopy(show) as MediaFolder,
            nextEpisode: createShallowClonableCopy(nextUnwatchedEpisode) as MediaFile,
            lastWatched: lastWatchedTime
          })
        }
      }

      // Sort by most recently watched and return only the show and episode.
      return continueWatchingItems
        .sort((a, b) => b.lastWatched - a.lastWatched)
        .map(({ show, nextEpisode }) => ({ show, nextEpisode }))
    }
  )

  ipcMain.handle(
    'get-continue-watching-for-show',
    async (_, showId: string): Promise<{ show: MediaFolder; nextEpisode: MediaFile } | null> => {
      if (!db?.root) return null
      const show = findItemById(showId, db.root)
      if (show?.type !== 'folder' || show.mediaType !== 'tv' || show.nextUpDismissed) {
        return null
      }

      const episodes = (getAllItemsAsList(show) as LibraryItem[]).filter(
        (item) => item.type === 'file' && item.mediaType === 'episode'
      ) as MediaFile[]

      if (episodes.length === 0) return null
      const watchedEpisodes = episodes.filter((ep) => ep.watched)
      if (watchedEpisodes.length === 0) return null

      const getComparableEpisodeNumber = (ep: MediaFile) =>
        (ep.seasonNumber ?? 0) * 10000 + (ep.episodeNumber ?? 0)

      const allEpisodesSorted = [...episodes].sort(
        (a, b) => getComparableEpisodeNumber(a) - getComparableEpisodeNumber(b)
      )

      const maxWatchedEpisode = watchedEpisodes.reduce((max, ep) =>
        getComparableEpisodeNumber(ep) > getComparableEpisodeNumber(max) ? ep : max
      )

      let nextUnwatchedEpisode: MediaFile | undefined
      for (const episode of allEpisodesSorted) {
        if (getComparableEpisodeNumber(episode) > getComparableEpisodeNumber(maxWatchedEpisode)) {
          if (!episode.watched) {
            nextUnwatchedEpisode = episode
            break
          }
        }
      }

      if (nextUnwatchedEpisode) {
        await fetchEpisodeDataForContinueWatching(show as MediaFolder, nextUnwatchedEpisode)
        return {
          show: createShallowClonableCopy(show) as MediaFolder,
          nextEpisode: createShallowClonableCopy(nextUnwatchedEpisode) as MediaFile
        }
      }

      return null
    }
  )
}
