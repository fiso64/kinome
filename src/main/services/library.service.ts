import path from 'path'
import crypto from 'crypto'
import equal from 'fast-deep-equal'

import * as virtualTagsService from './virtualTags.service'
import * as searchService from './search.service'
import * as retrieverService from './retriever.service'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import * as repositoryService from './repository.service'
// getDb import was removed to avoid linting errors if unused, or handled via repositoryService export
import * as filesystemService from './filesystem.service'
import * as tvShowService from './tv-show.service'
import * as actionsService from './actions.service'
import * as metadataService from './metadata.service'
import { closeDatabase } from '../database/client'
import {
  updateIfChangedAndBroadcast,
  getAutocompleteSuggestions as fetchAutocompleteSuggestions
} from './item-update.service'
import { getTransport } from '../transport.registry'

import { VIEW_SETTINGS_KEYS, METADATA_KEYS } from '../../shared/types'
import type { MediaFolder, LibraryItem, MediaFile, LibraryStatus } from '../../shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Library Service] ${message}`)
}

type ErrorCallback = (options: { title: string; message: string; detail?: string }) => void

// --- Helpers ---

// --- Core ---

export async function loadDbIntoMemory(): Promise<void> {
  await repositoryService.loadDb()

  searchService.buildFullSearchIndex()
}

export async function switchToLibrary(newPath: string): Promise<void> {
  pathsService.setLibraryDataPath(newPath)
  log(`Switching library data location to: ${newPath}`)

  // 1. Close current database connection
  closeDatabase()

  // 2. Update paths service
  pathsService.setLibraryDataPath(newPath)

  // 3. Re-initialize database at the new location
  await loadDbIntoMemory()

  log(`Successfully switched library to ${newPath}`)
}

export async function getLibraryRoot(providedPath?: string): Promise<LibraryStatus> {
  const currentSettings = await settingsService.readSettings()
  const pathToCheck = providedPath || currentSettings.libraryLocation

  if (!pathToCheck) {
    return { status: 'no_location' }
  }

  const discovery = await settingsService.checkLibraryExists(pathToCheck)

  if (!discovery.settingsExists) {
    return { status: 'no_settings' }
  }

  if (!discovery.dbExists) {
    return { status: 'db_missing', settings: discovery.settings }
  }

  // If DB exists, the root should exist (discovery.dbExists now checks for root)
  const root = repositoryService.getRoot()
  if (!root) {
    // This should technically not happen if discovery.dbExists is true, 
    // but we handle it for safety.
    return { status: 'db_missing', settings: discovery.settings }
  }

  root.children = []
  const item = repositoryService.createTransferableCopy(root) as MediaFolder

  return {
    status: 'ready',
    root: item,
    settings: discovery.settings
  }
}

export async function refreshLibrary(): Promise<MediaFolder | null> {
  if (pathsService.isRemoteLibrary())
    throw new Error('Refreshing not available for remote libraries.')
  const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
  if (!mediaSourcePath) throw new Error('Cannot refresh, no library configured.')

  const refreshId = crypto.randomBytes(4).toString('hex')
  log(`[Refresh ${refreshId}] Starting refresh from: ${mediaSourcePath}`)

  getTransport().notifyScanStatusChanged({ isFileScanningLibrary: true })
  try {
    await filesystemService.scanDirectory(mediaSourcePath)

    const imagesDir = path.join(pathsService.getLibraryDataPath(), 'images')
    await filesystemService.verifyImagePaths(imagesDir)

    searchService.buildFullSearchIndex()

    metadataService.fetchMetadataForLibrary().catch(console.error)

    await reapplyVirtualTagsAfterSettingsChange()
  } finally {
    getTransport().notifyScanStatusChanged({ isFileScanningLibrary: false })
  }

  return (await getLibraryRoot()).root || null
}

async function _scanAndCreateNewDb(
  mediaSourcePath: string,
  scanType: 'Initial Scan' | 'Full Rescan'
): Promise<MediaFolder | null> {
  if (pathsService.isRemoteLibrary())
    throw new Error(`${scanType} not available for remote libraries.`)
  log(`Starting ${scanType} of: ${mediaSourcePath}`)

  const settings = await settingsService.readSettings()
  let pathToSave = mediaSourcePath
  if (settings.mediaSourcePathIsRelative) {
    const libraryPath = pathsService.getLibraryDataPath()
    let relative = path.relative(path.dirname(libraryPath), mediaSourcePath)
    relative = relative.replace(/\\/g, '/')
    pathToSave = relative === '' ? '.' : relative.startsWith('../') ? relative : './' + relative
  }
  await settingsService.writeLibrarySettings({ mediaSourcePath: pathToSave })

  if (scanType === 'Full Rescan') {
    await repositoryService.createNewDb(null)
  }

  getTransport().notifyScanStatusChanged({ isFileScanningLibrary: true })
  try {
    await filesystemService.scanDirectory(mediaSourcePath, { skipMetadata: true })
    searchService.buildFullSearchIndex()
    await reapplyVirtualTagsAfterSettingsChange()
  } finally {
    getTransport().notifyScanStatusChanged({ isFileScanningLibrary: false })
  }

  const status = await getLibraryRoot()
  const root = status.root
  if (!root) return null

  return repositoryService.getFullFolderTree(root)
}

export const performInitialScan = (path: string) => _scanAndCreateNewDb(path, 'Initial Scan')
export const performFullRescan = (path: string) => _scanAndCreateNewDb(path, 'Full Rescan')

// --- Items ---

// This must be read-only.
export async function getItemDetails(itemId: string, fields?: string[]): Promise<LibraryItem | null> {
  const item = repositoryService.getItemById(itemId)
  if (!item) throw new Error(`Item ${itemId} not found.`)

  return repositoryService.createForDetailViewCopy(item, fields)
}

export async function getItemChildren(
  itemId: string,
  options: { isDetailView?: boolean; fields?: string[] } = {}
): Promise<LibraryItem[]> {
  if (options.isDetailView) {
    return repositoryService.getChildrenForDetailView(itemId, options.fields)
  }

  // Fallback to standard children logic if not in detail view context
  return repositoryService.getChildren(itemId, options.fields)
}

// --- Watched State ---

export async function markAsUnwatched(itemId: string): Promise<void> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return

  const descendants = repositoryService.getAllDescendantsAsList(item as MediaFolder)
  const itemsToUpdate = [item, ...descendants]

  for (const i of itemsToUpdate) {
    i.watched = false
    i.lastWatched = undefined
    if (i.type === 'folder') {
      i.continueWatchingDismissed = false
      i.nextUpDismissed = false
    }
  }

  await updateIfChangedAndBroadcast(itemsToUpdate)
}

async function checkAndUndismissShow(
  showId: string,
  newlyWatchedEpisodes: MediaFile[]
): Promise<MediaFolder | null> {
  const show = repositoryService.getItemById(showId) as MediaFolder
  if (!show || show.mediaType !== 'tv') return null

  // Optimization: If not dismissed, don't waste time calculating logic
  if (!show.nextUpDismissed && !show.continueWatchingDismissed) return null

  // Condition 1: Must be a NEW watch
  if (newlyWatchedEpisodes.length === 0) return null

  // Condition 2: Must be the GREATEST episode among all watched episodes

  // Get all episodes for this show (flattened list)
  const descendants = repositoryService.getAllDescendantsAsList(show)
  const allEpisodes = descendants.filter(
    (d) => d.type === 'file' && d.mediaType === 'episode'
  ) as MediaFile[]

  // Helper to convert S01E01 to comparable integer 10001
  const getComparable = (ep: MediaFile) => (ep.seasonNumber ?? 0) * 10000 + (ep.episodeNumber ?? 0)

  // Find the max comparable of the NEWLY watched episodes
  const maxNewVal = newlyWatchedEpisodes.reduce((max, curr) => {
    return Math.max(max, getComparable(curr))
  }, 0)

  // Find the max comparable of ALL watched episodes (including the ones we just updated in memory)
  const maxWatchedVal = allEpisodes.reduce((max, curr) => {
    if (!curr.watched) return max
    return Math.max(max, getComparable(curr))
  }, 0)

  // If the new episode is the greatest (or tied for greatest), un-dismiss
  if (maxNewVal >= maxWatchedVal) {
    show.nextUpDismissed = false
    show.continueWatchingDismissed = false
    return show
  }

  return null
}

export async function markAsWatched(itemId: string): Promise<void> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return

  const descendants = repositoryService.getAllDescendantsAsList(item as MediaFolder)
  const itemsToUpdate = [item, ...descendants]

  // Track which episodes are being flipped from Unwatched -> Watched
  const newlyWatchedEpisodes: MediaFile[] = []

  for (const i of itemsToUpdate) {
    if (i.type === 'file') {
      if (!i.watched && i.mediaType === 'episode') {
        newlyWatchedEpisodes.push(i as MediaFile)
      }
      i.watched = true
      i.lastWatched = Date.now()
    }
  }

  // --- Logic for Un-Dismissing ---
  // Find the parent Show to run checks against
  let parent =
    item.type === 'folder' && item.mediaType === 'tv'
      ? (item as MediaFolder)
      : repositoryService.findParent(item.id)

  // Traverse up if we selected a Season or Episode
  while (parent && (parent.type !== 'folder' || parent.mediaType !== 'tv')) {
    parent = repositoryService.findParent(parent.id)
  }

  if (parent) {
    const showToUpdate = await checkAndUndismissShow(parent.id, newlyWatchedEpisodes)
    if (showToUpdate) {
      // Ensure we don't duplicate the show in the update list if it was the target
      if (!itemsToUpdate.find((i) => i.id === showToUpdate.id)) {
        itemsToUpdate.push(showToUpdate)
      }
    }
  }

  await updateIfChangedAndBroadcast(itemsToUpdate)
}

// --- Continue Watching ---

export async function getContinueWatchingItems(
  includeDismissed = false
): Promise<{ show: MediaFolder; nextEpisode: MediaFile }[]> {
  const allItems = repositoryService.getAllItemsAsList()
  if (allItems.length === 0) return []

  // Reconstruct hierarchy efficiently
  const parentMap = new Map<string, string>()
  const db = repositoryService.getDb()
  const adjacency = db.prepare('SELECT id, parent_id FROM items').all() as {
    id: string
    parent_id: string
  }[]
  adjacency.forEach((a) => parentMap.set(a.id, a.parent_id))

  const shows: MediaFolder[] = []
  for (const item of allItems) {
    if (item.type === 'folder' && item.mediaType === 'tv') {
      if (includeDismissed || !item.continueWatchingDismissed) {
        shows.push(item as MediaFolder)
      }
    }
  }

  const results: { show: MediaFolder; nextEpisode: MediaFile; lastWatched: number }[] = []

  for (const show of shows) {
    const episodes: MediaFile[] = []

    for (const item of allItems) {
      if (item.type === 'file' && item.mediaType === 'episode') {
        let currentId = item.id
        let isChild = false
        for (let i = 0; i < 3; i++) {
          const pid = parentMap.get(currentId)
          if (!pid) break
          if (pid === show.id) {
            isChild = true
            break
          }
          currentId = pid
        }
        if (isChild) episodes.push(item as MediaFile)
      }
    }

    if (episodes.length === 0) continue

    const watchedEpisodes = episodes.filter((e) => e.watched)
    if (watchedEpisodes.length === 0) continue

    const getComparable = (ep: MediaFile) =>
      (ep.seasonNumber ?? 0) * 10000 + (ep.episodeNumber ?? 0)
    episodes.sort((a, b) => getComparable(a) - getComparable(b))

    let maxWatchedIdx = -1
    for (let i = 0; i < episodes.length; i++) {
      if (episodes[i].watched) {
        if (
          maxWatchedIdx === -1 ||
          getComparable(episodes[i]) > getComparable(episodes[maxWatchedIdx])
        ) {
          maxWatchedIdx = i
        }
      }
    }

    let nextEpisode: MediaFile | undefined
    for (let i = 0; i < episodes.length; i++) {
      if (
        !episodes[i].watched &&
        getComparable(episodes[i]) > getComparable(episodes[maxWatchedIdx])
      ) {
        nextEpisode = episodes[i]
        break
      }
    }

    if (nextEpisode) {
      if (!nextEpisode.title) {
        const updatedItems = await metadataService.fetchEpisodeDataForContinueWatching(
          show,
          nextEpisode
        )
        if (updatedItems.length > 0) {
          await updateIfChangedAndBroadcast(updatedItems)
        }
        const fresh = repositoryService.getItemById(nextEpisode.id) as MediaFile
        if (fresh) Object.assign(nextEpisode, fresh)
      }

      const lastWatchedTime = Math.max(0, ...watchedEpisodes.map((e) => e.lastWatched ?? 0))
      results.push({
        show: repositoryService.createTransferableCopy(show) as MediaFolder,
        nextEpisode: repositoryService.createTransferableCopy(nextEpisode) as MediaFile,
        lastWatched: lastWatchedTime
      })
    }
  }

  return results
    .sort((a, b) => b.lastWatched - a.lastWatched)
    .map((r) => ({ show: r.show, nextEpisode: r.nextEpisode }))
}

// --- Passthroughs ---

export const autocompleteSuggestions = fetchAutocompleteSuggestions
export const getAutocompleteSuggestions = fetchAutocompleteSuggestions
export const getGroupByKeys = async () => {
  return (await import('./item-update.service')).getGroupByKeys()
}
export const getAutocompleteValues = async (key: string, query?: string, limit?: number) => {
  return (await import('./item-update.service')).getAutocompleteValues(key, query, limit)
}

export const performSearch = searchService.performSearch
export const debugPerformSearch = searchService.debugPerformSearch
export const manualSearch = retrieverService.manualSearch
export const getTmdbImages = retrieverService.getTmdbImages
export const executeCustomAction = actionsService.executeCustomAction
export const getAbsolutePath = actionsService.getAbsolutePath
export const getItemProperties = actionsService.getItemProperties
export const revealInExplorer = actionsService.revealInExplorer
export const trashItem = actionsService.trashItem
export const renameItem = actionsService.renameItem
export const getItemById = async (id: string) => {
  const item = repositoryService.getItemById(id)
  return item ? repositoryService.createTransferableCopy(item) : null
}
export const getParent = async (id: string) => {
  const parent = repositoryService.findParent(id)
  return parent ? repositoryService.createTransferableCopy(parent) : null
}
export const getChildren = async (id: string) => {
  const children = repositoryService.getChildren(id)
  return children.filter((c) => !c.isHidden).map(repositoryService.createTransferableCopy)
}
export const getHiddenChildren = async (parentId: string): Promise<LibraryItem[]> => {
  const children = repositoryService.getChildren(parentId)
  return children.filter((c) => c.isHidden)
}
export const assignSeasonsAndEpisodes = async (
  showId: string,
  seasonStrategy: 'smart' | 'alphabetic',
  episodeStrategy: 'smart' | 'alphabetic',
  fetchMetadata: boolean
) => {
  log(
    `[Library] manual assignment triggered for show ${showId}. Strategies: S=${seasonStrategy}, E=${episodeStrategy}, Fetch=${fetchMetadata}`
  )

  const show = repositoryService.getItemById(showId) as MediaFolder
  if (!show || show.mediaType !== 'tv') {
    throw new Error(`Item ${showId} is not a valid TV Show.`)
  }

  // 1. Sync Structure (Internal persistence handled)
  await tvShowService.syncTvShowStructure(show, seasonStrategy, episodeStrategy, { force: true })

  // 2. Fetch Metadata if requested (Internal persistence handled)
  if (fetchMetadata) {
    // Run enrichment in the background to allow the UI to close immediately
    metadataService.backgroundFetchAndApplyDetails(show, { force: true }).catch((err) => {
      console.error(`[Library] Background assignment enrichment failed for "${show.name}":`, err)
    })
  }

  log(`[Library] Assignment complete for show ${showId}.`)
}
export const clearItemMetadata = (
  itemId: string,
  childrenOnly: boolean
) => metadataService.clearItemMetadata(itemId, { childrenOnly })
export const clearVirtualFolderMetadata = metadataService.clearVirtualFolderMetadata

export const applyManualMatch = async (
  itemId: string,
  result: any,
  mediaType: 'movie' | 'tv' | 'season'
) => {
  await metadataService.applyManualMatch(itemId, result, mediaType)
}

export const setImage = async (
  itemId: string,
  imageType: 'poster' | 'backdrop' | 'logo',
  source: { type: 'tmdb'; path: string } | { type: 'local'; path: string }
) => {
  const item = await metadataService.setImage(itemId, imageType, source)
  if (item) {
    // Use unified update path to ensure fields are locked automatically
    await updateItem(item, true)
  }
}

export const removeImage = async (itemId: string, imageType: 'poster' | 'backdrop' | 'logo') => {
  const item = await metadataService.removeImage(itemId, imageType)
  if (item) {
    // Use unified update path to ensure fields are locked automatically
    await updateItem(item, true)
  }
}

export const uploadImage = async (
  itemId: string,
  imageType: 'poster' | 'backdrop' | 'logo',
  file: File
) => {
  const buffer = await file.arrayBuffer()
  const item = await metadataService.setImage(itemId, imageType, {
    type: 'local',
    path: '', // Not used if we pass the buffer
    buffer: Buffer.from(buffer),
    originalName: file.name
  } as any)

  if (item) {
    await updateItem(item, true)
  }
}
export const getContinueWatchingForShow = async (showId: string) => {
  const all = await getContinueWatchingItems(true) // Include dismissed so we can show "Next Up" even if removed from Home
  const found = all.find((r) => r.show.id === showId)
  // For the detail view, we filter by nextUpDismissed here or let the UI handle it.
  // Ideally we return it and let UI decide, but to be safe let's return null if nextUpDismissed is true
  if (found && found.show.nextUpDismissed) return null
  return found || null
}
export const setContinueWatchingDismissed = async (showId: string) => {
  const item = repositoryService.getItemById(showId)
  if (item) {
    item.continueWatchingDismissed = true
    await updateIfChangedAndBroadcast(item)
  }
}
export const setNextUpDismissed = async (showId: string) => {
  const item = repositoryService.getItemById(showId)
  if (item) {
    item.nextUpDismissed = true
    item.continueWatchingDismissed = true
    await updateIfChangedAndBroadcast(item)
  }
}
export const fetchCredits = async (itemId: string) => {
  const item = repositoryService.getItemById(itemId)
  if (item) {
    await retrieverService.fetchAndApplyCredits(
      item,
      (await settingsService.readSettings()).tmdbApiKey
    )
    await updateIfChangedAndBroadcast(item)
  }
}
export const handleItemRenamed = async (oldPath: string, _newName: string) => {
  const oldItem = repositoryService.findItemByPath(oldPath)
  if (!oldItem) return
  const parent = repositoryService.findParent(oldItem.id)
  if (parent) {
    const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
    if (mediaSourcePath) {
      await filesystemService.syncWithDisk(parent, mediaSourcePath)
      getTransport().forceRendererReload()
    }
  }
}
export const updateItem = async (item: LibraryItem, isUser: boolean) => {
  // --- Check for Virtual Folder Redirection ---
  // --- Check for Virtual Folder Redirection ---
  if (item.id.startsWith('virtual--')) {
    log(`Redirection triggered for virtual item: ${item.id}`)

    // Manual Parse or use Repository Helper? 
    // We can just split manually here to keep it self-contained or use the helper if available.
    // Let's match repository.service logic for consistency.
    const parts = item.id.split('--')
    // virtual--{parentId}--{token1}--{token2}...
    const physicalParentId = parts[1]
    const tokens = parts.slice(2)

    if (physicalParentId && tokens.length > 0) {
      const parent = repositoryService.getItemById(physicalParentId) as MediaFolder
      if (parent) {
        // Prepare settings to save
        const settingsToSave: Partial<MediaFolder> = {}
        for (const key of VIEW_SETTINGS_KEYS) {
          if ((item as any)[key] !== undefined) {
            ; (settingsToSave as any)[key] = (item as any)[key]
          }
        }

        // Key for settings: "token1/token2"
        const settingsKey = tokens.join('/')

        // Update virtual settings on physical parent
        if (!parent.virtualFolderSettings) parent.virtualFolderSettings = {}

        // We store it flat in the JSON, keyed by the full path?
        // Wait, spec said: { "genre:Animation": {...}, "genre:Animation/year:2024": {...} }
        // The previous implementation was nested: parent.virtualFolderSettings[groupByKey][groupByValue]
        // This new implementation is FLAT (keyed by path string) or NESTED?
        // The spec says:
        // {
        //   "genre:Animation": { ... },
        //   "genre:Animation/year:2024": { ... }
        // }
        // This looks like a Flat Map where the key is the path string.
        // My previous implementation was: parent.virtualFolderSettings[groupByKey][groupByValue] (Nested Object)
        // I am changing the schema here to a Flat Map style for flexibility.

        // Apply Normalization: groupBy is only valid for 'tabs' and 'sections'
        if (settingsToSave.layout && !['tabs', 'sections'].includes(settingsToSave.layout)) {
          // @ts-ignore
          settingsToSave.groupBy = null
        }
        if (settingsToSave.childViewSettings?.layout && !['tabs', 'sections'].includes(settingsToSave.childViewSettings.layout)) {
          // @ts-ignore
          settingsToSave.childViewSettings.groupBy = null
        }

        parent.virtualFolderSettings[settingsKey] = settingsToSave

        // Propagate update to renderer (both the virtual item's "bare" state and the parent)
        // Note: Renderer's MediaView will re-generate the virtual items from the updated parent.
        await updateIfChangedAndBroadcast([parent, item])
        return
      }
    }
  }

  // --- Standard Item Update with Robust Locking ---
  const existing = repositoryService.getItemById(item.id)
  if (existing && isUser) {
    let currentLocks = new Set(existing.lockedFields ?? [])

    // 1. Handle explicit lock toggles if provided in payload (Map: { field: boolean })
    if ((item as any).lockedFields && typeof (item as any).lockedFields === 'object' && !Array.isArray((item as any).lockedFields)) {
      const explicitLocks = (item as any).lockedFields as Record<string, boolean>
      for (const [field, isLocked] of Object.entries(explicitLocks)) {
        if (isLocked) {
          currentLocks.add(field)
        } else {
          currentLocks.delete(field)
        }
      }
      // Delete the map from the item to avoid it being interpreted as the final array by the repository
      delete (item as any).lockedFields
    }

    // 2. Automatic Locking for Metadata Fields
    // If a field is present in the partial update and differs from the DB, we lock it.
    for (const key of METADATA_KEYS) {
      const newValue = (item as any)[key]
      const oldValue = (existing as any)[key]

      if (newValue !== undefined) {
        // Use deep equality check for non-primitive types (arrays/objects)
        // to avoid locking fields due to new reference identity from DB fetch.
        const isPrimitive = typeof newValue !== 'object' || newValue === null
        const isChanged = isPrimitive ? (newValue !== oldValue) : !equal(newValue, oldValue)

        if (isChanged) {
          // If the update is specifically trying to revert to Name (Folder Name),
          // we might want a safeguard, but with partial updates, the frontend only sends
          // title if the user actively edited it.
          currentLocks.add(key)
          log(`[Auto-Lock] Locking field "${key}" for item "${existing.name}" due to user update.`)
        }
      }
    }

    // Convert back to array for repository persistence
    item.lockedFields = Array.from(currentLocks)
  }

  // --- Normalization ---
  // Ensure groupBy is null if the layout doesn't support it
  const anyItem = item as any
  const isGroupingLayout = ['tabs', 'sections'].includes(anyItem.layout as string)
  if (anyItem.layout !== undefined && !isGroupingLayout) {
    anyItem.groupBy = null
  }
  // Also normalize childViewSettings if present
  if (anyItem.childViewSettings?.layout && !['tabs', 'sections'].includes(anyItem.childViewSettings.layout)) {
    anyItem.childViewSettings.groupBy = null
  }

  // --- Standard Item Update ---
  await updateIfChangedAndBroadcast(item)
}
export const deleteItemFromDb = async (id: string) => {
  const res = repositoryService.deleteItem(id)
  if (res) {
    // searchService.removeItemFromIndex(id) - Removed, handled by FTS triggers
    getTransport().notifyLibraryItemDeleted(id)
    return true
  }
  return false
}

export const recordPlayback = async (itemId: string) => {
  const item = repositoryService.getItemById(itemId)
  if (!item) return

  const modifiedItems: LibraryItem[] = []

  // Check if it was NEW before we mark it
  const isNewWatch = !item.watched

  // Update item state
  item.watched = true
  item.lastWatched = Date.now()
  modifiedItems.push(item)

  // --- Logic for Un-Dismissing ---
  let parent = repositoryService.findParent(itemId)
  while (parent && (parent.type !== 'folder' || parent.mediaType !== 'tv')) {
    parent = repositoryService.findParent(parent.id)
  }

  if (parent && isNewWatch && item.mediaType === 'episode') {
    const showToUpdate = await checkAndUndismissShow(parent.id, [item as MediaFile])
    if (showToUpdate) {
      modifiedItems.push(showToUpdate)
    }
  }

  await updateIfChangedAndBroadcast(modifiedItems)
}

export const playFileWith = async (file: MediaFile, cmd: string, cb: ErrorCallback) => {
  return await actionsService.playFileWith(file, cmd, cb)
}
export const playFile = async (file: MediaFile, cb: ErrorCallback) => {
  const settings = await settingsService.readSettings()
  return playFileWith(file, settings.playerCommands[0]?.command || '', cb)
}
export const handleItemRemovedByPath = async (p: string) => {
  const item = repositoryService.findItemByPath(p)
  if (item) {
    repositoryService.deleteItem(item.id)
    // searchService.removeItemFromIndex(item.id) - Removed, handled by FTS triggers
    getTransport().notifyLibraryItemDeleted(item.id)
  }
}

// Missing Exports
export const applyInitialFolderSettings = async (
  settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]
) => {
  const itemsToUpdate: LibraryItem[] = []
  for (const s of settings) {
    const item = repositoryService.getItemById(s.id)
    if (item && item.type === 'folder') {
      const folder = item as MediaFolder
      folder.retrieve_children_metadata = s.retrieve
      folder.children_type_hint = s.hint
      itemsToUpdate.push(folder)
    }
  }

  if (itemsToUpdate.length > 0) {
    await updateIfChangedAndBroadcast(itemsToUpdate)
  }
  metadataService.fetchMetadataForLibrary().catch(console.error)
}

export const reapplyVirtualTagsAfterSettingsChange = async () => {
  const settings = await settingsService.readSettings()

  // 1. Apply tags in DB massively via SQL
  virtualTagsService.applyVirtualTags(settings.virtualTags)

  // 2. We need to broadcast the updates.
  const allItems = repositoryService.getAllItemsAsList()

  getTransport().notifyLibraryItemsUpdated(JSON.parse(JSON.stringify(allItems)))
  const [suggestions, groupByKeys] = await Promise.all([
    getAutocompleteSuggestions(),
    getGroupByKeys()
  ])
  getTransport().notifyMetadataIndexUpdated({ suggestions, groupByKeys })
}

export const getFolderWatchedState = async (
  folderId: string
): Promise<'fully' | 'partially' | 'unwatched' | 'none'> => {
  const folder = repositoryService.getItemById(folderId)
  if (!folder || folder.type !== 'folder') return 'none'
  const descendants = repositoryService.getAllDescendantsAsList(folder as MediaFolder)
  const files = descendants.filter((d) => d.type === 'file')
  if (files.length === 0) return 'none'
  const watchedCount = files.filter((f) => f.watched).length
  if (watchedCount === files.length) return 'fully'
  if (watchedCount > 0) return 'partially'
  return 'unwatched'
}

export async function getItemPath(itemId: string): Promise<string | null> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return null
  if (!item.path) return null
  return actionsService.getAbsolutePath(item.path)
}

export async function generatePlaylist(itemId: string): Promise<LibraryItem[]> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return []

  const parent = repositoryService.findParent(itemId)
  // If no parent (root item?) or item is orphan, just return the item itself
  if (!parent) return [item]

  // Get all siblings including the item itself
  const siblings = repositoryService
    .getChildren(parent.id)
    .filter((c) => c.type === 'file' && !c.isHidden && !c.isMissing)

  // Sort siblings:
  // 1. Season/Episode (if available)
  // 2. Name (Alphabetical)
  siblings.sort((a, b) => {
    // Cast to any to access optional properties safely
    const aS = (a as any).seasonNumber
    const bS = (b as any).seasonNumber
    const aE = (a as any).episodeNumber
    const bE = (b as any).episodeNumber

    // Sort by Season
    if (aS != null && bS != null && aS !== bS) return aS - bS
    if (aS != null && bS == null) return -1
    if (aS == null && bS != null) return 1

    // Sort by Episode
    if (aE != null && bE != null && aE !== bE) return aE - bE
    if (aE != null && bE == null) return -1
    if (aE == null && bE != null) return 1

    // Fallback to Name
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })

  // Find the index of the requested item
  const index = siblings.findIndex((s) => s.id === itemId)
  if (index === -1) return [item]

  // Return the item and all subsequent items (Next episodes)
  return siblings.slice(index)
}
