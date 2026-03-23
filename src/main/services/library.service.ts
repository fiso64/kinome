import path from 'path'
import crypto from 'crypto'
import equal from 'fast-deep-equal'

import * as virtualTagsService from './virtualTags.service'
import * as accountFilterService from './account-filter.service'
import * as searchService from './search.service'
import * as retrieverService from './retriever.service'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import * as repositoryService from './repository.service'
// getDb import was removed to avoid linting errors if unused, or handled via repositoryService export
import * as filesystemService from './filesystem.service'
import * as tvShowService from './tv-show.service'
import * as actionsService from './actions.service'
import * as virtualFoldersService from './virtualFolders.service'
import * as metadataService from './metadata.service'
import * as navigationService from './navigation.service'
import * as groupingService from './grouping.service'
import { getHomeFolderId, FindOptions, HOME_CATEGORIES_ID, HOME_GENRES_ID, HOME_ALL_MEDIA_ID } from './repository.service'
import { StoredViewSettings } from '@shared/types'
import { closeDatabase } from '../database/client'
import { updateIfChangedAndBroadcast, broadcastModifiedItems } from './item-update.service'
import * as userRepo from '../database/repositories/user.repo'
import { getAutocompleteSuggestions as fetchAutocompleteSuggestions } from './autocomplete.service'
import { getTransport } from '../transport.registry'
import * as playbackService from './playback.service'
import {
  findNextUpEpisode,
  getComparable,
  applyContinueWatchingDismissal,
  applyNextUpDismissal,
  checkAutoUndismissal,
} from '../utils/continue-watching'

import {
  VIEW_SETTINGS_KEYS,
  FOLDER_BEHAVIOR_SETTINGS_KEYS,
  METADATA_KEYS
} from '@shared/types'
import type { MediaFolder, LibraryItem, MediaFile, LibraryStatus } from '@shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Library Service] ${message}`)
}

type ErrorCallback = (options: { title: string; message: string; detail?: string }) => void

// --- Helpers ---

// --- Core ---

export async function loadDbIntoMemory(): Promise<void> {
  await repositoryService.loadDb()

  // Ensure home defaults on every startup (no-scan path).
  // INSERT OR IGNORE makes this a no-op for existing installs; returns true
  // only on the very first run with these defaults, triggering a grouping bootstrap.
  const root = repositoryService.getRoot()
  if (root) {
    const isFirstHomeRun = repositoryService.ensureHomeDefaults(root.id)
    if (isFirstHomeRun) {
      groupingService.applyGrouping(getHomeFolderId(), 'vt._home_category')
      groupingService.applyGrouping(HOME_CATEGORIES_ID, 'vt._home_category')
      groupingService.applyGrouping(HOME_GENRES_ID, 'genre')
      groupingService.applyGrouping(HOME_ALL_MEDIA_ID, 'vt._home_category')
    }
  }

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

export const getLibraryStatus = navigationService.getLibraryStatus

// Helper to normalize settings: converts absolute key-paths to paths relative to a given source root
function normalizeFolderSettings(
  sourceAbsPath: string,
  initialFolderSettings?: Record<string, any>
) {
  const normalizedSettings: Record<string, any> = {}
  if (initialFolderSettings) {
    log(`[Scan] Received initial settings. Keys: ${Object.keys(initialFolderSettings).join(', ')}`)
    for (const [keyPath, val] of Object.entries(initialFolderSettings)) {
      let rel = path.relative(sourceAbsPath, keyPath).replace(/\\/g, '/')
      if (rel === '') rel = '.'
      normalizedSettings[rel] = val
      log(`[Scan] Normalized setting: "${keyPath}" -> "${rel}"`)
    }
  } else {
    log(`[Scan] No initial folder settings provided.`)
  }
  return normalizedSettings
}

async function _runBackgroundScan(
  source: import('@shared/types').MediaSource,
  resolvedAbsPath: string,
  normalizedSettings: Record<string, any>,
  higherPriorityPaths?: Set<string>,
  shadowMinDepth?: number
): Promise<void> {
  if (pathsService.isRemoteLibrary())
    throw new Error(`Scanning not available for remote libraries.`)

  getTransport().notifyScanStatusChanged({ isFileScanningLibrary: true })

  try {
    await filesystemService.scanDirectory(source, resolvedAbsPath, {
      skipMetadata: false,
      initialFolderSettings: normalizedSettings,
      higherPriorityPaths,
      shadowMinDepth
    })

    searchService.buildFullSearchIndex()

    // Phase 2: Metadata Enrichment & Maintenance
    await metadataService.enrichDatabase().catch((err) => {
      console.error('[Library Service] Enrichment failed during rescan:', err)
    })

    // Virtual tags are now handled inside enrichDatabase -> maintenancePass
  } finally {
    playbackService.clearStreamCache()
    getTransport().notifyScanStatusChanged({ isFileScanningLibrary: false })
  }
}

/**
 * Saves (adds or replaces) a single media source in settings.
 * Does not trigger a scan. Call performScan() after saving all sources.
 */
export const saveSource = async (source: import('@shared/types').MediaSource): Promise<{ success: boolean }> => {
  const settings = await settingsService.readSettings()
  const existingSources = settings.mediaSources ?? []
  const updatedSources = existingSources.some((s) => s.id === source.id)
    ? existingSources.map((s) => (s.id === source.id ? source : s))
    : [...existingSources, source]
  await settingsService.writeLibrarySettings({ mediaSources: updatedSources })
  return { success: true }
}

/**
 * Scans all configured media sources sequentially.
 * Sources are scanned in priority order; shadowing is applied when enabled.
 */
export const performScan = async (
  sourceFolderSettings?: Record<string, Record<string, any>>
): Promise<{ success: boolean }> => {
  const settings = await settingsService.readSettings()
  const sourcePaths = await settingsService.getAbsoluteSourcePaths()
  if (sourcePaths.size === 0) throw new Error('Cannot scan, no library sources configured.')

  const sources = settings.mediaSources ?? []
  const shadowSources = settings.shadowSources ?? false
  const shadowMinDepth = settings.shadowMinDepth ?? 1

  // Initialize roots before any scanning begins
  for (const source of sources) {
    const resolvedAbsPath = sourcePaths.get(source.id)
    if (!resolvedAbsPath) continue
    if (!pathsService.isRemotePath(resolvedAbsPath)) {
      await settingsService.createDirectory(resolvedAbsPath)
    }
    const normalizedSettings = normalizeFolderSettings(resolvedAbsPath, sourceFolderSettings?.[source.id])
    filesystemService.initializeRoot(source, resolvedAbsPath, normalizedSettings)
  }

  // Run scans sequentially so higher-priority source results are in DB before building shadow sets
  ;(async () => {
    for (let j = 0; j < sources.length; j++) {
      const source = sources[j]
      const resolvedAbsPath = sourcePaths.get(source.id)
      if (!resolvedAbsPath) continue

      log(`Scan source ${source.id} (${j + 1}/${sources.length}): ${resolvedAbsPath}`)

      // Build shadow set from higher-priority sources that have already been scanned this cycle
      let higherPriorityPaths: Set<string> | undefined
      if (shadowSources && j > 0) {
        higherPriorityPaths = new Set<string>()
        for (let k = 0; k < j; k++) {
          for (const p of filesystemService.getFolderPathsForSource(sources[k].id)) {
            higherPriorityPaths.add(p)
          }
        }
        log(`Shadow: skipping ${higherPriorityPaths.size} paths from ${j} higher-priority source(s) at depth >= ${shadowMinDepth}`)
      }

      const normalizedSettings = normalizeFolderSettings(resolvedAbsPath, sourceFolderSettings?.[source.id])
      await _runBackgroundScan(source, resolvedAbsPath, normalizedSettings, higherPriorityPaths, shadowMinDepth)
    }
  })().catch((err) => {
    console.error('[Library Service] Background scan sequence failed:', err)
  })

  return { success: true }
}

// --- Items ---

// This must be read-only.
export async function getItemDetails(
  itemId: string,
  fields?: string[]
): Promise<LibraryItem | null> {
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

export async function markAsUnwatched(itemId: string, userId: string): Promise<void> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return

  const descendants = item.type === 'file' ? [] : repositoryService.getAllDescendantsAsList(item as MediaFolder)
  const itemsToUpdate = [item, ...descendants]
  userRepo.overlayUserState(itemsToUpdate, userId)

  const now = Date.now()
  const fileItems: MediaFile[] = []
  const folderItemsWithStateChange: LibraryItem[] = []

  for (const i of itemsToUpdate) {
    if (i.type === 'file') {
      i.watched = false
      i.lastWatched = undefined
      fileItems.push(i as MediaFile)
    } else if (i.type === 'folder') {
      if (i.continueWatchingDismissed || i.nextUpDismissed) {
        i.continueWatchingDismissed = false
        i.nextUpDismissed = false
        folderItemsWithStateChange.push(i)
      }
    }
  }

  // Bulk-write unwatched state for all file items in one SQL statement.
  userRepo.bulkSetWatched(fileItems.map((f) => f.id), userId, false, now)

  // --- Recalculate Next Up for affected shows ---
  let parent =
    item.type === 'folder' && item.mediaType === 'tv'
      ? (item as MediaFolder)
      : repositoryService.findParent(item.id)

  while (parent && (parent.type !== 'folder' || parent.mediaType !== 'tv')) {
    parent = repositoryService.findParent(parent.id)
  }

  // Show-level items: folders with changed dismissal state + nextUp recalculation result.
  const showLevelItems: LibraryItem[] = [...folderItemsWithStateChange]

  if (parent) {
    const showWithNextUp = await recalculateNextUpForShow(parent.id, userId, itemsToUpdate)
    if (showWithNextUp) {
      if (!itemsToUpdate.find((i) => i.id === showWithNextUp.id)) {
        itemsToUpdate.push(showWithNextUp)
      }
      if (!showLevelItems.find((i) => i.id === showWithNextUp.id)) {
        showLevelItems.push(showWithNextUp)
      }
    }
  }

  repositoryService.runTransaction(() => {
    for (const i of showLevelItems) {
      repositoryService._updateItem(i.id, {
        nextUpEpisodeId: (i as any).nextUpEpisodeId,
        lastWatched: (i as any).lastWatched,
        continueWatchingDismissed: i.continueWatchingDismissed,
        nextUpDismissed: i.nextUpDismissed
      } as any, { skipFetch: true }, userId)
    }
  })

  for (const i of itemsToUpdate) i._v = now
  await broadcastModifiedItems(itemsToUpdate)
}

/**
 * Finds the "Next Up" episode for a given show from a list of its episodes.
 */
// findNextUpEpisode is now imported from '../utils/continue-watching'

/**
 * Recalculates the next_up_episode_id for a show and returns the updated show object.
 * Pass `preloadedEpisodes` (already overlaid with in-memory changes) to skip the DB fetch.
 */
async function recalculateNextUpForShow(
  showId: string,
  userId: string | null,
  modifiedItems: LibraryItem[] = [],
  preloadedEpisodes?: MediaFile[]
): Promise<MediaFolder | null> {
  let show = modifiedItems.find((i) => i.id === showId) as MediaFolder
  if (!show) {
    show = repositoryService.getItemById(showId) as MediaFolder
    if (show && userId) userRepo.overlayUserState([show], userId)
  }
  if (!show || show.mediaType !== 'tv') return null

  let allEpisodes: MediaFile[]
  if (preloadedEpisodes) {
    allEpisodes = preloadedEpisodes
  } else {
    const descendants = repositoryService.getAllDescendantsAsList(show)
    allEpisodes = descendants.filter(
      (d) => d.type === 'file' && d.mediaType === 'episode'
    ) as MediaFile[]
    if (userId) userRepo.overlayUserState(allEpisodes, userId)
    // Overlay in-memory changes so we don't calculate based on stale database state
    for (const ep of allEpisodes) {
      const mod = modifiedItems.find((i) => i.id === ep.id)
      if (mod) Object.assign(ep, mod)
    }
  }

  const nextEpisode = findNextUpEpisode(allEpisodes)
  const newNextUpId = nextEpisode?.id || null

  // Also update the show's lastWatched to the latest of its episodes
  const latestWatchTime = Math.max(0, ...allEpisodes.map((e) => e.lastWatched || 0))

  log(
    `[Continue Watching] Recalculating for ${show.name}: current=${show.nextUpEpisodeId}, new=${newNextUpId}, lastWatched=${latestWatchTime}`
  )

  let changed = false
  if (show.nextUpEpisodeId !== newNextUpId) {
    show.nextUpEpisodeId = newNextUpId
    changed = true
  }

  if ((show as any).lastWatched !== latestWatchTime) {
    ; (show as any).lastWatched = latestWatchTime
    changed = true
  }

  return changed ? (show as MediaFolder) : null
}

async function checkAndUndismissShow(
  showId: string,
  userId: string,
  newlyWatchedEpisodes: MediaFile[],
  allModifiedItems: LibraryItem[] = [],
  preloadedEpisodes?: MediaFile[]
): Promise<MediaFolder | null> {
  let show = allModifiedItems.find((i) => i.id === showId) as MediaFolder
  if (!show) {
    show = repositoryService.getItemById(showId) as MediaFolder
    if (show) userRepo.overlayUserState([show], userId)
  }
  if (!show || show.mediaType !== 'tv') return null

  let allEpisodes: MediaFile[]
  if (preloadedEpisodes) {
    allEpisodes = preloadedEpisodes
  } else {
    // Get all episodes for this show (flattened list)
    const descendants = repositoryService.getAllDescendantsAsList(show)
    allEpisodes = descendants.filter(
      (d) => d.type === 'file' && d.mediaType === 'episode'
    ) as MediaFile[]
    userRepo.overlayUserState(allEpisodes, userId)
    // Overlay in-memory changes
    for (const ep of allEpisodes) {
      const mod = allModifiedItems.find((i) => i.id === ep.id)
      if (mod) Object.assign(ep, mod)
    }
  }

  const newState = checkAutoUndismissal(
    { continueWatchingDismissed: !!show.continueWatchingDismissed, nextUpDismissed: !!show.nextUpDismissed },
    allEpisodes,
    newlyWatchedEpisodes
  )

  if (newState) {
    show.nextUpDismissed = newState.nextUpDismissed
    show.continueWatchingDismissed = newState.continueWatchingDismissed
    return show
  }

  return null
}

export async function markAsWatched(itemId: string, userId: string): Promise<void> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return

  // Files (episodes, movies) have no children — skip the recursive query entirely.
  const descendants = item.type === 'file' ? [] : repositoryService.getAllDescendantsAsList(item as MediaFolder)
  const itemsToUpdate = [item, ...descendants]
  userRepo.overlayUserState(itemsToUpdate, userId)

  const now = Date.now()
  const newlyWatchedEpisodes: MediaFile[] = []
  const fileItems: MediaFile[] = []

  for (const i of itemsToUpdate) {
    if (i.type === 'file') {
      if (!i.watched && i.mediaType === 'episode') {
        newlyWatchedEpisodes.push(i as MediaFile)
      }
      i.watched = true
      i.lastWatched = now
      fileItems.push(i as MediaFile)
    }
  }

  log(
    `[Continue Watching] markAsWatched: itemsToUpdate=${itemsToUpdate.length}, newlyWatched=${newlyWatchedEpisodes.length}`
  )

  // Bulk-write watched state for all file items in one SQL statement.
  userRepo.bulkSetWatched(fileItems.map((f) => f.id), userId, true, now)

  // --- Logic for Un-Dismissing + Next Up (show-level state, at most 1-2 items) ---
  let parent =
    item.type === 'folder' && item.mediaType === 'tv'
      ? (item as MediaFolder)
      : repositoryService.findParent(item.id)

  while (parent && (parent.type !== 'folder' || parent.mediaType !== 'tv')) {
    parent = repositoryService.findParent(parent.id)
  }

  // Show-level items with per-item state (nextUpEpisodeId, dismissals, lastWatched).
  // These are few (≤2) and go through _updateItem individually.
  const showLevelItems: LibraryItem[] = []

  if (parent) {
    if (parent.mediaType !== 'tv') {
      throw new Error(
        `INTERNAL ERROR: markAsWatched reached a non-tv parent for undismiss: ${parent.name} (${parent.mediaType})`
      )
    }

    let allShowEpisodes: import('../utils/continue-watching').EpisodeInfo[]
    if (parent.id === item.id) {
      allShowEpisodes = descendants.filter(
        (d) => d.type === 'file' && d.mediaType === 'episode'
      ) as MediaFile[]
    } else {
      allShowEpisodes = repositoryService.getEpisodeProgressForShow(parent.id, userId)
    }
    for (const ep of allShowEpisodes) {
      const mod = itemsToUpdate.find((i) => i.id === ep.id)
      if (mod) ep.watched = (mod as MediaFile).watched
    }

    const undismissedShow = await checkAndUndismissShow(
      parent.id,
      userId,
      newlyWatchedEpisodes,
      itemsToUpdate,
      allShowEpisodes as MediaFile[]
    )
    if (undismissedShow && !itemsToUpdate.find((i) => i.id === undismissedShow.id)) {
      itemsToUpdate.push(undismissedShow)
    }
    if (undismissedShow) showLevelItems.push(undismissedShow)

    const showWithNextUp = await recalculateNextUpForShow(parent.id, userId, itemsToUpdate, allShowEpisodes as MediaFile[])
    if (showWithNextUp) {
      if (!itemsToUpdate.find((i) => i.id === showWithNextUp.id)) {
        itemsToUpdate.push(showWithNextUp)
      }
      if (!showLevelItems.find((i) => i.id === showWithNextUp.id)) {
        showLevelItems.push(showWithNextUp)
      }
    }
  }

  // Write show-level user-state fields only — passing the full item would trigger
  // upsertMetadata (credits, genres) for the show on every watched toggle.
  repositoryService.runTransaction(() => {
    for (const i of showLevelItems) {
      repositoryService._updateItem(i.id, {
        nextUpEpisodeId: (i as any).nextUpEpisodeId,
        lastWatched: (i as any).lastWatched,
        continueWatchingDismissed: i.continueWatchingDismissed,
        nextUpDismissed: i.nextUpDismissed
      } as any, { skipFetch: true }, userId)
    }
  })

  // Stamp _v in memory and broadcast everything together.
  for (const i of itemsToUpdate) i._v = now
  await broadcastModifiedItems(itemsToUpdate)
}

// --- Continue Watching ---

export async function getContinueWatchingItems(
  userId: string,
  includeDismissed = false
): Promise<{ show: MediaFolder; nextEpisode: MediaFile }[]> {
  // 1. Fetch all shows that have progress (denormalized pointer)
  const showsWithProgress = repositoryService.find({
    fields: [
      ...repositoryService.CORE_FIELDS,
      'backdropPath',
      'nextUpEpisodeId',
      'continueWatchingDismissed',
      'nextUpDismissed'
    ],
    where: {
      type: 'folder',
      mediaType: 'tv',
      nextUpEpisodeId: { $ne: null }
      // We'll filter dismissed in-memory or improve the repository helper
      // but for now let's see if we get ANY results.
    },
    orderBy: { field: 'lastWatched', direction: 'DESC' },
    userId
  }) as MediaFolder[]

  let filtered = showsWithProgress
  if (!includeDismissed) {
    filtered = showsWithProgress.filter((s) => !s.continueWatchingDismissed)
  }

  if (filtered.length === 0) return []

  const results: { show: MediaFolder; nextEpisode: MediaFile }[] = []

  for (const show of filtered) {
    if (!show.nextUpEpisodeId) continue

    // 2. Fetch the specific next episode using its ID
    const nextEpisode = repositoryService.getItemById(show.nextUpEpisodeId) as MediaFile
    if (!nextEpisode) {
      // Data inconsistency: Show points to an episode that no longer exists.
      // We should probably trigger a recalculation here.
      const showWithFixedPointer = await recalculateNextUpForShow(show.id, userId)
      if (showWithFixedPointer) {
        await updateIfChangedAndBroadcast(showWithFixedPointer, { userId })
      }
      continue
    }

    // 3. Ensure we have the minimum required fields for the episode to be useful
    if (!nextEpisode.title) {
      const updatedItems = await metadataService.fetchEpisodeDataForContinueWatching(
        show,
        nextEpisode
      )
      if (updatedItems.length > 0) {
        await updateIfChangedAndBroadcast(updatedItems)
        const fresh = repositoryService.getItemById(nextEpisode.id) as MediaFile
        if (fresh) Object.assign(nextEpisode, fresh)
      }
    }

    results.push({
      show: repositoryService.createTransferableCopy(show) as MediaFolder,
      nextEpisode: repositoryService.createTransferableCopy(nextEpisode) as MediaFile
    })
  }

  return results
}

// --- Passthroughs ---

export const autocompleteSuggestions = fetchAutocompleteSuggestions
export const getAutocompleteSuggestions = fetchAutocompleteSuggestions
export const getGroupByKeys = async () => {
  return (await import('./autocomplete.service')).getGroupByKeys()
}
export const getAutocompleteValues = async (key: string, query?: string, limit?: number) => {
  return (await import('./autocomplete.service')).getAutocompleteValues(key, query, limit)
}

export const performSearch = searchService.performSearch
export const debugPerformSearch = searchService.debugPerformSearch
export const manualSearch = async (query: string, type: any, year?: string, tmdbId?: string) => {
  const { tmdbApiKey } = await settingsService.readSettings()
  return retrieverService.manualSearch(query, type, tmdbApiKey, { year, tmdbId })
}
export const getTmdbImages = async (id: number, type: any, language?: string) => {
  const { tmdbApiKey } = await settingsService.readSettings()
  return retrieverService.getImages(id, type, tmdbApiKey, language)
}
export const executeCustomAction = actionsService.executeCustomAction
export const getAbsolutePathForItem = actionsService.getAbsolutePathForItem
export const getItemProperties = actionsService.getItemProperties
export const revealInExplorer = actionsService.revealInExplorer
export const trashItem = async (itemId: string): Promise<{ success: boolean }> => {
  const success = await actionsService.trashItem(itemId)
  if (success) {
    repositoryService.deleteItem(itemId)
    getTransport().notifyLibraryItemDeleted(itemId)
  }
  return { success }
}
export const renameItem = async (
  itemId: string,
  newName: string
): Promise<{ success: boolean }> => {
  const newRelPath = await actionsService.renameItem(itemId, newName)
  await handleItemRenamed(itemId, newRelPath)
  return { success: true }
}
export const getItemById = async (id: string) => {
  const item = repositoryService.getItemById(id)
  return item ? repositoryService.createTransferableCopy(item) : null
}
export const getParent = navigationService.getParent
export const getChildren = navigationService.getChildren
export const getHiddenChildren = async (parentId: string): Promise<LibraryItem[]> => {
  const children = repositoryService.getChildren(
    parentId,
    [...repositoryService.CORE_FIELDS, 'isHidden'],
    true
  )
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
    metadataService.fetchAndApplyMetadata(show, { force: true }).catch((err: any) => {
      console.error(`[Library] Background assignment enrichment failed for "${show.name}":`, err)
    })
  }

  log(`[Library] Assignment complete for show ${showId}.`)
}
export const clearItemMetadata = (itemId: string, childrenOnly: boolean) =>
  metadataService.clearItemMetadata(itemId, { childrenOnly })
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
export const getContinueWatchingForShow = async (showId: string, userId: string) => {
  const all = await getContinueWatchingItems(userId, true) // Include dismissed so we can show "Next Up" even if removed from Home
  const found = all.find((r) => r.show.id === showId)
  // For the detail view, we filter by nextUpDismissed here or let the UI handle it.
  if (found && found.show.nextUpDismissed) {
    return null
  }
  return found || null
}
export const setContinueWatchingDismissed = async (showId: string, userId: string) => {
  const item = repositoryService.getItemById(showId)
  if (item) {
    userRepo.overlayUserState([item], userId)
    const newState = applyContinueWatchingDismissal({
      continueWatchingDismissed: !!item.continueWatchingDismissed,
      nextUpDismissed: !!item.nextUpDismissed,
    })
    item.continueWatchingDismissed = newState.continueWatchingDismissed
    item.nextUpDismissed = newState.nextUpDismissed
    await updateIfChangedAndBroadcast(item, { userId })
  }
}
export const setNextUpDismissed = async (showId: string, userId: string) => {
  const item = repositoryService.getItemById(showId)
  if (item) {
    userRepo.overlayUserState([item], userId)
    const newState = applyNextUpDismissal({
      continueWatchingDismissed: !!item.continueWatchingDismissed,
      nextUpDismissed: !!item.nextUpDismissed,
    })
    item.continueWatchingDismissed = newState.continueWatchingDismissed
    item.nextUpDismissed = newState.nextUpDismissed
    await updateIfChangedAndBroadcast(item, { userId })
  }
}
export const fetchCredits = (itemId: string) => metadataService.fetchCredits(itemId)
export const getItemCredits = (id: string) => repositoryService.getItemCredits(id)
export const handleItemRenamed = async (oldItemId: string, newRelPath: string) => {
  const oldItem = repositoryService.getItemById(oldItemId)
  if (!oldItem) return

  const newItem = repositoryService.updateItemPathAndId(oldItemId, newRelPath)
  if (newItem) {
    getTransport().notifyLibraryItemDeleted(oldItem.id)
    getTransport().notifyLibraryItemsUpdated([newItem])

    const parent = repositoryService.findParent(newItem.id)
    if (parent) {
      const sourceId = newItem.sourceId
      const absSourcePath = sourceId ? await settingsService.getAbsoluteSourcePath(sourceId) : null
      if (absSourcePath) {
        await filesystemService.syncWithDisk(parent, { id: sourceId!, absolutePath: absSourcePath })
      }

      // If we renamed something inside a TV show, recalculate the pointer
      // (IDs change when paths change)
      let showParent: MediaFolder | null = parent as MediaFolder
      while (showParent && (showParent.type !== 'folder' || showParent.mediaType !== 'tv')) {
        showParent = repositoryService.findParent(showParent.id) as MediaFolder
      }

      if (showParent) {
        const updatedShow = await recalculateNextUpForShow(showParent.id, null)
        if (updatedShow) {
          await updateIfChangedAndBroadcast(updatedShow)
        }
      }
    }
  }
}
export const updateItem = async (item: LibraryItem, isUser: boolean) => {
  log(`updateItem triggered for ID: ${item.id} (isUser: ${isUser})`)
  const updates = { ...item }

  // --- 1. Check for Child View Overrides (Parent overrides a specific child's style) ---
  // TODO: This does not belong here. Caller should be responsible for this. Semantically, this function should update this item only.
  if (updates.overrideChildId) {
    log(
      `Override redirection triggered: Saving view settings for child ${updates.overrideChildId} into parent ${updates.id}`
    )
    const parentId = updates.id
    const childId = updates.overrideChildId

    // 1. Resolve the storage item — virtual folders are first-class rows with their own settings
    const storageItem = (repositoryService.getItemById(parentId) as MediaFolder) || null

    if (storageItem) {
      if (!storageItem.viewSettings) storageItem.viewSettings = {}

      // Ensure the override plumbing exists
      if (!storageItem.viewSettings.childViewSettings) storageItem.viewSettings.childViewSettings = {}
      if (!storageItem.viewSettings.childViewSettings.overrides) {
        storageItem.viewSettings.childViewSettings.overrides = {}
      }

      // Update the override
      storageItem.viewSettings.childViewSettings.overrides[childId] = updates.viewSettings ?? {}

      await updateIfChangedAndBroadcast([storageItem])
      return
    }
  }

  // --- 2. Standard Item Update with Robust Locking ---
  // Virtual folders are first-class items with their own folder_settings rows;
  // no settings redirect needed.
  const existing = repositoryService.getItemById(updates.id)
  if (existing && isUser) {
    const currentLocks = new Set(existing.lockedFields ?? [])

    // Handle manual lock toggles from UI
    if (
      (updates as any).lockedFields &&
      typeof (updates as any).lockedFields === 'object' &&
      !Array.isArray((updates as any).lockedFields)
    ) {
      const explicitLocks = (updates as any).lockedFields as Record<string, boolean>
      for (const [field, isLocked] of Object.entries(explicitLocks)) {
        if (isLocked) currentLocks.add(field)
        else currentLocks.delete(field)
      }
      delete (updates as any).lockedFields
    }

    // Auto-lock fields that are being changed by a user
    for (const key of METADATA_KEYS) {
      const newValue = (updates as any)[key]
      const oldValue = (existing as any)[key]

      if (newValue !== undefined) {
        const isPrimitive = typeof newValue !== 'object' || newValue === null
        const isChanged = isPrimitive ? newValue !== oldValue : !equal(newValue, oldValue)
        if (isChanged) {
          currentLocks.add(key)
          log(`[Auto-Lock] Locking field "${key}" for item "${existing.name}" due to user update.`)
        }
      }
    }

    updates.lockedFields = Array.from(currentLocks)
  }

  // --- 4. Final Normalization ---
  // (groupBy is now independent of layout — no clearing needed)

  // --- 5. Execution ---
  await updateIfChangedAndBroadcast([updates], { updateSuggestions: true })
}
export const deleteItemFromDb = async (id: string): Promise<{ success: boolean }> => {
  const res = repositoryService.deleteItem(id)
  if (res) {
    getTransport().notifyLibraryItemDeleted(id)
    return { success: true }
  }
  return { success: false }
}

export const recordPlayback = async (itemId: string, userId: string) => {
  const item = repositoryService.getItemById(itemId)
  if (!item) return

  userRepo.overlayUserState([item], userId)

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
    const undismissedShow = await checkAndUndismissShow(
      parent.id,
      userId,
      [item as MediaFile],
      modifiedItems
    )
    if (undismissedShow) {
      modifiedItems.push(undismissedShow)
    }

    // ALWAYS recalculate next_up_episode_id when watching something in a show
    const showWithNextUp = await recalculateNextUpForShow(parent.id, userId, modifiedItems)
    if (showWithNextUp) {
      modifiedItems.push(showWithNextUp)
    }
  }

  await updateIfChangedAndBroadcast(modifiedItems, { userId })
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
      folder.folderSettings = {
        retrieveChildrenMetadata: s.retrieve,
        childrenTypeHint: s.hint ?? null,
        processTvChildren: folder.folderSettings?.processTvChildren ?? true
      }
      itemsToUpdate.push(folder)
    }
  }

  if (itemsToUpdate.length > 0) {
    await updateIfChangedAndBroadcast(itemsToUpdate)
  }
  metadataService.enrichDatabase().catch(console.error)
}

/**
 * Synchronous core: reapply virtual tags and sync any affected groupings.
 * Extracted so it can be tested directly without async/IO dependencies.
 */
export function reapplyVirtualTags(virtualTags: Parameters<typeof virtualTagsService.applyVirtualTags>[0]): void {
  virtualTagsService.applyVirtualTags(virtualTags)
  groupingService.syncAllGroupings()
  accountFilterService.rebuildAll()
}

export const reapplyVirtualTagsAfterSettingsChange = async () => {
  const settings = await settingsService.readSettings()
  reapplyVirtualTags(settings.virtualTags)

  // Refresh suggestions and group-by keys, and tell UI to invalidate item cache
  const [suggestions, groupByKeys] = await Promise.all([
    getAutocompleteSuggestions(),
    getGroupByKeys()
  ])
  getTransport().notifyMetadataIndexUpdated({ suggestions, groupByKeys, invalidateItems: true })
}

export const getFolderWatchedState = async (
  folderId: string,
  userId: string
): Promise<'fully' | 'partially' | 'unwatched' | 'none'> => {
  const folder = repositoryService.getItemById(folderId)
  if (!folder || folder.type !== 'folder') return 'none'
  const descendants = repositoryService.getAllDescendantsAsList(folder as MediaFolder)
  const files = descendants.filter((d) => d.type === 'file')
  if (files.length === 0) return 'none'
  userRepo.overlayUserState(files, userId)
  const watchedCount = files.filter((f) => f.watched).length
  if (watchedCount === files.length) return 'fully'
  if (watchedCount > 0) return 'partially'
  return 'unwatched'
}

export async function getItemPath(itemId: string): Promise<string | null> {
  const item = repositoryService.getItemById(itemId)
  if (!item || !item.path || !item.sourceId) return null
  return actionsService.getAbsolutePathForItem(itemId)
}
