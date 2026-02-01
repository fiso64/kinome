import path from 'path'
import crypto from 'crypto'

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

import type { MediaFolder, LibraryItem, MediaFile } from '../../shared/types'
import { VIEW_SETTINGS_KEYS, METADATA_KEYS } from '../../shared/types'
import { getTransport } from '../transport.registry'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Library Service] ${message}`)
}

type ErrorCallback = (options: { title: string; message: string; detail?: string }) => void

// --- Helpers ---

/**
 * Deeply compares two objects for equality based on specific metadata and user state keys.
 * Returns true if they are effectively the same.
 */
function isItemDataSame(existing: LibraryItem, updated: LibraryItem): boolean {
  // 1. Check Metadata Keys
  for (const key of METADATA_KEYS) {
    const k = key as keyof LibraryItem
    const v1 = JSON.stringify(existing[k])
    const v2 = JSON.stringify(updated[k])
    if (v1 !== v2) return false
  }

  // 2. Check User State Keys
  const USER_KEYS: (keyof LibraryItem)[] = [
    'watched',
    'lastWatched',
    'continueWatchingDismissed',
    'nextUpDismissed'
  ]
  for (const key of USER_KEYS) {
    if (existing[key] !== updated[key]) return false
  }

  // 3. Check Folder Settings
  for (const key of VIEW_SETTINGS_KEYS) {
    const k = key as keyof LibraryItem
    if (JSON.stringify(existing[k]) !== JSON.stringify(updated[k])) return false
  }

  return true
}

async function _finalizeItemUpdate(
  items: LibraryItem | LibraryItem[],
  options: { updateSuggestions?: boolean } = {}
): Promise<void> {
  if (!items || (Array.isArray(items) && items.length === 0)) return
  const itemsArray = Array.isArray(items) ? items : [items]

  const settings = await settingsService.readSettings()
  const modifiedItems: LibraryItem[] = []

  // 1. Process items and detect real changes
  repositoryService.runTransaction(() => {
    for (const item of itemsArray) {
      // Calculate virtual tags (always do this as they depend on external settings)
      const newVirtualTags = virtualTagsService.evaluateVirtualTagsForItem(item, settings)
      const virtualTagsChanged = JSON.stringify(item.virtualTags) !== JSON.stringify(newVirtualTags)
      item.virtualTags = newVirtualTags

      const existing = repositoryService.getItemById(item.id)
      const hasRealChanges = !existing || !isItemDataSame(existing, item) || virtualTagsChanged

      if (hasRealChanges) {
        // Only bump version if something actually changed
        item._v = Date.now()

        // Persist physical items to database
        if (!item.id.startsWith('virtual--')) {
          repositoryService.updateItem(item.id, item)
        }
        modifiedItems.push(item)
      }
    }
  })

  if (modifiedItems.length === 0) {
    // If no real changes occurred, exit early to break any potential loops
    return
  }

  // 2. Prepare broadcast payload for changed items only
  const plainItems = JSON.parse(JSON.stringify(modifiedItems))
  for (const item of plainItems) {
    const ancestors = repositoryService.getAncestors(item.id)
    item.ancestorIds = ancestors.map((a) => a.id)
  }

  log(`Broadcasting updates for ${modifiedItems.length} items.`)
  getTransport().notifyLibraryItemsUpdated(plainItems)

  if (options.updateSuggestions) {
    const newSuggestions = await getAutocompleteSuggestions()
    getTransport().notifyAutocompleteSuggestionsUpdated(newSuggestions)
  }
}

// --- Core ---

export async function loadDbIntoMemory(): Promise<void> {
  await repositoryService.loadDb()

  // Ensure root exists if we have a configured media source path
  const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
  if (mediaSourcePath) {
    repositoryService.ensureRootExists(mediaSourcePath)
  }

  searchService.buildFullSearchIndex()
}

export async function getLibraryRoot(): Promise<MediaFolder | null> {
  const root = repositoryService.getRoot()
  if (!root) return null
  // Pre-load immediate children for the root view to be responsive
  root.children = repositoryService.getChildren(root.id).filter((c) => !c.isHidden && !c.isMissing)
  const item = repositoryService.createTransferableCopy(root) as MediaFolder
  log(
    `[Library] getLibraryRoot returning: ${item.name} with ${item.children?.length} preloaded children.`
  )
  return item
}

export async function refreshLibrary(): Promise<MediaFolder | null> {
  if (pathsService.isRemoteLibrary())
    throw new Error('Refreshing not available for remote libraries.')
  const mediaSourcePath = await settingsService.getAbsoluteMediaSourcePath()
  if (!mediaSourcePath) throw new Error('Cannot refresh, no library configured.')

  const refreshId = crypto.randomBytes(4).toString('hex')
  log(`[Refresh ${refreshId}] Starting refresh from: ${mediaSourcePath}`)

  await filesystemService.scanDirectory(mediaSourcePath)

  const imagesDir = path.join(pathsService.getLibraryDataPath(), 'images')
  await filesystemService.verifyImagePaths(imagesDir)

  searchService.buildFullSearchIndex()

  metadataService.fetchMetadataForLibrary().catch(console.error)

  await reapplyVirtualTagsAfterSettingsChange()

  return getLibraryRoot()
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

  await filesystemService.scanDirectory(mediaSourcePath)
  searchService.buildFullSearchIndex()

  await reapplyVirtualTagsAfterSettingsChange()

  return getLibraryRoot()
}

export const performInitialScan = (path: string) => _scanAndCreateNewDb(path, 'Initial Scan')
export const performFullRescan = (path: string) => _scanAndCreateNewDb(path, 'Full Rescan')

// --- Items ---

export async function getItemDetails(itemId: string): Promise<LibraryItem | null> {
  const item = repositoryService.getItemById(itemId)
  if (!item) throw new Error(`Item ${itemId} not found.`)

  metadataService
    .backgroundFetchAndApplyDetails(item)
    .then(async (modified) => await _finalizeItemUpdate(modified, { updateSuggestions: true }))
    .catch(console.error)

  return repositoryService.createForDetailViewCopy(item)
}

// --- Watched State ---

export async function markAsUnwatched(itemId: string): Promise<void> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return

  const descendants = repositoryService.getAllDescendantsAsList(item as MediaFolder)
  const itemsToUpdate = [item, ...descendants]

  repositoryService.runTransaction(() => {
    for (const i of itemsToUpdate) {
      repositoryService.updateItem(i.id, { watched: false, lastWatched: undefined })
      if (i.type === 'folder') {
        repositoryService.updateItem(i.id, {
          continueWatchingDismissed: false,
          nextUpDismissed: false
        })
      }
    }
  })

  const updatedItems = itemsToUpdate.map((i) => repositoryService.getItemById(i.id)!)
  await _finalizeItemUpdate(updatedItems)
}

export async function markAsWatched(itemId: string): Promise<void> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return

  const descendants = repositoryService.getAllDescendantsAsList(item as MediaFolder)
  const itemsToUpdate = [item, ...descendants]

  repositoryService.runTransaction(() => {
    for (const i of itemsToUpdate) {
      if (i.type === 'file') {
        repositoryService.updateItem(i.id, { watched: true, lastWatched: Date.now() })
      }
    }
  })

  const updatedItems = itemsToUpdate.map((i) => repositoryService.getItemById(i.id)!)
  await _finalizeItemUpdate(updatedItems)
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
          await _finalizeItemUpdate(updatedItems)
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

export const getAutocompleteSuggestions = async () => {
  const settings = await settingsService.readSettings()
  const allItems = repositoryService.getAllItemsAsList()

  const mediaTypes = new Set<string>()
  const genres = new Set<string>()
  const persons = new Set<string>()
  const tagKeys = new Set<string>()
  const virtualTagKeys = new Set<string>()
  const tagValues: Record<string, Set<string>> = {}

  // Pre-populate virtualTagKeys from settings to ensure they are always discoverable
  if (settings.virtualTags) {
    for (const tag of settings.virtualTags) {
      virtualTagKeys.add(tag.name.trim())
    }
  }

  for (const item of allItems) {
    if (item.mediaType) mediaTypes.add(item.mediaType.trim())
    if (item.genres) item.genres.forEach((g) => genres.add(g.trim()))
    if (item.tmdbCredits) {
      ; (item.tmdbCredits.cast ?? []).forEach((p) => p.name && persons.add(p.name.trim()))
        ; (item.tmdbCredits.crew ?? []).forEach((p) => p.name && persons.add(p.name.trim()))
    }
    if (item.tags) {
      for (const [key, value] of Object.entries(item.tags)) {
        if (key) {
          tagKeys.add(key.trim())
          if (!tagValues[key]) tagValues[key] = new Set<string>()
          value.split(',').forEach((v) => v.trim() && tagValues[key].add(v.trim()))
        }
      }
    }
    if (item.virtualTags) {
      for (const [key, value] of Object.entries(item.virtualTags)) {
        if (key) {
          virtualTagKeys.add(key.trim())
          if (!tagValues[key]) tagValues[key] = new Set<string>()
          if (value) tagValues[key].add(value.trim())
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

  // 1. Sync Structure
  await tvShowService.syncTvShowStructure(show, seasonStrategy, episodeStrategy)

  // 2. Fetch Metadata if requested
  if (fetchMetadata) {
    // We pass the "show" item to backgroundFetchAndApplyDetails.
    // This will identify dirty episodes (due to number changes) and fetch them.
    const modified = await metadataService.backgroundFetchAndApplyDetails(show)
    if (modified && modified.length > 0) {
      // CRITICAL: We must finalize the updates because backgroundFetchAndApplyDetails
      // no longer bumps versions or broadcasts internally (to prevent loops).
      // This saves the newly fetched metadata to the DB and notifies the UI.
      await _finalizeItemUpdate(modified)
    }
  }

  log(`[Library] Assignment complete for show ${showId}.`)
}
export const clearItemMetadata = metadataService.clearItemMetadata
export const clearVirtualFolderMetadata = metadataService.clearVirtualFolderMetadata

export const applyManualMatch = async (
  itemId: string,
  result: any,
  mediaType: 'movie' | 'tv' | 'season',
  options: { respectLocks?: boolean } = { respectLocks: true }
) => {
  const item = await metadataService.applyManualMatch(itemId, result, mediaType, {
    ...options,
    respectLocks: false
  })
  if (item) {
    await _finalizeItemUpdate(item, { updateSuggestions: true })
  }
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
export const getContinueWatchingForShow = async (showId: string) => {
  const all = await getContinueWatchingItems(true) // Include dismissed so we can show "Next Up" even if removed from Home
  const found = all.find((r) => r.show.id === showId)
  // For the detail view, we filter by nextUpDismissed here or let the UI handle it.
  // Ideally we return it and let UI decide, but to be safe let's return null if nextUpDismissed is true
  if (found && found.show.nextUpDismissed) return null
  return found || null
}
export const setContinueWatchingDismissed = async (showId: string) => {
  repositoryService.updateItem(showId, { continueWatchingDismissed: true })
  _finalizeItemUpdate(repositoryService.getItemById(showId)!)
}
export const setNextUpDismissed = async (showId: string) => {
  repositoryService.updateItem(showId, { nextUpDismissed: true, continueWatchingDismissed: true })
  _finalizeItemUpdate(repositoryService.getItemById(showId)!)
}
export const fetchCredits = async (itemId: string) => {
  const item = repositoryService.getItemById(itemId)
  if (item) {
    await retrieverService.fetchAndApplyCredits(
      item,
      (await settingsService.readSettings()).tmdbApiKey
    )
    repositoryService.updateItem(item.id, {
      tmdbCredits: item.tmdbCredits
    })
    _finalizeItemUpdate(item)
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

        // Persistence trigger
        repositoryService.updateItem(parent.id, {
          virtualFolderSettings: parent.virtualFolderSettings
        })


        // Propagate update to renderer (both the virtual item's "bare" state and the parent)
        // Note: Renderer's MediaView will re-generate the virtual items from the updated parent.
        await _finalizeItemUpdate([parent, item])
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

      if (newValue !== undefined && newValue !== oldValue) {
        // If the update is specifically trying to revert to Name (Folder Name),
        // we might want a safeguard, but with partial updates, the frontend only sends
        // title if the user actively edited it.
        currentLocks.add(key)
        log(`[Auto-Lock] Locking field "${key}" for item "${existing.name}" due to user update.`)
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
  repositoryService.updateItem(item.id, item)
  _finalizeItemUpdate(item)
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

  repositoryService.updateItem(itemId, { watched: true, lastWatched: Date.now() })

  // Check dismissal logic: If the user plays an episode of a show they previously dismissed,
  // we assume they are interested again and un-dismiss it.
  let parent = repositoryService.findParent(itemId)
  while (parent) {
    if (parent.type === 'folder' && parent.mediaType === 'tv') {
      if (parent.nextUpDismissed || parent.continueWatchingDismissed) {
        repositoryService.updateItem(parent.id, {
          nextUpDismissed: false,
          continueWatchingDismissed: false
        })
        _finalizeItemUpdate(repositoryService.getItemById(parent.id)!)
      }
      break
    }
    parent = repositoryService.findParent(parent.id)
  }
  _finalizeItemUpdate(repositoryService.getItemById(itemId)!)
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
  repositoryService.runTransaction(() => {
    for (const s of settings) {
      repositoryService.updateItem(s.id, {
        retrieve_children_metadata: s.retrieve,
        children_type_hint: s.hint
      })
    }
  })
  metadataService.fetchMetadataForLibrary().catch(console.error)
}

export const reapplyVirtualTagsAfterSettingsChange = async () => {
  const settings = await settingsService.readSettings()

  // 1. Apply tags in DB massively via SQL
  virtualTagsService.applyVirtualTags(settings.virtualTags)

  // 2. We need to broadcast the updates.
  const allItems = repositoryService.getAllItemsAsList()

  getTransport().notifyLibraryItemsUpdated(JSON.parse(JSON.stringify(allItems)))
  getTransport().notifyAutocompleteSuggestionsUpdated(await getAutocompleteSuggestions())
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
