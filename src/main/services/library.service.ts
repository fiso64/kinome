import { exec } from 'child_process'
import path from 'path'
import { URL } from 'url'
import fs, { readdir, stat } from 'fs/promises'
import { type Dirent } from 'fs'
import crypto from 'crypto'
import * as virtualTagsService from './virtualTags.service'
import * as searchService from './search.service'
import * as retrieverService from './retriever.service'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import type {
  Database,
  MediaFolder,
  LibraryItem,
  MediaFile,
  AutocompleteSuggestions,
  Settings
} from '../../shared/types'
import { RESETTABLE_METADATA_KEYS } from '../../shared/types'
import { getTransport } from '../transport.registry'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Library Service] ${message}`)
}

type ErrorCallback = (options: { title: string; message: string; detail?: string }) => void

const DATABASE_FILE_NAME = 'database.json'
const DB_VERSION = 1

// --- In-Memory Database Cache ---
let db: Database | null = null
let isBulkUpdating = false

export const getBulkUpdateStatus = (): boolean => isBulkUpdating
const setBulkUpdateStatus = (status: boolean): void => {
  isBulkUpdating = status
  log(`Bulk update mode: ${status ? 'ON' : 'OFF'}`)
}

/**
 * Recursively traverses the library tree and applies virtual tags to each item.
 * This function MUTATES the items in place.
 */
function applyVirtualTagsToAllItems(node: LibraryItem, settings: Settings) {
  node.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(node, settings)
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
      const settings = await settingsService.readSettings()
      applyVirtualTagsToAllItems(rawDb.root, settings)
    }
    db = searchService.createDbProxy(rawDb, getBulkUpdateStatus)
    log('Database wrapped in proxy.')
    searchService.buildFullSearchIndex(db.root)
    setBulkUpdateStatus(false)
    log('Finished loading DB into memory.')
  } else {
    log('No database file found or DB is invalid.')
    db = null
    searchService.buildFullSearchIndex(null)
  }
}

function getDbPath(): string {
  return pathsService.resolveLibraryPath(DATABASE_FILE_NAME)
}

async function readDb(): Promise<Database | null> {
  try {
    const dbPath = getDbPath()
    let data: string
    if (pathsService.isRemoteLibrary()) {
      log(`Fetching remote database from: ${dbPath}`)
      const response = await fetch(dbPath)
      if (!response.ok) {
        if (response.status !== 404) {
          console.warn(`Failed to fetch ${dbPath}: ${response.statusText}`)
        }
        return null
      }
      data = await response.text()
    } else {
      data = await fs.readFile(dbPath, 'utf-8')
    }

    const parsedDb = JSON.parse(data) as Database
    if (parsedDb.version !== DB_VERSION) {
      console.warn(
        `Database version mismatch. Expected ${DB_VERSION}, got ${parsedDb.version}. Ignoring old DB.`
      )
      return null
    }
    return parsedDb
  } catch (e) {
    console.error(`Failed to read or parse database from ${getDbPath()}:`, e)
    return null
  }
}

async function writeDb(updatedDb: Database): Promise<void> {
  if (pathsService.isRemoteLibrary()) {
    if (db !== updatedDb) {
      db = searchService.createDbProxy(updatedDb, getBulkUpdateStatus)
      searchService.buildFullSearchIndex(db.root)
    }
    return
  }

  const libraryPath = pathsService.getLibraryDataPath()
  await fs.mkdir(libraryPath, { recursive: true })
  const dbPath = getDbPath()

  const replacer = (key: string, value: unknown) => {
    if (key === 'virtualTags') return undefined
    return value
  }

  await fs.writeFile(dbPath, JSON.stringify(updatedDb, replacer, 2))

  if (db !== updatedDb) {
    db = searchService.createDbProxy(updatedDb, getBulkUpdateStatus)
    searchService.buildFullSearchIndex(db.root)
  }
}

/**
 * Centralized helper to finalize an item update. It saves the database,
 * emits events for the transport layer, and updates suggestions.
 */
async function _finalizeItemUpdate(
  items: LibraryItem | LibraryItem[],
  options: { updateSuggestions?: boolean } = {}
): Promise<void> {
  if (!db) return
  await writeDb(db)

  const itemsArray = Array.isArray(items) ? items : [items]
  const plainItems = JSON.parse(JSON.stringify(itemsArray))
  getTransport().notifyLibraryItemsUpdated(plainItems)

  if (options.updateSuggestions) {
    const newSuggestions = await getAutocompleteSuggestions()
    getTransport().notifyAutocompleteSuggestionsUpdated(newSuggestions)
  }
  log(
    `Finalized update for ${itemsArray.length} item(s). Suggestions updated: ${!!options.updateSuggestions}`
  )
}

function generateId(relativePath: string): string {
  return crypto.createHash('sha256').update(relativePath).digest('hex')
}

function createShallowClonableCopy(item: LibraryItem): LibraryItem {
  const plainItem = JSON.parse(JSON.stringify(item))

  if (plainItem.type === 'folder') {
    plainItem.children = plainItem.children
      .filter((child: LibraryItem) => !child.isHidden)
      .map((child: LibraryItem) => {
        if (child.type === 'folder') {
          child.children = null as any
        }
        return child
      })
  }
  return plainItem
}

function findItemById(id: string, node: MediaFolder): LibraryItem | null {
  if (node.id === id) return node
  for (const child of node.children) {
    if (child.id === id) return child
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

function findParent(id: string, node: MediaFolder): MediaFolder | null {
  if (!node || !node.children) return null
  for (const child of node.children) {
    if (child.id === id) return node
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
    if (diskChildEntries.some((entry) => entry.name === '.ignore' && entry.isFile())) {
      log(`Ignoring directory due to .ignore file: ${nodeAbsolutePath}`)
      if (node.isUserEdited) {
        const hideRecursively = (item: LibraryItem) => {
          item.isHidden = true
          item.isMissing = undefined
          if (item.type === 'folder') item.children.forEach(hideRecursively)
        }
        hideRecursively(node)
      } else {
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
      return
    }
    if (node.isHidden) {
      const unhideRecursively = (item: LibraryItem) => {
        item.isHidden = undefined
        if (item.type === 'folder') item.children.forEach(unhideRecursively)
      }
      unhideRecursively(node)
    }
    node.isMissing = undefined
  } catch (e) {
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
  for (const child of node.children) {
    if (diskChildrenNames.has(child.name)) {
      child.isMissing = undefined
      if (child.type === 'folder') await syncWithDisk(child, mediaSourcePath)
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

function pruneUntouchedMissingItems(node: MediaFolder) {
  if (!node.children) return
  if (node.isMissing) {
    for (const child of node.children) {
      if (child.type === 'folder') pruneUntouchedMissingItems(child)
    }
    return
  }
  node.children = node.children.filter((child) => !(child.isMissing && !child.isUserEdited))
  for (const child of node.children) {
    if (child.type === 'folder') pruneUntouchedMissingItems(child)
  }
}

function parseEpisodeInfo(
  name: string
): { season?: number; episode: number; pattern: 'sxxexx' | 'episode_xx' | 'exx' } | null {
  const sxxexxPatterns = [/\bS(\d{1,2})\s?\.?\s?E(\d{1,3})\b/i, /S(\d{1,2})E(\d{1,3})/i]
  for (const pattern of sxxexxPatterns) {
    const match = name.match(pattern)
    if (match) return { season: parseInt(match[1]), episode: parseInt(match[2]), pattern: 'sxxexx' }
  }
  const episodeXXPattern = /\bEpisode\s*(\d{1,2})\b/i
  const episodeMatch = name.match(episodeXXPattern)
  if (episodeMatch) return { episode: parseInt(episodeMatch[1]), pattern: 'episode_xx' }
  const exxPattern = /\bE(\d{2})\b/i
  const exxMatch = name.match(exxPattern)
  if (exxMatch) return { episode: parseInt(exxMatch[1]), pattern: 'exx' }
  return null
}

function processAndAssignEpisodeNumbers(files: MediaFile[], parentSeasonNumber?: number): boolean {
  if (files.length === 0) return true
  const patterns: ('sxxexx' | 'episode_xx' | 'exx')[] = ['sxxexx', 'episode_xx', 'exx']
  const allParsedInfo = files.map((file) => ({ file, parsed: parseEpisodeInfo(file.name) }))
  for (const currentPattern of patterns) {
    const matches = allParsedInfo.filter((info) => info.parsed?.pattern === currentPattern)
    const mismatches = allParsedInfo.length - matches.length
    if (mismatches === 0 || (mismatches <= 2 && matches.length >= 3)) {
      log(
        `TV Structure: Applying pattern "${currentPattern}". Matches: ${matches.length}, Mismatches: ${mismatches}`
      )
      matches.forEach(({ file, parsed }) => {
        if (parsed) {
          file.mediaType = 'episode'
          file.episodeNumber = parsed.episode
          file.seasonNumber = parsed.season ?? parentSeasonNumber
        }
      })
      return true
    }
  }
  return false
}

const SPECIAL_FOLDER_NAMES_FOR_TV = ['extras', 'specials', 'deleted scenes', 'featurettes', 'nc']

function processTvShowStructure(showFolder: MediaFolder): void {
  log(`[Sync] Analyzing TV structure for: "${showFolder.name}"`)
  const allSubFolders = showFolder.children.filter(
    (c) => c.type === 'folder' && !SPECIAL_FOLDER_NAMES_FOR_TV.includes(c.name.toLowerCase())
  ) as MediaFolder[]
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
  const immediateFiles = showFolder.children.filter((c) => c.type === 'file') as MediaFile[]
  if (immediateFiles.length > 0) {
    assignNewEpisodeNumbers(immediateFiles, 1)
    return
  }
  if (allSubFolders.length > 0) {
    const seasonPattern = /\b(?:Season\s*|S)(\d{1,2})\b/i
    const unnumberedFolders = allSubFolders.filter((f) => typeof f.seasonNumber !== 'number')
    for (const folder of unnumberedFolders) {
      const match = folder.name.match(seasonPattern)
      if (match) {
        folder.seasonNumber = parseInt(match[1])
        folder.mediaType = 'season'
      }
    }
    const stillUnnumbered = allSubFolders.filter((f) => typeof f.seasonNumber !== 'number')
    if (stillUnnumbered.length > 0) {
      const maxExistingSeason = Math.max(0, ...allSubFolders.map((f) => f.seasonNumber ?? 0))
      stillUnnumbered.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      stillUnnumbered.forEach((folder, i) => {
        folder.seasonNumber = maxExistingSeason + i + 1
        folder.mediaType = 'season'
      })
    }
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

function _assignSeasonsAndEpisodesByStrategy(
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
        return
      }
    }
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
    let wasModified = false
    if (child.posterPath) {
      if (!pathsService.isRemoteLibrary()) {
        try {
          await fs.unlink(path.join(imagesDir, child.posterPath))
        } catch (e) {}
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
    }
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
    if (wasModified) modifiedItems.add(child)
    if (child.type === 'folder') await clearTvStructureMetadata(child, imagesDir, modifiedItems)
  }
}

async function verifyImagePaths(item: LibraryItem, imagesDir: string) {
  if (pathsService.isRemoteLibrary()) return
  if (item.posterPath) {
    try {
      await fs.access(path.join(imagesDir, item.posterPath))
    } catch {
      log(`Poster for "${item.name}" not found. Marking for re-download.`)
      item.posterPath = undefined
    }
  }
  if (item.backdropPath) {
    try {
      await fs.access(path.join(imagesDir, item.backdropPath))
    } catch {
      log(`Backdrop for "${item.name}" not found. Marking for re-download.`)
      item.backdropPath = undefined
    }
  }
  if (item.logoPath) {
    try {
      await fs.access(path.join(imagesDir, item.logoPath))
    } catch {
      log(`Logo for "${item.name}" not found. Marking for re-download.`)
      item.logoPath = undefined
    }
  }
}

async function scanDirectory(dirPath: string, rootPath: string): Promise<MediaFolder | null> {
  const name = path.basename(dirPath)
  const children: LibraryItem[] = []
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  if (entries.some((entry) => entry.name === '.ignore' && entry.isFile())) {
    log(`Ignoring directory due to .ignore file: ${dirPath}`)
    return null
  }
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    const entryRelativePath = path.relative(rootPath, entryPath).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      const subFolder = await scanDirectory(entryPath, rootPath)
      if (subFolder) children.push(subFolder)
    } else if (entry.isFile()) {
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
  if (children.length === 0) return null
  const relativePath = path.relative(rootPath, dirPath).replace(/\\/g, '/')
  return {
    id: generateId(relativePath || '.'),
    name: name || path.basename(rootPath),
    path: relativePath || '.',
    type: 'folder',
    children
  }
}

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
        const index = active.indexOf(promise)
        if (index !== -1) active.splice(index, 1)
      })
      active.push(promise)
    }
    if (active.length > 0) await Promise.race(active)
  }
}

function collectItemsToProcess(
  folder: MediaFolder,
  newItems: { item: LibraryItem; hint?: 'movie' | 'tv' }[],
  itemsMissingPosters: LibraryItem[],
  itemsMissingCredits: LibraryItem[],
  tvShows: MediaFolder[]
) {
  if (folder.isHidden || folder.isMissing) return
  if (folder.mediaType === 'tv') tvShows.push(folder)
  if (folder.retrieve_children_metadata) {
    for (const child of folder.children) {
      if (child.isHidden || child.isMissing) continue
      if (typeof child.tmdbId === 'undefined') {
        newItems.push({ item: child, hint: folder.children_type_hint })
      } else if (child.tmdbId) {
        if (!child.posterPath) itemsMissingPosters.push(child)
        if (
          !child.tmdbCreditsFetched &&
          (child.mediaType === 'movie' || child.mediaType === 'tv')
        ) {
          itemsMissingCredits.push(child)
        }
      }
    }
  }
  for (const child of folder.children) {
    if (child.type === 'folder') {
      collectItemsToProcess(child, newItems, itemsMissingPosters, itemsMissingCredits, tvShows)
    }
  }
}

async function fetchMetadataForLibrary() {
  if (!db || !db.root) return
  const settings = await settingsService.readSettings()
  const libraryDataPath = pathsService.getLibraryDataPath()
  if (!settings.tmdbApiKey) {
    console.warn('Metadata fetch skipped: No TMDB API key.')
    return
  }
  const newItemsToFetch: { item: LibraryItem; hint?: 'movie' | 'tv' }[] = []
  const itemsMissingPosters: LibraryItem[] = []
  const itemsMissingCredits: LibraryItem[] = []
  const allTvShows: MediaFolder[] = []
  collectItemsToProcess(
    db.root,
    newItemsToFetch,
    itemsMissingPosters,
    itemsMissingCredits,
    allTvShows
  )
  if (allTvShows.length > 0) {
    log(`[Metadata] Performing local analysis for ${allTvShows.length} TV shows.`)
    for (const show of allTvShows) {
      processTvShowStructure(show)
      if (show.tmdbSeasons && show.tmdbDetailsFetched) {
        const localSeasonNumbers = new Set<number>()
        show.children.forEach((child) => {
          if ('seasonNumber' in child && typeof child.seasonNumber === 'number') {
            localSeasonNumbers.add(child.seasonNumber)
          }
        })
        if (localSeasonNumbers.size > 0) {
          const cachedSeasonNumbers = new Set(show.tmdbSeasons.map((s) => s.season_number))
          let needsRefetch = false
          for (const localNum of localSeasonNumbers) {
            if (!cachedSeasonNumbers.has(localNum)) {
              needsRefetch = true
              break
            }
          }
          const hasUnprocessedSeason = show.children.some(
            (c) =>
              c.type === 'folder' && c.mediaType === 'season' && c.seasonNumber != null && !c.title
          )
          if (needsRefetch || hasUnprocessedSeason) {
            log(
              `[Metadata] New or unprocessed seasons detected for "${show.name}". Fetching updated season list.`
            )
            await retrieverService.refetchShowSeasons(show, settings, libraryDataPath)
          }
        }
      }
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
            log(
              `[Metadata] New episode for "${show.name} S${season.seasonNumber}" (new local max: ${maxLocalEpisode}, last: ${season._lastSeenLocalMaxEpisode}). Invalidating episode cache.`
            )
            season.tmdbEpisodesFetched = false
          }
          season._lastSeenLocalMaxEpisode = maxLocalEpisode
        }
      }
    }
  }
  if (
    newItemsToFetch.length === 0 &&
    itemsMissingPosters.length === 0 &&
    itemsMissingCredits.length === 0
  ) {
    log('[Metadata] No new items, missing posters, or missing credits to fetch.')
    return
  }
  const sendBatchUpdate = (updatedItems: LibraryItem[]): void => {
    if (updatedItems.length > 0) {
      const plainItems = JSON.parse(JSON.stringify(updatedItems))
      getTransport().notifyLibraryItemsUpdated(plainItems)
    }
  }
  await retrieverService.cacheGenreLists(settings.tmdbApiKey)
  if (newItemsToFetch.length > 0) {
    log(`[Metadata] Starting fetch for ${newItemsToFetch.length} new items...`)
    const updatedItemsBatch: LibraryItem[] = []
    const task = async (itemWithHint: {
      item: LibraryItem
      hint?: 'movie' | 'tv'
    }): Promise<void> => {
      const { item, hint } = itemWithHint
      await retrieverService.searchTmdbAndApplyMetadata(
        item,
        settings.tmdbApiKey,
        libraryDataPath,
        hint
      )
      if (item.type === 'folder' && item.mediaType === 'tv')
        processTvShowStructure(item as MediaFolder)
      if (item.posterPath || item.tmdbId === null) updatedItemsBatch.push(item)
    }
    await processInChunks(newItemsToFetch, 17, task)
    sendBatchUpdate(updatedItemsBatch)
  }
  if (itemsMissingPosters.length > 0) {
    log(`[Metadata] Starting poster refetch for ${itemsMissingPosters.length} items...`)
    const updatedItemsBatch: LibraryItem[] = []
    const task = async (item: LibraryItem): Promise<void> => {
      await retrieverService.refetchPoster(item, settings.tmdbApiKey, libraryDataPath)
      if (item.posterPath) updatedItemsBatch.push(item)
    }
    await processInChunks(itemsMissingPosters, 17, task)
    sendBatchUpdate(updatedItemsBatch)
  }
  if (itemsMissingCredits.length > 0) {
    log(`[Metadata] Starting credits fetch for ${itemsMissingCredits.length} items...`)
    const updatedItemsBatch: LibraryItem[] = []
    const task = async (item: LibraryItem): Promise<void> => {
      await retrieverService.fetchAndApplyCredits(item, settings.tmdbApiKey)
      if (item.tmdbCreditsFetched) updatedItemsBatch.push(item)
    }
    await processInChunks(itemsMissingCredits, 17, task)
    sendBatchUpdate(updatedItemsBatch)
  }
  await writeDb(db)
  log('[Metadata] Finished all fetching and saved final DB.')
  const newSuggestions = await getAutocompleteSuggestions()
  getTransport().notifyAutocompleteSuggestionsUpdated(newSuggestions)
  log('[Metadata] Autocomplete suggestions have been updated and broadcasted.')
}

async function fetchEpisodeDataForContinueWatching(show: MediaFolder, episode: MediaFile) {
  if (episode.title && episode.posterPath) return
  if (!show.tmdbId || !show.tmdbSeasons || !db || pathsService.isRemoteLibrary()) return
  const seasonFolder = show.children.find(
    (c) => c.type === 'folder' && c.seasonNumber === episode.seasonNumber
  ) as MediaFolder | undefined
  let itemsToUpdate: LibraryItem[] = []
  const wasBulkUpdating = getBulkUpdateStatus()
  setBulkUpdateStatus(true)
  try {
    const settings = await settingsService.readSettings()
    if (!settings.tmdbApiKey) return
    if (seasonFolder) {
      if (!seasonFolder.tmdbEpisodesFetched) {
        log(
          `[Continue Watching] Next episode "${episode.name}" is in an unfetched season. Fetching S${seasonFolder.seasonNumber}...`
        )
        const modifiedEpisodes = await retrieverService.fetchAndApplyEpisodeData(
          seasonFolder,
          show.tmdbId,
          settings.tmdbApiKey,
          pathsService.getLibraryDataPath(),
          show.tmdbSeasons
        )
        itemsToUpdate = [seasonFolder, ...modifiedEpisodes]
      }
    } else {
      if (!show.tmdbEpisodesFetched) {
        log(
          `[Continue Watching] Next episode "${episode.name}" is a loose file in an unfetched show. Fetching all loose episodes...`
        )
        const modifiedEpisodes = await retrieverService.applyTvShowData(
          show,
          settings,
          pathsService.getLibraryDataPath()
        )
        itemsToUpdate = [show, ...modifiedEpisodes]
      }
    }
  } catch (err) {
    console.error('[Continue Watching] Failed to fetch data:', err)
  } finally {
    setBulkUpdateStatus(wasBulkUpdating)
  }
  if (itemsToUpdate.length > 0) {
    await _finalizeItemUpdate(itemsToUpdate, { updateSuggestions: !seasonFolder })
  }
}

export async function reapplyVirtualTagsAfterSettingsChange() {
  if (!db || !db.root) {
    log('Cannot re-apply virtual tags: database not loaded.')
    return
  }
  log('Re-applying virtual tags to all items due to settings change...')
  setBulkUpdateStatus(true)
  const settings = await settingsService.readSettings()
  applyVirtualTagsToAllItems(db.root, settings)
  searchService.buildFullSearchIndex(db.root)
  setBulkUpdateStatus(false)
  await writeDb(db!)
  const allItems = getAllItemsAsList(db.root)
  log(`Emitting update for ${allItems.length} items.`)
  const plainItems = JSON.parse(JSON.stringify(allItems))
  getTransport().notifyLibraryItemsUpdated(plainItems)
  const newSuggestions = await getAutocompleteSuggestions()
  getTransport().notifyAutocompleteSuggestionsUpdated(newSuggestions)
  log('Finished re-applying virtual tags and notified transport layer.')
}

async function resetItemMetadata(item: LibraryItem, imagesDir: string) {
  if (!pathsService.isRemoteLibrary()) {
    if (item.posterPath)
      try {
        await fs.unlink(path.join(imagesDir, item.posterPath))
      } catch (e) {}
    if (item.backdropPath)
      try {
        await fs.unlink(path.join(imagesDir, item.backdropPath))
      } catch (e) {}
    if (item.logoPath)
      try {
        await fs.unlink(path.join(imagesDir, item.logoPath))
      } catch (e) {}
  }
  for (const key of RESETTABLE_METADATA_KEYS) {
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
          itemAsAny[key] = undefined
          break
        case 'posterPath':
        case 'backdropPath':
        case 'logoPath':
          itemAsAny[key] = undefined
          break
        default:
          itemAsAny[key] = null
          break
      }
    }
  }
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
    if (child.type === 'folder') await clearChildrenRecursively(child, imagesDir, modifiedItems)
  }
}

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
  const currentSettings = await settingsService.readSettings()
  for (const item of modifiedItems) {
    item.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(item, currentSettings)
  }
  setBulkUpdateStatus(false)
  for (const item of modifiedItems) {
    searchService.updateIndexForItem(item)
  }
  log(`Finished metadata clear for ${modifiedItems.length} items.`)
  await _finalizeItemUpdate(modifiedItems, { updateSuggestions: true })
}

export async function getFolderWatchedState(
  folderId: string
): Promise<'fully' | 'partially' | 'unwatched' | 'none'> {
  if (!db?.root) return 'none'
  const folder = findItemById(folderId, db.root)
  if (!folder || folder.type !== 'folder') return 'none'

  let hasWatched = false,
    hasUnwatched = false,
    hasFiles = false
  function traverse(item: LibraryItem) {
    if (hasWatched && hasUnwatched) return
    if (item.type === 'file') {
      hasFiles = true
      if (item.watched) hasWatched = true
      else hasUnwatched = true
    } else if (item.type === 'folder' && item.children) {
      for (const child of item.children) traverse(child)
    }
  }
  traverse(folder)
  if (!hasFiles) return 'none'
  if (hasWatched && hasUnwatched) return 'partially'
  if (hasWatched) return 'fully'
  return 'unwatched'
}

// =================================================================================================
// --- EXPORTED SERVICE FUNCTIONS (formerly IPC handlers) ---
// =================================================================================================

export async function getLibraryRoot(): Promise<MediaFolder | null> {
  if (!db) await loadDbIntoMemory()
  return db?.root ? (createShallowClonableCopy(db.root) as MediaFolder) : null
}

export async function refreshLibrary(): Promise<MediaFolder | null> {
  if (pathsService.isRemoteLibrary()) {
    throw new Error('Refreshing is not available for remote libraries.')
  }
  const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
  if (!db || !db.root || !mediaSourcePath) {
    throw new Error('Cannot refresh, no library configured.')
  }
  const refreshId = crypto.randomBytes(4).toString('hex')
  log(`[Refresh ${refreshId}] Starting refresh from: ${mediaSourcePath}`)
  const t0 = performance.now()
  try {
    await fs.access(mediaSourcePath)
  } catch (e) {
    throw {
      message: 'The configured media source path could not be found.',
      detail: `Path: ${mediaSourcePath}`
    }
  }
  setBulkUpdateStatus(true)
  await syncWithDisk(db.root, mediaSourcePath)
  const t1 = performance.now()
  log(`[Refresh ${refreshId}] syncWithDisk took ${(t1 - t0).toFixed(2)}ms`)
  pruneUntouchedMissingItems(db.root)
  const t2 = performance.now()
  log(`[Refresh ${refreshId}] pruneUntouchedMissingItems took ${(t2 - t1).toFixed(2)}ms`)
  const imagesDir = path.join(pathsService.getLibraryDataPath(), 'images')
  await verifyImagePaths(db.root, imagesDir)
  const t3 = performance.now()
  log(`[Refresh ${refreshId}] verifyImagePaths took ${(t3 - t2).toFixed(2)}ms`)
  const currentSettings = await settingsService.readSettings()
  applyVirtualTagsToAllItems(db.root, currentSettings)
  const t4 = performance.now()
  log(`[Refresh ${refreshId}] applyVirtualTagsToAllItems took ${(t4 - t3).toFixed(2)}ms`)
  searchService.buildFullSearchIndex(db.root)
  const t5 = performance.now()
  log(`[Refresh ${refreshId}] buildFullSearchIndex took ${(t5 - t4).toFixed(2)}ms`)
  setBulkUpdateStatus(false)
  await writeDb(db)
  const t6 = performance.now()
  log(`[Refresh ${refreshId}] writeDb took ${(t6 - t5).toFixed(2)}ms`)
  log(`[Refresh ${refreshId}] Library refresh and sync complete.`)
  fetchMetadataForLibrary().catch((err) =>
    console.error('Background metadata fetch failed during refresh:', err)
  )
  const t7 = performance.now()
  log(`[Refresh ${refreshId}] Total time before returning: ${(t7 - t0).toFixed(2)}ms`)
  const memoryUsage = process.memoryUsage()
  log(
    `[Refresh ${refreshId}] Memory: RSS=${(memoryUsage.rss / 1024 / 1024).toFixed(2)}MB, HeapTotal=${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)}MB, HeapUsed=${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`
  )
  return db.root ? (createShallowClonableCopy(db.root) as MediaFolder) : null
}

export async function performInitialScan(mediaSourcePath: string): Promise<MediaFolder | null> {
  if (pathsService.isRemoteLibrary())
    throw new Error('Scanning is not available when using a remote library.')
  log(`Starting scan of: ${mediaSourcePath}`)
  const settings = await settingsService.readSettings()
  let pathToSave = mediaSourcePath
  if (settings.mediaSourcePathIsRelative) {
    const libraryPath = pathsService.getLibraryDataPath()
    let relative = path.relative(path.dirname(libraryPath), mediaSourcePath)
    relative = relative.replace(/\\/g, '/')
    if (relative === '') pathToSave = '.'
    else if (relative.startsWith('../')) pathToSave = relative
    else pathToSave = './' + relative
  }
  await settingsService.writeLibrarySettings({ mediaSourcePath: pathToSave })
  const rootNode = await scanDirectory(mediaSourcePath, mediaSourcePath)
  setBulkUpdateStatus(true)
  const newDb: Database = { version: DB_VERSION, root: rootNode }
  if (rootNode) applyVirtualTagsToAllItems(rootNode, settings)
  setBulkUpdateStatus(false)
  await writeDb(newDb)
  log('Initial scan, DB write, and index build complete.')
  if (db!.root) {
    const deepCopy = JSON.parse(JSON.stringify(db!.root))
    function filterHiddenRecursively(folder: MediaFolder) {
      folder.children = folder.children.filter((child) => !child.isHidden)
      folder.children.forEach((child) => {
        if (child.type === 'folder') filterHiddenRecursively(child)
      })
    }
    filterHiddenRecursively(deepCopy)
    return deepCopy
  }
  return null
}

export async function performFullRescan(mediaSourcePath: string): Promise<MediaFolder | null> {
  if (pathsService.isRemoteLibrary())
    throw new Error('Rescanning is not available for remote libraries.')
  log(`Starting full rescan of: ${mediaSourcePath}`)
  const settings = await settingsService.readSettings()
  let pathToSave = mediaSourcePath
  if (settings.mediaSourcePathIsRelative) {
    const libraryPath = pathsService.getLibraryDataPath()
    let relative = path.relative(path.dirname(libraryPath), mediaSourcePath)
    relative = relative.replace(/\\/g, '/')
    if (relative === '') pathToSave = '.'
    else if (relative.startsWith('../')) pathToSave = relative
    else pathToSave = './' + relative
  }
  await settingsService.writeLibrarySettings({ mediaSourcePath: pathToSave })
  const rootNode = await scanDirectory(mediaSourcePath, mediaSourcePath)
  setBulkUpdateStatus(true)
  const newDb: Database = { version: DB_VERSION, root: rootNode }
  if (rootNode) applyVirtualTagsToAllItems(rootNode, settings)
  setBulkUpdateStatus(false)
  await writeDb(newDb)
  log('Full rescan, DB write, and index build complete.')
  if (db!.root) {
    const deepCopy = JSON.parse(JSON.stringify(db!.root))
    function filterHiddenRecursively(folder: MediaFolder) {
      folder.children = folder.children.filter((child) => !child.isHidden)
      folder.children.forEach((child) => {
        if (child.type === 'folder') filterHiddenRecursively(child)
      })
    }
    filterHiddenRecursively(deepCopy)
    return deepCopy
  }
  return null
}

export async function getItemDetails(itemId: string): Promise<LibraryItem | null> {
  if (!db || !db.root) throw new Error('Cannot get item details: database not found.')
  const item = findItemById(itemId, db.root)
  if (!item) throw new Error(`Cannot get item details: item with id ${itemId} not found.`)
  await verifyImagePaths(item, path.join(pathsService.getLibraryDataPath(), 'images'))
  const needsDetailsFetch = !item.tmdbDetailsFetched && item.tmdbId
  const needsEpisodeFetch =
    item.type === 'folder' &&
    (item.mediaType === 'tv' || item.mediaType === 'season') &&
    !item.tmdbEpisodesFetched
  if (needsDetailsFetch || needsEpisodeFetch) {
    ;(async () => {
      if (pathsService.isRemoteLibrary()) {
        log(`[Details] Skipping metadata fetch for "${item.name}" on remote read-only library.`)
        return
      }
      setBulkUpdateStatus(true)
      const allModifiedItems: LibraryItem[] = []
      try {
        const settings = await settingsService.readSettings()
        if (!settings.tmdbApiKey) return
        if (needsDetailsFetch) {
          log(`[Details] Item details missing. Starting full fetch for "${item.name}"`)
          const modified = await retrieverService.fetchItemDetails(
            item,
            settings,
            pathsService.getLibraryDataPath()
          )
          allModifiedItems.push(...modified)
        } else if (needsEpisodeFetch && item.type === 'folder') {
          if (item.mediaType === 'season') {
            const showFolder = findParent(item.id, db!.root!)
            if (showFolder && showFolder.tmdbId && showFolder.process_tv_children !== false) {
              if (!showFolder.tmdbDetailsFetched) {
                log(
                  `[Details] Parent show "${showFolder.name}" details missing, fetching them first.`
                )
                const modifiedParent = await retrieverService.fetchItemDetails(
                  showFolder,
                  settings,
                  pathsService.getLibraryDataPath()
                )
                allModifiedItems.push(...modifiedParent)
              }
              if (showFolder.tmdbSeasons) {
                log(`[Details] Season episodes missing. Fetching for "${item.name}"`)
                const modifiedEpisodes = await retrieverService.fetchAndApplyEpisodeData(
                  item,
                  showFolder.tmdbId,
                  settings.tmdbApiKey,
                  pathsService.getLibraryDataPath(),
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
            const modifiedChildren = await retrieverService.applyTvShowData(
              item,
              settings,
              pathsService.getLibraryDataPath()
            )
            allModifiedItems.push(item, ...modifiedChildren)
          }
        }
        item._v = Date.now()
      } catch (err) {
        console.error(`[Details] Background fetch for item ${itemId} failed:`, err)
      } finally {
        setBulkUpdateStatus(false)
        const uniqueItems = [...new Map(allModifiedItems.map((it) => [it.id, it])).values()]
        const itemsToUpdate = uniqueItems.length > 0 ? uniqueItems : [item]
        for (const modifiedItem of itemsToUpdate) {
          searchService.updateIndexForItem(modifiedItem)
        }
        await _finalizeItemUpdate(itemsToUpdate, { updateSuggestions: true })
        log(`[Details] Background processing complete for "${item.name}"`)
      }
    })()
  }
  if (item) {
    const deepCopy = JSON.parse(JSON.stringify(item))
    if (deepCopy.type === 'folder' && Array.isArray(deepCopy.children)) {
      deepCopy.children = deepCopy.children.filter((child: LibraryItem) => !child.isHidden)
    }
    return deepCopy
  }
  return null
}

export async function fetchCredits(itemId: string): Promise<void> {
  if (pathsService.isRemoteLibrary()) {
    log(`[Credits] Skipping fetch for item ${itemId} on remote read-only library.`)
    return
  }
  if (!db || !db.root) return
  const item = findItemById(itemId, db.root)
  if (!item) throw new Error(`[Credits] Cannot fetch, item ${itemId} not found.`)
  const needsCreditsFetch =
    !item.tmdbCreditsFetched &&
    item.tmdbId &&
    (item.mediaType === 'movie' || item.mediaType === 'tv')
  if (!needsCreditsFetch) {
    log(`[Credits] Fetch not needed for "${item.name}".`)
    return
  }
  try {
    const settings = await settingsService.readSettings()
    if (!settings.tmdbApiKey || settings.creditsDisplay === 'hidden') {
      if (settings.creditsDisplay === 'hidden') {
        item.tmdbCreditsFetched = true
        await writeDb(db)
      }
      return
    }
    await retrieverService.fetchAndApplyCredits(item, settings.tmdbApiKey)
    item._v = Date.now()
    await _finalizeItemUpdate(item, { updateSuggestions: true })
    log(`[Credits] Fetch complete for "${item.name}"`)
  } catch (err) {
    console.error(`[Credits] Background fetch for item ${itemId} failed:`, err)
  }
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
  ;(async () => {
    if (!db?.root) return
    const itemInDb = findItemById(file.id, db.root)
    if (!itemInDb || itemInDb.type !== 'file') return

    const wasBulk = getBulkUpdateStatus()
    setBulkUpdateStatus(true)

    const itemsToUpdate: LibraryItem[] = [itemInDb]
    itemInDb.watched = true
    itemInDb.lastWatched = Date.now()

    let parent = findParent(itemInDb.id, db.root)
    while (parent) {
      if (parent.mediaType === 'tv') {
        let parentModified = false
        if (parent.continueWatchingDismissed) {
          parent.continueWatchingDismissed = false
          parentModified = true
        }
        if (parent.nextUpDismissed) {
          parent.nextUpDismissed = false
          parentModified = true
        }
        if (parentModified) {
          itemsToUpdate.push(parent)
        }
        break // Stop searching upwards once we find the show
      }
      parent = findParent(parent.id, db.root)
    }

    setBulkUpdateStatus(wasBulk)

    if (itemsToUpdate.length > 0) {
      searchService.updateIndexForItems(itemsToUpdate)
      await _finalizeItemUpdate(itemsToUpdate)
    }
  })()
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

export async function applyInitialFolderSettings(
  settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]
) {
  if (pathsService.isRemoteLibrary()) return
  if (!db || !db.root) return
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
    log('Applied initial folder settings and saved to DB.')
    fetchMetadataForLibrary().catch((err) =>
      console.error('Background metadata fetch failed after applying initial settings:', err)
    )
  } catch (error) {
    console.error('Failed to apply initial folder settings:', error)
  }
}

export async function clearItemMetadata(itemId: string): Promise<boolean> {
  if (!db || !db.root) return false
  const item = findItemById(itemId, db.root)
  if (!item) return false
  log(`Starting metadata clear for item "${item.name}"...`)
  setBulkUpdateStatus(true)
  try {
    const imagesDir = path.join(pathsService.getLibraryDataPath(), 'images')
    const modifiedItems: LibraryItem[] = []
    await resetItemMetadata(item, imagesDir)
    modifiedItems.push(item)
    if (item.type === 'folder') await clearChildrenRecursively(item, imagesDir, modifiedItems)
    await finalizeMetadataClear(modifiedItems)
    return true
  } catch (error) {
    console.error('Failed during metadata clearing process:', error)
    setBulkUpdateStatus(false)
    return false
  }
}

export async function clearVirtualFolderMetadata(itemIds: string[]): Promise<boolean> {
  if (!db || !db.root) return false
  log(`Starting metadata clear for ${itemIds.length} items from virtual folder...`)
  setBulkUpdateStatus(true)
  try {
    const imagesDir = path.join(pathsService.getLibraryDataPath(), 'images')
    const modifiedItems: LibraryItem[] = []
    for (const itemId of itemIds) {
      const item = findItemById(itemId, db.root)
      if (!item) continue
      await resetItemMetadata(item, imagesDir)
      modifiedItems.push(item)
      if (item.type === 'folder') await clearChildrenRecursively(item, imagesDir, modifiedItems)
    }
    await finalizeMetadataClear(modifiedItems)
    return true
  } catch (error) {
    console.error('Failed during virtual folder metadata clearing process:', error)
    setBulkUpdateStatus(false)
    return false
  }
}

export async function getAutocompleteSuggestions(): Promise<AutocompleteSuggestions> {
  if (!db || !db.root)
    return {
      mediaTypes: [],
      genres: [],
      persons: [],
      tagKeys: [],
      virtualTagKeys: [],
      tagValues: {}
    }
  const allItems = getAllItemsAsList(db.root)
  const mediaTypes = new Set<string>(),
    genres = new Set<string>(),
    persons = new Set<string>(),
    tagKeys = new Set<string>(),
    virtualTagKeys = new Set<string>()
  const tagValues: Record<string, Set<string>> = {}
  for (const item of allItems) {
    if (item.mediaType) mediaTypes.add(item.mediaType.trim())
    if (item.genres) item.genres.forEach((genre) => genres.add(genre.trim()))
    if (item.tmdbCredits) {
      ;(item.tmdbCredits.cast ?? []).forEach((p) => p.name && persons.add(p.name.trim()))
      ;(item.tmdbCredits.crew ?? []).forEach((p) => p.name && persons.add(p.name.trim()))
    }
    if (item.tags) {
      for (const [key, value] of Object.entries(item.tags)) {
        if (key) {
          tagKeys.add(key.trim())
          if (!tagValues[key]) tagValues[key] = new Set<string>()
          value.split(',').forEach((v) => {
            const trimmedV = v.trim()
            if (trimmedV) tagValues[key].add(trimmedV)
          })
        }
      }
    }
    if (item.virtualTags) {
      for (const [key, value] of Object.entries(item.virtualTags)) {
        if (key) {
          virtualTagKeys.add(key.trim())
          if (!tagValues[key]) tagValues[key] = new Set<string>()
          value.split(',').forEach((v) => {
            const trimmedV = v.trim()
            if (trimmedV) tagValues[key].add(trimmedV)
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

export async function updateItem(updatedItem: LibraryItem, isUserEdit: boolean): Promise<void> {
  if (!db || !db.root) throw new Error('Cannot update item: database not found in memory.')
  if (isUserEdit) {
    log(
      `Marking item as user-edited: "${updatedItem.title ?? updatedItem.name}" (ID: ${updatedItem.id})`
    )
    markAsUserEdited(updatedItem.id, db.root)
  }
  const itemInDb = findItemById(updatedItem.id, db.root)
  if (itemInDb) {
    setBulkUpdateStatus(true)
    const safeUpdates = { ...updatedItem }
    delete (safeUpdates as Partial<MediaFolder>).children
    delete (safeUpdates as Partial<LibraryItem>).id
    delete (safeUpdates as Partial<LibraryItem>).path
    delete (safeUpdates as Partial<LibraryItem>).type
    Object.assign(itemInDb, safeUpdates)
    const settings = await settingsService.readSettings()
    itemInDb.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(itemInDb, settings)
    setBulkUpdateStatus(false)
    searchService.updateIndexForItem(itemInDb)
    await _finalizeItemUpdate(itemInDb, { updateSuggestions: true })
    log(`Updated item ${updatedItem.id} in database.`)
  } else {
    throw new Error(`Could not find item with id ${updatedItem.id} in DB to update.`)
  }
}

export const manualSearch = retrieverService.manualSearch
export const getTmdbImages = retrieverService.getTmdbImages

export async function executeCustomAction(
  itemId: string,
  commandId: string,
  onError: ErrorCallback
): Promise<void> {
  if (!db?.root) return
  const item = findItemById(itemId, db.root)
  if (!item) return
  const settings = await settingsService.readSettings()
  const action = settings.customActions.find((a) => a.id === commandId)
  if (!action) return
  const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
  if (!mediaSourcePath) return
  const absolutePath = path.join(mediaSourcePath, item.path)
  const title = item.title ?? item.name.replace(/\.[^/.]+$/, '')
  let commandToExecute = action.command
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

export async function applyTmdbResult(
  itemId: string,
  result: any,
  mediaType: 'movie' | 'tv' | 'season',
  onError: ErrorCallback
) {
  if (pathsService.isRemoteLibrary()) {
    onError({
      title: 'Operation Not Supported',
      message: 'Applying metadata is not available for read-only remote libraries.'
    })
    return
  }
  if (!db?.root) return
  markAsUserEdited(itemId, db.root)
  const item = findItemById(itemId, db.root)
  if (!item) return
  const settings = await settingsService.readSettings()
  const libraryDataPath = pathsService.getLibraryDataPath()
  if (!settings.tmdbApiKey) return
  setBulkUpdateStatus(true)
  try {
    item.overview = null
    item.year = null
    item.genres = []
    if (item.type === 'file') item.opensAsFolder = true
    item.posterPath = undefined
    item.backdropPath = undefined
    item.logoPath = undefined
    item.tmdbDetailsFetched = false
    item.tmdbCreditsFetched = false
    item.tmdbCredits = null
    if (item.type === 'folder' && mediaType === 'tv') {
      item.tmdbSeasons = null
      item.tmdbEpisodesFetched = false
      for (const season of item.children) {
        if (season.type === 'folder' && season.mediaType === 'season') {
          season.tmdbDetailsFetched = false
          season.tmdbEpisodesFetched = undefined
          for (const episode of season.children) {
            if (episode.type === 'file' && episode.mediaType === 'episode')
              episode.posterPath = undefined
          }
        }
      }
    }
    if (mediaType === 'season' && item.type === 'folder') {
      item.mediaType = 'season'
      item.title = result.name
      item.overview = result.overview
      item.seasonNumber = result.season_number
      if (result.poster_path) {
        const posterUrl = `https://image.tmdb.org/t/p/w500${result.poster_path}`
        const posterDestPath = path.join(pathsService.getLibraryDataPath(), 'images', `${item.id}.jpg`)
        try {
          await retrieverService.downloadImage(posterUrl, posterDestPath)
          item.posterPath = `${item.id}.jpg`
        } catch (e) {
          console.error('Failed to download season poster', e)
        }
      }
      item.tmdbDetailsFetched = true
      item.tmdbEpisodesFetched = undefined
      const episodeFiles = item.children.filter((c) => c.type === 'file') as MediaFile[]
      if (!episodeFiles.some((ef) => typeof ef.episodeNumber !== 'undefined')) {
        if (!processAndAssignEpisodeNumbers(episodeFiles, item.seasonNumber)) {
          episodeFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
          episodeFiles.forEach((file, index) => {
            file.episodeNumber = index + 1
            file.seasonNumber = item.seasonNumber
            file.mediaType = 'episode'
          })
        }
      }
      const showFolder = findParent(item.id, db!.root!)
      if (showFolder?.tmdbId && settings.tmdbApiKey) {
        if (!showFolder.tmdbDetailsFetched)
          await retrieverService.fetchItemDetails(showFolder, settings, libraryDataPath)
        await retrieverService.fetchAndApplyEpisodeData(
          item,
          showFolder.tmdbId,
          settings.tmdbApiKey,
          libraryDataPath,
          showFolder.tmdbSeasons
        )
      }
    } else {
      item.tmdbId = result.id
      item.mediaType = mediaType
      item.title = result.title
      if (item.type === 'folder' && mediaType === 'tv' && item.process_tv_children !== false) {
        processTvShowStructure(item as MediaFolder)
      }
      await retrieverService.fetchItemDetails(item, settings, libraryDataPath)
      if (mediaType === 'movie' || mediaType === 'tv')
        await retrieverService.fetchAndApplyCredits(item, settings.tmdbApiKey)
    }
  } finally {
    setBulkUpdateStatus(false)
  }
  item._v = Date.now()
  item.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(item, settings)
  await _finalizeItemUpdate(item, { updateSuggestions: true })
}

export async function markAsUnwatched(itemId: string): Promise<void> {
  if (!db?.root) return
  const item = findItemById(itemId, db.root)
  if (!item) return
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
      if (wasModified) modifiedItems.push(node)
      if (node.children) node.children.forEach(setUnwatchedRecursively)
    }
  }
  setBulkUpdateStatus(true)
  setUnwatchedRecursively(item)
  setBulkUpdateStatus(false)
  if (modifiedItems.length > 0) {
    searchService.updateIndexForItems(modifiedItems)
    await _finalizeItemUpdate(modifiedItems, { updateSuggestions: false })
  }
}

export async function markAsWatched(itemId: string): Promise<void> {
  if (!db?.root) return
  const item = findItemById(itemId, db.root)
  if (!item) return
  const modifiedItems: LibraryItem[] = []
  function setWatchedRecursively(node: LibraryItem) {
    if (node.type === 'file' && !node.watched) {
      node.watched = true
      ;(node as MediaFile).lastWatched = Date.now()
      modifiedItems.push(node)
    }
    if (node.type === 'folder' && node.children) node.children.forEach(setWatchedRecursively)
  }
  setBulkUpdateStatus(true)
  setWatchedRecursively(item)
  setBulkUpdateStatus(false)
  if (modifiedItems.length > 0) {
    searchService.updateIndexForItems(modifiedItems)
    await _finalizeItemUpdate(modifiedItems, { updateSuggestions: false })
  }
}

export async function assignSeasonsAndEpisodes(
  showId: string,
  seasonStrategy: 'smart' | 'alphabetic',
  episodeStrategy: 'smart' | 'alphabetic',
  fetchMetadata: boolean
) {
  if (!db?.root) return
  const show = findItemById(showId, db.root)
  if (!show || show.type !== 'folder') return
  log(`[Assign Seasons] Starting assignment for "${show.name}"...`)
  setBulkUpdateStatus(true)
  try {
    const modifiedItems = new Set<LibraryItem>()
    modifiedItems.add(show)
    log(`[Assign Seasons] Clearing old season/episode data...`)
    show.tmdbSeasons = undefined
    show.tmdbEpisodesFetched = undefined
    const imagesDir = path.join(pathsService.getLibraryDataPath(), 'images')
    await clearTvStructureMetadata(show, imagesDir, modifiedItems)
    log(`[Assign Seasons] Assigning new data with strategy: ${seasonStrategy}/${episodeStrategy}`)
    _assignSeasonsAndEpisodesByStrategy(show, seasonStrategy, episodeStrategy)
    getAllItemsAsList(show, []).forEach((item) => modifiedItems.add(item))
    const settings = await settingsService.readSettings()
    if (fetchMetadata || show.process_tv_children !== false) {
      log(`[Assign Seasons] Triggering targeted season fetch for "${show.name}"...`)
      const fetchedItems = await retrieverService.refetchShowSeasons(
        show,
        settings,
        pathsService.getLibraryDataPath()
      )
      for (const item of fetchedItems) modifiedItems.add(item)
    }
    log(
      `[Assign Seasons] Re-applying virtual tags and re-indexing for ${modifiedItems.size} items...`
    )
    for (const item of modifiedItems) {
      item.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(item, settings)
      searchService.updateIndexForItem(item)
    }
    setBulkUpdateStatus(false)
    log(`[Assign Seasons] Finalizing update for ${modifiedItems.size} items...`)
    await _finalizeItemUpdate(Array.from(modifiedItems), { updateSuggestions: true })
    log(`[Assign Seasons] Assignment complete for "${show.name}".`)
  } catch (error) {
    console.error(`[Assign Seasons] Failed during assignment for show ${showId}:`, error)
    setBulkUpdateStatus(false)
  }
}

export async function setImage(
  itemId: string,
  imageType: 'poster' | 'backdrop' | 'logo',
  source: { type: 'tmdb'; path: string } | { type: 'local'; path: string },
  onError: ErrorCallback
) {
  if (pathsService.isRemoteLibrary()) {
    onError({
      title: 'Operation Not Supported',
      message: 'Setting images is not available for remote libraries.'
    })
    return
  }
  if (!db?.root) return
  markAsUserEdited(itemId, db.root)
  const item = findItemById(itemId, db.root)
  if (!item) return
  const imagesDir = path.join(pathsService.getLibraryDataPath(), 'images')
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
      if (imageType === 'poster' || imageType === 'logo') size = 'w500'
      const url = `https://image.tmdb.org/t/p/${size}${source.path}`
      await retrieverService.downloadImage(url, destPath)
    } else {
      await fs.copyFile(source.path, destPath)
    }
    if (imageType === 'poster') item.posterPath = fileName
    else if (imageType === 'backdrop') item.backdropPath = fileName
    else if (imageType === 'logo') item.logoPath = fileName
    item._v = Date.now()
    await _finalizeItemUpdate(item, { updateSuggestions: false })
  } catch (err) {
    console.error(`Failed to set image for ${itemId}:`, err)
    onError({
      title: 'Image Error',
      message: 'Failed to set the selected image. See logs for more details.'
    })
  }
}

export async function removeImage(itemId: string, imageType: 'poster' | 'backdrop' | 'logo') {
  if (!db?.root) return
  const item = findItemById(itemId, db.root)
  if (!item) return
  if (imageType === 'poster') item.posterPath = null
  else if (imageType === 'backdrop') item.backdropPath = null
  else if (imageType === 'logo') item.logoPath = null
  item._v = Date.now()
  await _finalizeItemUpdate(item, { updateSuggestions: false })
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

export async function handleItemRemovedByPath(relativePath: string): Promise<void> {
  if (!db?.root) return
  const item = findItemByPath(relativePath, db.root)
  if (!item) return
  const parent = findParent(item.id, db.root)
  if (!parent) return
  const itemIndex = parent.children.findIndex((c) => c.id === item.id)
  if (itemIndex === -1) return
  parent.children.splice(itemIndex, 1)
  searchService.removeItemAndDescendantsFromIndex(item)
  await writeDb(db)
  getTransport().notifyLibraryItemDeleted(item.id)
}

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

export async function handleItemRenamed(relativeOldPath: string, newName: string): Promise<void> {
  if (!db?.root) return
  const itemToRename = findItemByPath(relativeOldPath, db.root)
  if (!itemToRename) throw new Error(`[Rename] Could not find item in DB: ${relativeOldPath}`)
  setBulkUpdateStatus(true)
  const parent = findParent(itemToRename.id, db.root)
  if (!parent) {
    setBulkUpdateStatus(false)
    throw new Error(`[Rename] Could not find parent for item: ${itemToRename.name}`)
  }
  const settings = await settingsService.readSettings()
  function updatePathsAndIds(item: LibraryItem, newParentPath: string) {
    searchService.removeItemAndDescendantsFromIndex(item)
    if (item.path === relativeOldPath) item.name = newName
    item.path = path.join(newParentPath, item.name).replace(/\\/g, '/')
    item.id = generateId(item.path)
    item.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(item, settings)
    if (item.type === 'folder')
      item.children.forEach((child) => updatePathsAndIds(child, item.path))
    searchService.updateIndexForItem(item)
  }
  updatePathsAndIds(itemToRename, parent.path === '.' ? '' : parent.path)
  setBulkUpdateStatus(false)
  await writeDb(db)
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

export const performSearch = searchService.performSearch
export const debugPerformSearch = searchService.debugPerformSearch

export async function deleteItemFromDb(itemId: string): Promise<boolean> {
  if (!db || !db.root) return false
  const parent = findParent(itemId, db.root)
  if (!parent) return false
  const itemIndex = parent.children.findIndex((c) => c.id === itemId)
  if (itemIndex === -1) return false
  const [itemToDelete] = parent.children.splice(itemIndex, 1)
  searchService.removeItemAndDescendantsFromIndex(itemToDelete)
  await writeDb(db)
  getTransport().notifyLibraryItemDeleted(itemId)
  return true
}

export async function getItemById(itemId: string): Promise<LibraryItem | null> {
  if (!db || !db.root) return null
  const item = findItemById(itemId, db.root)
  return item ? createShallowClonableCopy(item) : null
}

export async function getChildren(parentId: string): Promise<LibraryItem[] | null> {
  if (!db || !db.root) return null
  const parent = findItemById(parentId, db.root)
  if (!parent || parent.type !== 'folder') return null
  return parent.children.map((child) => createShallowClonableCopy(child))
}

export async function getParent(itemId: string): Promise<MediaFolder | null> {
  if (!db || !db.root) return null
  const parent = findParent(itemId, db.root)
  return parent ? JSON.parse(JSON.stringify(parent)) : null
}

export async function getHiddenChildren(parentId: string): Promise<LibraryItem[]> {
  if (!db || !db.root) return []
  const parent = findItemById(parentId, db.root)
  if (!parent || parent.type !== 'folder') return []
  const hiddenChildren = parent.children.filter((child) => child.isHidden)
  return JSON.parse(JSON.stringify(hiddenChildren))
}

export async function setContinueWatchingDismissed(showId: string) {
  if (!db?.root) return
  const show = findItemById(showId, db.root)
  if (show && show.type === 'folder') {
    show.continueWatchingDismissed = true
    await _finalizeItemUpdate(show, { updateSuggestions: false })
  }
}

export async function setNextUpDismissed(showId: string) {
  if (!db?.root) return
  const show = findItemById(showId, db.root)
  if (show && show.type === 'folder') {
    show.nextUpDismissed = true
    show.continueWatchingDismissed = true
    await _finalizeItemUpdate(show, { updateSuggestions: false })
  }
}

export async function getContinueWatchingItems(): Promise<
  { show: MediaFolder; nextEpisode: MediaFile }[]
> {
  if (!db?.root) return []
  const allItems = getAllItemsAsList(db.root)
  const parentMap = new Map<string, string>()
  function buildParentMap(node: MediaFolder) {
    if (!node.children) return
    for (const child of node.children) {
      parentMap.set(child.id, node.id)
      if (child.type === 'folder') buildParentMap(child)
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
      let currentParentId = parentMap.get(item.id),
        showId: string | null = null
      while (currentParentId) {
        const parent = findItemById(currentParentId, db.root)
        if (parent?.type === 'folder' && parent.mediaType === 'tv') {
          showId = parent.id
          break
        }
        currentParentId = parentMap.get(currentParentId)
      }
      if (showId && episodesByShow.has(showId)) episodesByShow.get(showId)!.push(item as MediaFile)
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
  return continueWatchingItems
    .sort((a, b) => b.lastWatched - a.lastWatched)
    .map(({ show, nextEpisode }) => ({ show, nextEpisode }))
}

export async function getContinueWatchingForShow(
  showId: string
): Promise<{ show: MediaFolder; nextEpisode: MediaFile } | null> {
  if (!db?.root) return null
  const show = findItemById(showId, db.root)
  if (show?.type !== 'folder' || show.mediaType !== 'tv' || show.nextUpDismissed) return null
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
