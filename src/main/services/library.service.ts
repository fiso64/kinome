import path from 'path'
import crypto from 'crypto'
import fs from 'fs/promises'

import * as virtualTagsService from './virtualTags.service'
import * as searchService from './search.service'
import * as retrieverService from './retriever.service'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import * as repositoryService from './repository.service'
import * as filesystemService from './filesystem.service'
import * as tvShowService from './tv-show.service'
import * as actionsService from './actions.service'
import * as metadataService from './metadata.service'

import type {
  MediaFolder,
  LibraryItem,
  MediaFile,
  AutocompleteSuggestions,
  Settings
} from '../../shared/types'
import { getTransport } from '../transport.registry'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Library Service] ${message}`)
}

type ErrorCallback = (options: { title: string; message: string; detail?: string }) => void

// =================================================================================================
// --- Centralized Update Finalization ---
// =================================================================================================

/**
 * Centralized helper to finalize an item update. It updates the search index,
 * saves the database, emits events for the transport layer, and updates suggestions.
 */
async function _finalizeItemUpdate(
  items: LibraryItem | LibraryItem[],
  options: { updateSuggestions?: boolean } = {}
): Promise<void> {
  if (!items || (Array.isArray(items) && items.length === 0)) return

  const itemsArray = Array.isArray(items) ? items : [items]

  // This is now the single point of truth for updating the search index from item mutations.
  searchService.updateIndexForItems(itemsArray)

  await repositoryService.writeDb()

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

// =================================================================================================
// --- Startup and Core Library Management ---
// =================================================================================================

export async function loadDbIntoMemory(): Promise<void> {
  await repositoryService.loadDb()
}

export async function getLibraryRoot(): Promise<MediaFolder | null> {
  const root = repositoryService.getRoot()
  return root ? (repositoryService.createTransferableCopy(root) as MediaFolder) : null
}

export async function refreshLibrary(): Promise<MediaFolder | null> {
  if (pathsService.isRemoteLibrary()) {
    throw new Error('Refreshing is not available for remote libraries.')
  }
  const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
  const root = repositoryService.getRoot()
  if (!root || !mediaSourcePath) {
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

  repositoryService.setBulkUpdateStatus(true)
  await filesystemService.syncWithDisk(root, mediaSourcePath)
  const t1 = performance.now()
  log(`[Refresh ${refreshId}] syncWithDisk took ${(t1 - t0).toFixed(2)}ms`)

  filesystemService.pruneUntouchedMissingItems(root)
  const t2 = performance.now()
  log(`[Refresh ${refreshId}] pruneUntouchedMissingItems took ${(t2 - t1).toFixed(2)}ms`)

  const imagesDir = path.join(pathsService.getLibraryDataPath(), 'images')
  await filesystemService.verifyImagePaths(root, imagesDir)
  const t3 = performance.now()
  log(`[Refresh ${refreshId}] verifyImagePaths took ${(t3 - t2).toFixed(2)}ms`)

  const currentSettings = await settingsService.readSettings()
  const allItems = repositoryService.getAllItemsAsList()
  allItems.forEach((item) => {
    item.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(item, currentSettings)
  })
  const t4 = performance.now()
  log(`[Refresh ${refreshId}] applyVirtualTagsToAllItems took ${(t4 - t3).toFixed(2)}ms`)

  searchService.buildFullSearchIndex(root)
  const t5 = performance.now()
  log(`[Refresh ${refreshId}] buildFullSearchIndex took ${(t5 - t4).toFixed(2)}ms`)
  repositoryService.setBulkUpdateStatus(false)

  await repositoryService.writeDb()
  const t6 = performance.now()
  log(`[Refresh ${refreshId}] writeDb took ${(t6 - t5).toFixed(2)}ms`)

  log(`[Refresh ${refreshId}] Library refresh and sync complete.`)
  metadataService
    .fetchMetadataForLibrary()
    .catch((err) => console.error('Background metadata fetch failed during refresh:', err))
  const t7 = performance.now()
  log(`[Refresh ${refreshId}] Total time before returning: ${(t7 - t0).toFixed(2)}ms`)

  return root ? (repositoryService.createTransferableCopy(root) as MediaFolder) : null
}

async function _scanAndCreateNewDb(
  mediaSourcePath: string,
  scanType: 'Initial Scan' | 'Full Rescan'
): Promise<MediaFolder | null> {
  if (pathsService.isRemoteLibrary()) {
    throw new Error(`${scanType} is not available for remote libraries.`)
  }
  log(`Starting ${scanType.toLowerCase()} of: ${mediaSourcePath}`)

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

  const rootNode = await filesystemService.scanDirectory(mediaSourcePath, mediaSourcePath)
  await repositoryService.createNewDb(rootNode)
  log(`${scanType}, DB write, and index build complete.`)

  const root = repositoryService.getRoot()
  return root ? (repositoryService.createTransferableCopy(root) as MediaFolder) : null
}

export async function performInitialScan(mediaSourcePath: string): Promise<MediaFolder | null> {
  return _scanAndCreateNewDb(mediaSourcePath, 'Initial Scan')
}

export async function performFullRescan(mediaSourcePath: string): Promise<MediaFolder | null> {
  return _scanAndCreateNewDb(mediaSourcePath, 'Full Rescan')
}

// =================================================================================================
// --- Item-specific Reads & Queries ---
// =================================================================================================

export async function getItemDetails(itemId: string): Promise<LibraryItem | null> {
  const item = repositoryService.getItemById(itemId)
  if (!item) throw new Error(`Cannot get item details: item with id ${itemId} not found.`)

  const imagesDir = path.join(pathsService.getLibraryDataPath(), 'images')
  await filesystemService.verifyImagePaths(item, imagesDir)

  metadataService
    .backgroundFetchAndApplyDetails(item)
    .then(async (modifiedItems) => {
      await _finalizeItemUpdate(modifiedItems, { updateSuggestions: true })
    })
    .catch((err) => {
      console.error(`[Details] Background fetch for item ${itemId} failed:`, err)
    })

  return repositoryService.createForDetailViewCopy(item)
}

export async function getAutocompleteSuggestions(): Promise<AutocompleteSuggestions> {
  const allItems = repositoryService.getAllItemsAsList()
  if (allItems.length === 0)
    return {
      mediaTypes: [],
      genres: [],
      persons: [],
      tagKeys: [],
      virtualTagKeys: [],
      tagValues: {}
    }

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

export async function getFolderWatchedState(
  folderId: string
): Promise<'fully' | 'partially' | 'unwatched' | 'none'> {
  const folder = repositoryService.getItemById(folderId)
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
// --- Item & Metadata Updates ---
// =================================================================================================

export async function updateItem(updatedItem: LibraryItem, isUserEdit: boolean): Promise<void> {
  const itemInDb = repositoryService.getItemById(updatedItem.id)
  if (!itemInDb) {
    throw new Error(`Could not find item with id ${updatedItem.id} in DB to update.`)
  }

  const allModifiedItems = new Set<LibraryItem>()

  // Apply the core updates from the renderer
  repositoryService.updateItem(updatedItem.id, updatedItem)
  allModifiedItems.add(itemInDb)

  // If it's a user edit, also mark the item and its parents, collecting all modified items.
  if (isUserEdit) {
    log(
      `Marking item as user-edited: "${updatedItem.title ?? updatedItem.name}" (ID: ${updatedItem.id})`
    )
    const markedItems = repositoryService.markAsUserEdited(updatedItem.id)
    markedItems.forEach((i) => allModifiedItems.add(i))
  }

  // Re-evaluate virtual tags on the primary item
  const settings = await settingsService.readSettings()
  itemInDb.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(itemInDb, settings)

  // Finalize the batch of all modified items
  await _finalizeItemUpdate(Array.from(allModifiedItems), { updateSuggestions: true })
  log(`Updated item ${updatedItem.id} in database.`)
}

export async function applyInitialFolderSettings(
  settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]
) {
  if (pathsService.isRemoteLibrary()) return
  repositoryService.setBulkUpdateStatus(true)
  for (const setting of settings) {
    const item = repositoryService.getItemById(setting.id)
    if (item && item.type === 'folder') {
      item.retrieve_children_metadata = setting.retrieve
      item.children_type_hint = setting.hint
    }
  }
  repositoryService.setBulkUpdateStatus(false)
  await repositoryService.writeDb()
  log('Applied initial folder settings and saved to DB.')
  metadataService
    .fetchMetadataForLibrary()
    .catch((err) =>
      console.error('Background metadata fetch failed after applying initial settings:', err)
    )
}

export async function reapplyVirtualTagsAfterSettingsChange() {
  const root = repositoryService.getRoot()
  if (!root) {
    log('Cannot re-apply virtual tags: database not loaded.')
    return
  }
  log('Re-applying virtual tags to all items due to settings change...')
  repositoryService.setBulkUpdateStatus(true)
  const settings = await settingsService.readSettings()
  const allItems = repositoryService.getAllItemsAsList()
  allItems.forEach((item) => {
    item.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(item, settings)
  })
  searchService.buildFullSearchIndex(root)
  repositoryService.setBulkUpdateStatus(false)
  await repositoryService.writeDb()
  log(`Emitting update for ${allItems.length} items.`)
  const plainItems = JSON.parse(JSON.stringify(allItems))
  getTransport().notifyLibraryItemsUpdated(plainItems)
  const newSuggestions = await getAutocompleteSuggestions()
  getTransport().notifyAutocompleteSuggestionsUpdated(newSuggestions)
  log('Finished re-applying virtual tags and notified transport layer.')
}

// =================================================================================================
// --- Actions (Playback, FS, etc.) ---
// =================================================================================================

export async function playFileWith(
  file: MediaFile,
  command: string,
  onError: ErrorCallback
): Promise<boolean> {
  const success = await actionsService.playFileWith(file, command, onError)
  if (success) {
    const updatedFile = repositoryService.updateItem(file.id, {
      watched: true,
      lastWatched: Date.now()
    })
    if (updatedFile) {
      await _finalizeItemUpdate(updatedFile, { updateSuggestions: false })
    }
  }
  return success
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

export async function handleItemRemovedByPath(relativePath: string): Promise<void> {
  const item = repositoryService.findItemByPath(relativePath)
  if (!item) return
  repositoryService.deleteItem(item.id)
  searchService.removeItemAndDescendantsFromIndex(item)
  await repositoryService.writeDb()
  getTransport().notifyLibraryItemDeleted(item.id)
}

export async function handleItemRenamed(relativeOldPath: string, newName: string): Promise<void> {
  const itemToRename = repositoryService.findItemByPath(relativeOldPath)
  if (!itemToRename) throw new Error(`[Rename] Could not find item in DB: ${relativeOldPath}`)
  repositoryService.setBulkUpdateStatus(true)
  const parent = repositoryService.findParent(itemToRename.id)
  if (!parent) {
    repositoryService.setBulkUpdateStatus(false)
    throw new Error(`[Rename] Could not find parent for item: ${itemToRename.name}`)
  }
  const settings = await settingsService.readSettings()
  const allModifiedItems = new Set<LibraryItem>()
  function updatePathsAndIds(item: LibraryItem, newParentPath: string) {
    searchService.removeItemAndDescendantsFromIndex(item) // Old index entries must be cleared by path
    if (item.path === relativeOldPath) item.name = newName
    item.path = path.join(newParentPath, item.name).replace(/\\/g, '/')
    item.id = repositoryService.generateId(item.path)
    item.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(item, settings)
    allModifiedItems.add(item)
    if (item.type === 'folder')
      item.children.forEach((child) => updatePathsAndIds(child, item.path))
  }
  updatePathsAndIds(itemToRename, parent.path === '.' ? '' : parent.path)
  repositoryService.setBulkUpdateStatus(false)
  await _finalizeItemUpdate(Array.from(allModifiedItems), { updateSuggestions: true })
}

export async function deleteItemFromDb(itemId: string): Promise<boolean> {
  const itemToDelete = repositoryService.deleteItem(itemId)
  if (itemToDelete) {
    searchService.removeItemAndDescendantsFromIndex(itemToDelete)
    await repositoryService.writeDb()
    getTransport().notifyLibraryItemDeleted(itemId)
    return true
  }
  return false
}

// =================================================================================================
// --- Passthrough Exports to Specialized Services ---
// =================================================================================================

// --- Metadata Service ---
export async function fetchCredits(itemId: string): Promise<void> {
  const item = repositoryService.getItemById(itemId)
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
        await repositoryService.writeDb()
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

export async function clearItemMetadata(itemId: string): Promise<void> {
  const modifiedItems = await metadataService.clearItemMetadata(itemId)
  if (modifiedItems.length > 0) {
    await _finalizeItemUpdate(modifiedItems, { updateSuggestions: true })
  }
}

export async function clearVirtualFolderMetadata(itemIds: string[]): Promise<void> {
  const modifiedItems = await metadataService.clearVirtualFolderMetadata(itemIds)
  if (modifiedItems.length > 0) {
    await _finalizeItemUpdate(modifiedItems, { updateSuggestions: true })
  }
}

export async function applyTmdbResult(
  itemId: string,
  result: any,
  mediaType: 'movie' | 'tv' | 'season',
  onError: ErrorCallback
) {
  try {
    const modifiedItem = await metadataService.applyTmdbResult(itemId, result, mediaType)
    if (modifiedItem) {
      await _finalizeItemUpdate(modifiedItem, { updateSuggestions: true })
    }
  } catch (e: any) {
    onError({
      title: 'Operation Not Supported',
      message: e.message
    })
  }
}

export async function setImage(
  itemId: string,
  imageType: 'poster' | 'backdrop' | 'logo',
  source: { type: 'tmdb'; path: string } | { type: 'local'; path: string },
  onError: ErrorCallback
) {
  try {
    const modifiedItem = await metadataService.setImage(itemId, imageType, source)
    if (modifiedItem) {
      await _finalizeItemUpdate(modifiedItem, { updateSuggestions: false })
    }
  } catch (e: any) {
    onError({
      title: 'Image Error',
      message: e.message
    })
  }
}

export async function removeImage(itemId: string, imageType: 'poster' | 'backdrop' | 'logo') {
  const modifiedItem = await metadataService.removeImage(itemId, imageType)
  if (modifiedItem) {
    await _finalizeItemUpdate(modifiedItem, { updateSuggestions: false })
  }
}

// --- TV Show Service ---
export async function assignSeasonsAndEpisodes(
  showId: string,
  seasonStrategy: 'smart' | 'alphabetic',
  episodeStrategy: 'smart' | 'alphabetic',
  fetchMetadata: boolean
) {
  const show = repositoryService.getItemById(showId)
  if (!show || show.type !== 'folder') return
  log(`[Assign Seasons] Starting assignment for "${show.name}"...`)
  repositoryService.setBulkUpdateStatus(true)
  try {
    const modifiedItems = new Set<LibraryItem>()
    modifiedItems.add(show)
    log(`[Assign Seasons] Clearing old season/episode data...`)
    show.tmdbSeasons = undefined
    show.tmdbEpisodesFetched = undefined
    const imagesDir = path.join(pathsService.getLibraryDataPath(), 'images')
    await tvShowService.clearTvStructureMetadata(show, imagesDir, modifiedItems)
    log(`[Assign Seasons] Assigning new data with strategy: ${seasonStrategy}/${episodeStrategy}`)
    tvShowService.assignSeasonsAndEpisodesByStrategy(show, seasonStrategy, episodeStrategy)
    // Correctly get only the descendants of the show being processed.
    repositoryService.getAllDescendantsAsList(show).forEach((item) => modifiedItems.add(item))
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
    log(`[Assign Seasons] Re-applying virtual tags for ${modifiedItems.size} items...`)
    for (const item of modifiedItems) {
      item.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(item, settings)
    }
    repositoryService.setBulkUpdateStatus(false)
    log(`[Assign Seasons] Finalizing update for ${modifiedItems.size} items...`)
    await _finalizeItemUpdate(Array.from(modifiedItems), { updateSuggestions: true })
    log(`[Assign Seasons] Assignment complete for "${show.name}".`)
  } catch (error) {
    console.error(`[Assign Seasons] Failed during assignment for show ${showId}:`, error)
    repositoryService.setBulkUpdateStatus(false)
  }
}

// --- Watched State ---
export async function markAsUnwatched(itemId: string): Promise<void> {
  const item = repositoryService.getItemById(itemId)
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
  repositoryService.setBulkUpdateStatus(true)
  setUnwatchedRecursively(item)
  repositoryService.setBulkUpdateStatus(false)
  if (modifiedItems.length > 0) {
    await _finalizeItemUpdate(modifiedItems, { updateSuggestions: false })
  }
}

export async function markAsWatched(itemId: string): Promise<void> {
  const item = repositoryService.getItemById(itemId)
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
  repositoryService.setBulkUpdateStatus(true)
  setWatchedRecursively(item)
  repositoryService.setBulkUpdateStatus(false)
  if (modifiedItems.length > 0) {
    await _finalizeItemUpdate(modifiedItems, { updateSuggestions: false })
  }
}

// --- Continue Watching ---
export async function getContinueWatchingItems(): Promise<
  { show: MediaFolder; nextEpisode: MediaFile }[]
> {
  const allItems = repositoryService.getAllItemsAsList()
  if (allItems.length === 0) return []
  const parentMap = new Map<string, string>()
  const root = repositoryService.getRoot()
  if (!root) return []

  function buildParentMap(node: MediaFolder) {
    if (!node.children) return
    for (const child of node.children) {
      parentMap.set(child.id, node.id)
      if (child.type === 'folder') buildParentMap(child)
    }
  }
  buildParentMap(root)

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
        const parent = repositoryService.getItemById(currentParentId)
        if (parent?.type === 'folder' && parent.mediaType === 'tv') {
          showId = parent.id
          break
        }
        currentParentId = parent ? parentMap.get(parent.id) : undefined
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
      const modifiedItems = await metadataService.fetchEpisodeDataForContinueWatching(
        show,
        nextUnwatchedEpisode
      )
      if (modifiedItems.length > 0) {
        await _finalizeItemUpdate(modifiedItems, { updateSuggestions: true })
      }
      const lastWatchedTime = Math.max(0, ...watchedEpisodes.map((ep) => ep.lastWatched ?? 0))
      continueWatchingItems.push({
        show: repositoryService.createTransferableCopy(show) as MediaFolder,
        nextEpisode: repositoryService.createTransferableCopy(nextUnwatchedEpisode) as MediaFile,
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
  const show = repositoryService.getItemById(showId)
  if (show?.type !== 'folder' || show.mediaType !== 'tv' || show.nextUpDismissed) return null
  const episodes = repositoryService
    .getAllDescendantsAsList(show)
    .filter(
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
    const modifiedItems = await metadataService.fetchEpisodeDataForContinueWatching(
      show,
      nextUnwatchedEpisode
    )
    if (modifiedItems.length > 0) {
      await _finalizeItemUpdate(modifiedItems, { updateSuggestions: true })
    }
    return {
      show: repositoryService.createTransferableCopy(show) as MediaFolder,
      nextEpisode: repositoryService.createTransferableCopy(nextUnwatchedEpisode) as MediaFile
    }
  }
  return null
}

export async function setContinueWatchingDismissed(showId: string) {
  const updatedItem = repositoryService.updateItem(showId, { continueWatchingDismissed: true })
  if (updatedItem) {
    await _finalizeItemUpdate(updatedItem, { updateSuggestions: false })
  }
}

export async function setNextUpDismissed(showId: string) {
  const updatedItem = repositoryService.updateItem(showId, {
    nextUpDismissed: true,
    continueWatchingDismissed: true
  })
  if (updatedItem) {
    await _finalizeItemUpdate(updatedItem, { updateSuggestions: false })
  }
}

// --- Passthrough to other services ---
export const performSearch = searchService.performSearch
export const debugPerformSearch = searchService.debugPerformSearch
export const manualSearch = retrieverService.manualSearch
export const getTmdbImages = retrieverService.getTmdbImages
export const executeCustomAction = actionsService.executeCustomAction
export const getAbsolutePath = actionsService.getAbsolutePath
export const getItemProperties = actionsService.getItemProperties
export const getItemById = async (id: string) => {
  const item = repositoryService.getItemById(id)
  return item ? repositoryService.createTransferableCopy(item) : null
}
export const getParent = async (id: string) => {
  const parent = repositoryService.findParent(id)
  return parent ? repositoryService.createTransferableCopy(parent) : null
}
export const getChildren = async (id: string) => {
  const parent = repositoryService.getItemById(id)
  if (!parent || parent.type !== 'folder') return null
  return parent.children.map((child) => repositoryService.createTransferableCopy(child))
}
export const getHiddenChildren = async (parentId: string): Promise<LibraryItem[]> => {
  const parent = repositoryService.getItemById(parentId)
  if (!parent || parent.type !== 'folder') return []
  const hiddenChildren = parent.children.filter((child) => child.isHidden)
  return JSON.parse(JSON.stringify(hiddenChildren))
}