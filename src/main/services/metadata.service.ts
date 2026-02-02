import path from 'path'
import fs from 'fs/promises'

import * as repositoryService from './repository.service'
import * as virtualTagsService from './virtualTags.service'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import * as retrieverService from './retriever.service'
import * as tvShowService from './tv-show.service'
import { processInChunks } from '../utils/concurrency'
import { downloadImage } from '../utils/download'
import { updateIfChangedAndBroadcast } from './item-update.service'

import type { LibraryItem, MediaFile, MediaFolder } from '../../shared/types'
import { RESETTABLE_METADATA_KEYS } from '../../shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Metadata Service] ${message}`)
}

// function hasMediaFilesRecursive(folder: MediaFolder): boolean {
//   if (!folder.children) return false
//   for (const child of folder.children) {
//     if (child.type === 'file') return true
//     if (child.type === 'folder' && hasMediaFilesRecursive(child as MediaFolder)) return true
//   }
//   return false
// }


// Helper to check if an item's parent has retrieve_children_metadata enabled (The Gate)
function isMetadataEnabledForItem(itemId: string): boolean {
  const parent = repositoryService.findParent(itemId)
  if (!parent) return false
  return parent.retrieve_children_metadata === true
}


export async function fetchMetadataForLibrary() {
  const settings = await settingsService.readSettings()
  if (!settings.tmdbApiKey) {
    console.warn('Metadata fetch skipped: No TMDB API key.')
    return
  }

  // 1. Discovery: Find items that need identification or enrichment
  const allItems = repositoryService.getAllItemsAsList()
  if (allItems.length === 0) return

  const itemsToProcess = allItems.filter((item) => {
    if (item.isHidden || item.isMissing) return false

    // GATE: Only process items whose parent has retrieve_children_metadata enabled
    if (!isMetadataEnabledForItem(item.id)) return false

    // Needs Identification
    if (!item.tmdbId && !item.lastRefreshedAt) return true

    // Needs Enrichment (Details/Images/Structural sync)
    // We also run the orchestrator if lastRefreshedAt is NULL (Dirty flag)
    if (!item.lastRefreshedAt) return true

    // TV Show Structural Integrity Check (Dynamic Container)
    // TV Shows are processed every time because they are dynamic containers.
    // The orchestrator handles the internal freshness check for network calls,
    // but must always run Structural Sync and Managed Copy.
    if (item.mediaType === 'tv') return true

    return false
  })

  if (itemsToProcess.length === 0) {
    log('[Metadata] No items need update.')
    return
  }

  log(`[Metadata] Starting update for ${itemsToProcess.length} items using Unified Orchestrator.`)

  // 2. Processing: Use the Orchestrator for each dirty item
  // We use chunks to avoid overwhelming the network/API
  await processInChunks(itemsToProcess, 5, async (item) => {
    // Optimization: If it's an episode or season, we only call orchestrator 
    // if it's "orphan" or if we want to force its individual update.
    // However, calling handleItemUpdate is safe as it skips work if already fresh.
    const modifiedItems = await handleItemUpdate(item)

    if (modifiedItems.length > 0) {
      await updateIfChangedAndBroadcast(modifiedItems)
    }
  })

  await repositoryService.writeDb()
  log('[Metadata] Run complete.')
}

export async function fetchEpisodeDataForContinueWatching(
  show: MediaFolder,
  episode: MediaFile
): Promise<LibraryItem[]> {
  log(
    `[Continue Watching] fetchEpisodeData triggered for Show: "${show.name}", Episode S${episode.seasonNumber}E${episode.episodeNumber}`
  )
  if (episode.title && episode.posterPath) return []
  if (!show.tmdbId || !show.tmdbSeasons || pathsService.isRemoteLibrary()) return []

  // 1. Populate show children to allow structure processing
  if (!show.children || show.children.length === 0) {
    show.children = repositoryService.getChildren(show.id)
  }

  // 2. Process structure to assign seasonNumbers to folders (in-memory)
  // tvShowService.processTvShowStructure(show) // Deprecated

  // 3. Find season folder matching the episode's season number
  const seasonFolder = show.children.find(
    (c) => c.type === 'folder' && c.seasonNumber === episode.seasonNumber
  ) as MediaFolder | undefined

  if (seasonFolder) {
    // 4. Populate the season folder's children (episodes) so retriever can match them
    seasonFolder.children = repositoryService.getChildren(seasonFolder.id)
  }

  let itemsToUpdate: LibraryItem[] = []
  const wasBulkUpdating = repositoryService.getBulkUpdateStatus()
  repositoryService.setBulkUpdateStatus(true)
  try {
    const settings = await settingsService.readSettings()
    if (!settings.tmdbApiKey) return []
    if (seasonFolder) {
      // Check if season is known in TMDB data
      const seasonKnown = show.tmdbSeasons?.some(
        (s) => s.season_number === seasonFolder?.seasonNumber
      )
      if (!seasonKnown) {
        log(
          `[Continue Watching] Season ${seasonFolder.seasonNumber} not found in cached metadata. Refetching show seasons...`
        )
        await retrieverService.refetchShowSeasons(show, settings, pathsService.getLibraryDataPath())
        // Re-fetch parent to get updated tmdbSeasons
        const updatedShow = repositoryService.getItemById(show.id) as MediaFolder
        if (updatedShow) show.tmdbSeasons = updatedShow.tmdbSeasons
      }

      if (!seasonFolder.lastRefreshedAt) {
        log(
          `[Continue Watching] Next episode "${episode.name}" is in an unfetched season. Fetching S${seasonFolder.seasonNumber}...`
        )
        const modifiedEpisodes = await retrieverService.fetchAndApplyEpisodeData(
          seasonFolder,
          show.tmdbId,
          settings.tmdbApiKey,
          pathsService.getLibraryDataPath(),
          show.tmdbSeasons ?? undefined,
          { respectLocks: true }
        )
        itemsToUpdate = [seasonFolder, ...modifiedEpisodes]
      }
    } else {
      if (!show.lastRefreshedAt) {
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
    repositoryService.setBulkUpdateStatus(wasBulkUpdating)
  }
  return itemsToUpdate
}

async function _unlinkItemImages(
  item: LibraryItem,
  imagesDir: string,
  options: { respectLocks?: boolean } = { respectLocks: true }
) {
  if (pathsService.isRemoteLibrary()) return

  if (item.posterPath && (!options.respectLocks || !repositoryService.isFieldLocked(item, 'posterPath')))
    try {
      await fs.unlink(path.join(imagesDir, item.posterPath))
    } catch { }
  if (item.backdropPath && (!options.respectLocks || !repositoryService.isFieldLocked(item, 'backdropPath')))
    try {
      await fs.unlink(path.join(imagesDir, item.backdropPath))
    } catch { }
  if (item.logoPath && (!options.respectLocks || !repositoryService.isFieldLocked(item, 'logoPath')))
    try {
      await fs.unlink(path.join(imagesDir, item.logoPath))
    } catch { }
}

function _resetItemMetadataFields(
  item: LibraryItem,
  options: { respectLocks?: boolean } = { respectLocks: true }
) {
  for (const key of RESETTABLE_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(item, key)) {
      if (options.respectLocks && repositoryService.isFieldLocked(item, key)) {
        continue
      }
      const itemAsRecord = item as Record<string, any>
      switch (key) {
        case 'tags':
          itemAsRecord[key] = {}
          break
        case 'genres':
          itemAsRecord[key] = []
          break
        case 'lastRefreshedAt':
          itemAsRecord[key] = null
          break
        case 'lockedFields':
          itemAsRecord[key] = []
          break
        case 'opensAsFolder':
        case 'virtualTags':
        case 'continueWatchingDismissed':
        case 'nextUpDismissed':
        case '_lastSeenLocalMaxSeason':
        case '_lastSeenLocalMaxEpisode':
          itemAsRecord[key] = undefined
          break

        case 'overview':
        case 'tmdbId':
        case 'year':
        case 'tmdbSeasons':
        case 'tmdbEpisodes':
        case 'tmdbCredits':
        case 'title':
        case 'originalTitle':
        case 'releaseDate':
        case 'mediaType':
        case 'seasonNumber':
        case 'episodeNumber':
        case 'posterPath':
        case 'backdropPath':
        case 'logoPath':
          itemAsRecord[key] = null
          break
      }
    }
  }
  item._v = Date.now()
}

// ... (skipping _clearChildrenRecursively and _finalizeMetadataClear unchanged) ...

// ... (skipping clearItemMetadata and clearVirtualFolderMetadata unchanged) ...

/**
 * The Unified Orchestrator: handleItemUpdate
 * Orchestrates the entire scan/analysis/metadata fetch flow for a single item.
 * Ensuring identification, enrichment, structural sync, and managed copy run in order.
 */
export async function handleItemUpdate(item: LibraryItem, options: { force?: boolean } = {}): Promise<LibraryItem[]> {
  const settings = await settingsService.readSettings()
  const libraryDataPath = pathsService.getLibraryDataPath()
  const allModifiedItems: LibraryItem[] = [item]

  if (pathsService.isRemoteLibrary()) return []

  // Ensure Bulk Update mode is on to prevent redundant DB writes/broadcasts
  const wasBulkUpdating = repositoryService.getBulkUpdateStatus()
  repositoryService.setBulkUpdateStatus(true)

  try {
    // 1. Identification (If missing)
    if (!item.tmdbId && !item.lastRefreshedAt) {
      log(`[Orchestrator] Identification needed for "${item.name}" (id: ${item.id})`)
      const parent = item.parentId
        ? (repositoryService.getItemById(item.parentId) as MediaFolder)
        : null
      const typeHint = parent?.children_type_hint

      await retrieverService.searchTmdbAndApplyMetadata(
        item,
        settings.tmdbApiKey!,
        libraryDataPath,
        typeHint
      )
    }

    // 2. Conditional Enrichment (Full details fetch)
    // SKIP for seasons: They are enriched in Managed Copy (Phase 4) using the TV/Season endpoint.
    if (item.tmdbId && !item.lastRefreshedAt && item.mediaType !== 'season') {
      log(`[Orchestrator] Enrichment needed for "${item.name}" (id: ${item.id})`)
      const modified = await retrieverService.fetchItemDetails(
        item,
        settings,
        libraryDataPath,
        { respectLocks: true }
      )
      allModifiedItems.push(...modified)
      // Credits fetch happens inside identification or details? 
      // retrieverService.fetchItemDetails doesn't seem to fetch credits. 
      // retrieverService.searchTmdbAndApplyMetadata DOES fetch credits.
      // Let's ensure credits are always there if refreshed.
      if (item.mediaType === 'movie' || item.mediaType === 'tv') {
        if (!item.tmdbCredits) {
          await retrieverService.fetchAndApplyCredits(item, settings.tmdbApiKey!)
        }
      }
    }

    // 3. Structural Sync (For TV Shows)
    // Runs every time to ensure hierarchy matches disk, even if details are fresh.
    // Respects process_tv_children flag (unless forced).
    if (item.type === 'folder' && item.mediaType === 'tv' && ((item as MediaFolder).process_tv_children !== false || options.force)) {
      log(`[Orchestrator] Structural Sync for TV Show "${item.name}"`)
      const modified = await tvShowService.syncTvShowStructure(item as MediaFolder)
      allModifiedItems.push(...modified)
    }

    // 4. Managed Copy (TV Hierarchy propagation)
    // Ensures episodes get their names/posters from the show/season cache.
    // Respects process_tv_children flag (unless forced).
    if ((item.mediaType === 'tv' || item.mediaType === 'season') && ((item as any).process_tv_children !== false || options.force)) {
      log(`[Orchestrator] Managed Copy for ${item.mediaType} "${item.name}"`)
      const modified = await retrieverService.applyTvShowData(
        item as MediaFolder,
        settings,
        libraryDataPath,
        { respectLocks: true, force: options.force }
      )
      allModifiedItems.push(...modified)
    }

    // 5. Finalize
    const now = Date.now()
    item.lastRefreshedAt = now
    item.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(item, settings)

    // Finalize all changes
    await updateIfChangedAndBroadcast(allModifiedItems)

    return allModifiedItems
  } catch (error) {
    console.error(`[Orchestrator] Error handling update for "${item.name}":`, error)
    return []
  } finally {
    repositoryService.setBulkUpdateStatus(wasBulkUpdating)
  }
}

export async function backgroundFetchAndApplyDetails(item: LibraryItem, options: { force?: boolean } = {}): Promise<LibraryItem[]> {
  const needsRefresh = !item.lastRefreshedAt
  const isTV = item.type === 'folder' && item.mediaType === 'tv'

  log(`[Details] check for "${item.name}". needsRefresh=${needsRefresh}, isTV=${isTV}`)

  // GATE: If it's a file and it's already clean, exit.
  if (item.type === 'file' && !needsRefresh) {
    return []
  }

  // Use the orchestrator
  return await handleItemUpdate(item, options)
}

export async function applyManualMatch(
  itemId: string,
  result: Record<string, any>,
  mediaType: 'movie' | 'tv' | 'season'
): Promise<LibraryItem[]> {
  if (pathsService.isRemoteLibrary()) {
    throw new Error('Applying metadata is not available for read-only remote libraries.')
  }
  const item = repositoryService.getItemById(itemId)
  if (!item) return []
  const settings = await settingsService.readSettings()
  // const libraryDataPath = pathsService.getLibraryDataPath()
  if (!settings.tmdbApiKey) return []

  log(`[Manual Match] Applying ${mediaType} match to "${item.name}" (id: ${itemId})`)

  // Ensure Bulk Update mode is on
  const wasBulkUpdating = repositoryService.getBulkUpdateStatus()
  repositoryService.setBulkUpdateStatus(true)

  try {
    // const imagesDir = path.join(libraryDataPath, 'images')

    // 1. PRIME: Clear current identity and freshness to trigger the orchestrator
    // We use targetedClear to ensure hierarchy is reset correctly without a blind full recursive wipe.
    const clearedItem = await clearItemMetadata(itemId, { targetedClear: true })

    if (!clearedItem) return [] // Safety check

    // Use this fresh reference for the rest of the function
    const item = clearedItem

    if (mediaType === 'season' && typeof result.season_number === 'number') {
      item.seasonNumber = result.season_number
    }
    item.tmdbId = result.id
    item.mediaType = mediaType
    item.lastRefreshedAt = null // Ensure orchestrator runs enrichment

    // 1.5 LOCKING: Defend the manual match from being overwritten by structural sync
    if (!item.lockedFields) item.lockedFields = []
    if (!item.lockedFields.includes('tmdbId')) {
      item.lockedFields.push('tmdbId')
    }
    if (mediaType === 'season' && !item.lockedFields.includes('seasonNumber')) {
      item.lockedFields.push('seasonNumber')
    }

    // 1.6 Persistence: Save locks/identity to DB immediately.
    // This is required because syncTvShowStructure reads from the DB, not memory.
    await updateIfChangedAndBroadcast(item)

    const structuralChanges: LibraryItem[] = []

    // 1.7 Structural Sync (Manual Fix Match Special Case)
    // If we just manually assigned a Season, we MUST re-run the Show's structural analysis
    // so that episodes are re-numbered according to this new locked season number.
    if (mediaType === 'season' && item.parentId) {
      const parent = repositoryService.getItemById(item.parentId)
      if (parent && parent.mediaType === 'tv') {
        const modified = await tvShowService.syncTvShowStructure(parent as MediaFolder, 'smart', 'smart', { force: true })
        structuralChanges.push(...modified)
      }
    }

    // 2. RUN ORCHESTRATOR
    const orchestratorChanges = await handleItemUpdate(item, { force: true })
    return [...structuralChanges, ...orchestratorChanges]
  } catch (err) {
    console.error(`[Manual Match] Failed for "${item.name}":`, err)
    return []
  } finally {
    repositoryService.setBulkUpdateStatus(wasBulkUpdating)
  }
}
export async function setImage(
  itemId: string,
  imageType: 'poster' | 'backdrop' | 'logo',
  source: { type: 'tmdb'; path: string } | { type: 'local'; path: string }
): Promise<LibraryItem | null> {
  if (pathsService.isRemoteLibrary()) {
    throw new Error('Setting images is not available for remote libraries.')
  }
  const item = repositoryService.getItemById(itemId)
  if (!item) return null
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
      await downloadImage(url, destPath)
    } else {
      await fs.copyFile(source.path, destPath)
    }
    if (imageType === 'poster') item.posterPath = fileName
    else if (imageType === 'backdrop') item.backdropPath = fileName
    else if (imageType === 'logo') item.logoPath = fileName
    item._v = Date.now()
    return item
  } catch (err) {
    console.error(`Failed to set image for ${itemId}:`, err)
    throw new Error('Failed to set the selected image. See logs for more details.')
  }
}

export async function removeImage(
  itemId: string,
  imageType: 'poster' | 'backdrop' | 'logo'
): Promise<LibraryItem | null> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return null
  if (imageType === 'poster') item.posterPath = null
  else if (imageType === 'backdrop') item.backdropPath = null
  else if (imageType === 'logo') item.logoPath = null
  item._v = Date.now()
  return item
}

/**
 * Clears metadata for an item and potentially its hierarchy.
 * 
 * @param itemId The unique ID of the item to clear.
 * @param options Configuration for the clearing operation:
 *  - childrenOnly: If true, clears all descendants but leaves the targeted item's metadata intact.
 *  - targetedClear: If true, clears the item itself. If it's a TV show or Season, it also resets
 *    the metadata for the immediate hierarchy (Seasons and Episodes) to ensure identity consistency
 *    during manual assignment. Unlike a full recursive wipe, this targets only standard TV entities.
 */
export async function clearItemMetadata(
  itemId: string,
  options: { childrenOnly?: boolean; targetedClear?: boolean } = {}
): Promise<LibraryItem | null> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return null

  const itemsToClear: LibraryItem[] = []

  if (options.childrenOnly) {
    if (item.type === 'folder') {
      const descendants = repositoryService.getAllDescendantsAsList(item as MediaFolder)
      itemsToClear.push(...descendants)
    }
  } else if (options.targetedClear) {
    itemsToClear.push(item)
    if (item.type === 'folder') {
      const children = repositoryService.getChildren(item.id)
      if (item.mediaType === 'tv') {
        // Clear direct seasons and all episodes (direct and under seasons)
        for (const child of children) {
          if (child.mediaType === 'season' || child.mediaType === 'episode') {
            itemsToClear.push(child)
            if (child.type === 'folder') {
              const episodes = repositoryService.getChildren(child.id)
              itemsToClear.push(...episodes.filter((e) => e.mediaType === 'episode'))
            }
          }
        }
      } else if (item.mediaType === 'season') {
        // Clear direct episodes
        itemsToClear.push(...children.filter((c) => c.mediaType === 'episode'))
      }
    }
  } else {
    // Default: Clear item and ALL descendants recursively
    itemsToClear.push(item)
    if (item.type === 'folder') {
      const descendants = repositoryService.getAllDescendantsAsList(item as MediaFolder)
      itemsToClear.push(...descendants)
    }
  }

  const imagesDir = path.join(pathsService.getLibraryDataPath(), 'images')

  // 1. Asynchronously unlink images first (cannot be in a transaction due to async)
  for (const targetItem of itemsToClear) {
    await _unlinkItemImages(targetItem, imagesDir, { respectLocks: false })
  }

  // 2. Execute field resets
  for (const targetItem of itemsToClear) {
    _resetItemMetadataFields(targetItem, { respectLocks: false })
  }

  await updateIfChangedAndBroadcast(itemsToClear)

  return item
}

export async function clearVirtualFolderMetadata(_itemIds: string[]): Promise<boolean> {
  return true
}
