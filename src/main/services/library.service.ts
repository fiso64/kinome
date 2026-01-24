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
import { getTransport } from '../transport.registry'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Library Service] ${message}`)
}

type ErrorCallback = (options: { title: string; message: string; detail?: string }) => void

// --- Helpers ---

async function _finalizeItemUpdate(
  items: LibraryItem | LibraryItem[],
  options: { updateSuggestions?: boolean } = {}
): Promise<void> {
  if (!items || (Array.isArray(items) && items.length === 0)) return
  const itemsArray = Array.isArray(items) ? items : [items]

  const settings = await settingsService.readSettings()

  // 1. Calculate Virtual Tags and Persist changes to SQLite
  repositoryService.runTransaction(() => {
    for (const item of itemsArray) {
      // Ensure virtual tags are up-to-date in memory before saving
      item.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(item, settings)
      repositoryService.updateItem(item.id, item)
    }
  })

  // searchService.updateIndexForItems(itemsArray) - Removed, handled by FTS triggers

  const plainItems = JSON.parse(JSON.stringify(itemsArray))
  getTransport().notifyLibraryItemsUpdated(plainItems)

  if (options.updateSuggestions) {
    const newSuggestions = await getAutocompleteSuggestions()
    getTransport().notifyAutocompleteSuggestionsUpdated(newSuggestions)
  }
}

// --- Core ---

export async function loadDbIntoMemory(): Promise<void> {
  await repositoryService.loadDb()
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
  await filesystemService.verifyImagePaths(null, imagesDir)

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
      ;(item.tmdbCredits.cast ?? []).forEach((p) => p.name && persons.add(p.name.trim()))
      ;(item.tmdbCredits.crew ?? []).forEach((p) => p.name && persons.add(p.name.trim()))
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
export const assignSeasonsAndEpisodes = async (showId: string, s1: any, s2: any, fm: boolean) => {
  const show = repositoryService.getItemById(showId) as MediaFolder
  if (!show) return
  show.children = repositoryService.getAllDescendantsAsList(show)
  await tvShowService.assignSeasonsAndEpisodesByStrategy(show, s1, s2)
  repositoryService.runTransaction(() => {
    const traverse = (node: LibraryItem) => {
      repositoryService.updateItem(node.id, node)
      if (node.type === 'folder' && node.children) node.children.forEach(traverse)
    }
    traverse(show)
  })
  if (fm) {
    await retrieverService.refetchShowSeasons(
      show,
      await settingsService.readSettings(),
      pathsService.getLibraryDataPath()
    )
  }
  _finalizeItemUpdate(show)
}
export const clearItemMetadata = metadataService.clearItemMetadata
export const clearVirtualFolderMetadata = metadataService.clearVirtualFolderMetadata

export const applyTmdbResult = async (
  itemId: string,
  result: any,
  mediaType: 'movie' | 'tv' | 'season'
) => {
  const item = await metadataService.applyTmdbResult(itemId, result, mediaType)
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
    await _finalizeItemUpdate(item, { updateSuggestions: false })
  }
}

export const removeImage = async (itemId: string, imageType: 'poster' | 'backdrop' | 'logo') => {
  const item = await metadataService.removeImage(itemId, imageType)
  if (item) {
    await _finalizeItemUpdate(item, { updateSuggestions: false })
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
      tmdbCredits: item.tmdbCredits,
      tmdbCreditsFetched: true
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
  repositoryService.updateItem(item.id, item)
  if (isUser) repositoryService.markAsUserEdited(item.id)
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
export const playFileWith = async (file: MediaFile, cmd: string, cb: ErrorCallback) => {
  const res = await actionsService.playFileWith(file, cmd, cb)
  if (res) {
    repositoryService.updateItem(file.id, { watched: true, lastWatched: Date.now() })
    // Check dismissal logic
    let parent = repositoryService.findParent(file.id)
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
    _finalizeItemUpdate(repositoryService.getItemById(file.id)!)
  }
  return res
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
