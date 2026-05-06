import path from 'path'
import fs from 'fs/promises'

import * as repositoryService from './repository.service'
import * as virtualTagsService from './virtualTags.service'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import * as retrieverService from './retriever.service'
import * as tvShowService from './tv-show.service'
import * as metadataMapping from './metadata-processing.service'
import { processInChunks } from '../utils/concurrency'
import { downloadImage } from '../utils/download'
import { updateIfChangedAndBroadcast, broadcastModifiedItems } from './item-update.service'
import * as metadataRepo from '../database/repositories/metadata.repo'
import { syncVirtualSeasonFolders } from './grouping.service'
import { getTransport } from '../transport.registry'
import { runWithoutAccount } from '../request-context'
import * as filesystemService from './filesystem.service'
import * as autocompleteService from './autocomplete.service'

import type { LibraryItem, MediaFile, MediaFolder } from '@shared/types'
import { PRESERVED_ON_REASSIGN_FIELDS, RESETTABLE_METADATA_KEYS } from '@shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Metadata Service] ${message}`)
}

/**
 * Phase 2: Metadata Enrichment (DB -> API)
 */
export async function enrichDatabase() {
  return runWithoutAccount(async () => {
  const settings = await settingsService.readSettings()
  if (!settings.tmdbApiKey) {
    log('Enrichment skipped: No TMDB API key.')
    return
  }

  getTransport().notifyScanStatusChanged({ isMetadataFetchingLibrary: true })

  try {
    // 1. Preprocess TV Structural Changes
    const tvShowsWithChanges: LibraryItem[] = []
    const tvShowsToSync = repositoryService.getTvShowsForStructuralSync()

    if (tvShowsToSync.length > 0) {
      log(`[Phase 2] Preprocessing structure for ${tvShowsToSync.length} TV shows.`)
      for (const show of tvShowsToSync) {
        const modified = await tvShowService.syncTvShowStructure(show as MediaFolder)
        if (modified.length > 0) {
          log(
            `[Phase 2] [Structure] TV Show "${show.name}" has ${modified.length} structural changes.`
          )
          if (show.tmdbId) {
            tvShowsWithChanges.push(show)
          }
        }
      }
    }

    // 2. Discovery: Find "Logical Entry Points"
    const discoveredDirtyItems = repositoryService.getDiscoveryItemsForPhase2()
    const itemMap = new Map<string, LibraryItem>()
    discoveredDirtyItems.forEach((item: LibraryItem) => itemMap.set(item.id, item))
    tvShowsWithChanges.forEach((item) => itemMap.set(item.id, item))

    const entryPoints = Array.from(itemMap.values())

    if (entryPoints.length === 0) {
      log('[Phase 2] No dirty entry points found. Enrichment skipped.')
    } else {
      log(
        `[Phase 2] Discovery complete. Found ${entryPoints.length} logical entry points for enrichment.`
      )

      // 3. The Orchestration Loop
      await processInChunks(entryPoints, 5, async (item) => {
        const force = tvShowsWithChanges.some((show) => show.id === item.id)
        log(
          `[Phase 2] [${item.mediaType || item.type}] Enriching: "${item.name}"${force ? ' (Structural change detected)' : ''}`
        )
        await fetchAndApplyMetadata(item, { force })
      })
    }

    // 4. Maintenance Pass
    await maintenancePass()
  } finally {
    getTransport().notifyScanStatusChanged({ isMetadataFetchingLibrary: false })
  }

  await repositoryService.writeDb()
  log('[Phase 2] Enrichment complete.')
  }) // runWithoutAccount
}

export async function maintenancePass() {
  log('[Maintenance] Starting pass...')
  const settings = await settingsService.readSettings()
  const libraryDataPath = pathsService.getLibraryDataPath()
  const imagesDir = path.join(libraryDataPath, 'images')

  // 1. Filesystem Integrity Check (Existing)
  await filesystemService.verifyImagePaths(imagesDir)

  // 2. SQL Virtual Tag Sync
  log('[Maintenance] Syncing virtual tags via SQL...')
  virtualTagsService.applyVirtualTags(settings.virtualTags)

  // 3. Signal Frontend to Refresh Cache & Metadata Index
  log('[Maintenance] Notifying UI to refresh.')
  const [suggestions, groupByKeys] = await Promise.all([
    autocompleteService.getAutocompleteSuggestions(),
    autocompleteService.getGroupByKeys()
  ])

  getTransport().notifyMetadataIndexUpdated({
    suggestions,
    groupByKeys,
    invalidateItems: true
  })

  log('[Maintenance] Pass complete.')
}

export async function fetchAndApplyMetadata(
  item: LibraryItem,
  options: { force?: boolean; year?: number } = {}
): Promise<LibraryItem[]> {
  const settings = await settingsService.readSettings()
  const libraryDataPath = pathsService.getLibraryDataPath()
  const apiKey = settings.tmdbApiKey!
  const allModifiedItems: LibraryItem[] = [item]

  if (pathsService.isRemoteLibrary()) return []

  log(`[Orchestrator] fetchAndApplyMetadata for "${item.name}"`)

  const wasBulkUpdating = repositoryService.getBulkUpdateStatus()
  repositoryService.setBulkUpdateStatus(true)

  try {
    // 1. Identification
    if (!item.tmdbId && !item.lastRefreshedAt) {
      const query = item.name
      const parent = item.parentId
        ? (repositoryService.getItemById(item.parentId) as MediaFolder)
        : null
      const typeHint =
        parent?.folderSettings?.childrenTypeHint || (item.type === 'file' ? 'movie' : 'multi')

      const results = await retrieverService.search(query, typeHint as any, apiKey, {
        year: options.year?.toString()
      })
      const result = results[0]

      if (result) {
        item.tmdbId = result.id
        item.mediaType = result.media_type || (typeHint === 'multi' ? 'movie' : typeHint)
        if (
          item.mediaType === 'tv' &&
          (item as MediaFolder).folderSettings?.processTvChildren !== false
        ) {
          await tvShowService.syncTvShowStructure(item as MediaFolder)
        }
      } else {
        item.tmdbId = null
        item.lastRefreshedAt = Date.now()
        await updateIfChangedAndBroadcast(item)
        return allModifiedItems
      }
    }

    // 2. Enrichment (Details)
    if (item.tmdbId && item.mediaType !== 'season') {
      const details = await retrieverService.getDetails(item.tmdbId, item.mediaType as any, apiKey)
      if (details) {
        await metadataMapping.applyMetadataToItem(item, details, {
          respectLocks: true,
          libraryDataPath
        })

        if (item.mediaType === 'movie' || item.mediaType === 'tv') {
          const credits = await retrieverService.getCredits(
            item.tmdbId,
            item.mediaType as any,
            apiKey
          )
          if (credits) metadataMapping.applyCreditsToItem(item, credits)
        }
      }
    }

    // 3. Structural Sync (TV)
    if (
      item.type === 'folder' &&
      item.mediaType === 'tv' &&
      (item.folderSettings?.processTvChildren !== false || options.force)
    ) {
      const structuralChanges = await tvShowService.syncTvShowStructure(item as MediaFolder)
      allModifiedItems.push(...structuralChanges)
    }

    // 4. Managed Copy (TV propagation)
    if (
      (item.mediaType === 'tv' && item.folderSettings?.processTvChildren !== false) ||
      item.mediaType === 'season' ||
      options.force
    ) {
      const target =
        item.mediaType === 'season'
          ? (repositoryService.findParent(item.id) as MediaFolder)
          : (item as MediaFolder)
      if (target && target.tmdbId) {
        // Ensure targeted details are cached on the item for the mapping
        if (!target.tmdbSeasons) {
          const details = await retrieverService.getDetails(target.tmdbId, 'tv', apiKey)
          if (details?.seasons) target.tmdbSeasons = details.seasons
        }
        const modified = await metadataMapping.applyTvShowData(target, settings, libraryDataPath, {
          respectLocks: true,
          force: options.force
        })
        allModifiedItems.push(...modified)
      }
    }

    // 5. Finalize
    item.lastRefreshedAt = Date.now()
    await updateIfChangedAndBroadcast(allModifiedItems)

    return allModifiedItems
  } catch (error) {
    log(`[Orchestrator] Error: ${error}`)
    return []
  } finally {
    repositoryService.setBulkUpdateStatus(wasBulkUpdating)
  }
}

export async function fetchEpisodeDataForContinueWatching(
  show: MediaFolder,
  episode: MediaFile
): Promise<LibraryItem[]> {
  if (episode.title && episode.posterPath) return []
  const settings = await settingsService.readSettings()
  if (!settings.tmdbApiKey || !show.tmdbId) return []

  // Ensure we have season structure
  if (!show.children || show.children.length === 0) {
    show.children = repositoryService.getChildren(show.id)
  }

  const seasonFolder = show.children.find(
    (c) => c.type === 'folder' && c.seasonNumber === episode.seasonNumber
  ) as MediaFolder | undefined

  const wasBulkUpdating = repositoryService.getBulkUpdateStatus()
  repositoryService.setBulkUpdateStatus(true)

  try {
    // Re-fetch seasons if needed
    if (!show.tmdbSeasons) {
      const details = await retrieverService.getDetails(show.tmdbId, 'tv', settings.tmdbApiKey)
      if (details?.seasons) show.tmdbSeasons = details.seasons
    }

    const modified = await metadataMapping.fetchAndApplyEpisodeData(
      seasonFolder || show,
      show.tmdbId,
      settings.tmdbApiKey,
      pathsService.getLibraryDataPath(),
      show.tmdbSeasons ?? undefined
    )

    await updateIfChangedAndBroadcast(modified)
    return modified
  } finally {
    repositoryService.setBulkUpdateStatus(wasBulkUpdating)
  }
}

export async function applyManualMatch(
  itemId: string,
  result: Record<string, any>,
  mediaType: 'movie' | 'tv' | 'season'
): Promise<LibraryItem[]> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return []

  log(`[Manual Match] Priming "${item.name}" for ${mediaType} match...`)

  const wasBulkUpdating = repositoryService.getBulkUpdateStatus()
  repositoryService.setBulkUpdateStatus(true)

  // Capture user-controlled fields before clearing — these must survive reassignment
  const preservedValues: Partial<Record<(typeof PRESERVED_ON_REASSIGN_FIELDS)[number], any>> = {}
  for (const field of PRESERVED_ON_REASSIGN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(item, field)) {
      preservedValues[field] = (item as any)[field]
    }
  }

  try {
    // 1. PRIME: Clear current identity and freshness, then restore preserved fields
    const clearedItem = await clearItemMetadata(itemId, { targetedClear: true })
    if (!clearedItem) return []

    const item = clearedItem

    // Restore preserved fields after clear
    for (const field of PRESERVED_ON_REASSIGN_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(preservedValues, field)) {
        ;(item as any)[field] = preservedValues[field]
      }
    }
    if (mediaType === 'season' && typeof result.season_number === 'number') {
      item.seasonNumber = result.season_number
    }
    item.tmdbId = result.id
    item.mediaType = mediaType
    item.lastRefreshedAt = null

    // LOCK identity
    if (!item.lockedFields) item.lockedFields = []
    if (!item.lockedFields.includes('tmdbId')) item.lockedFields.push('tmdbId')
    if (mediaType === 'season' && !item.lockedFields.includes('seasonNumber'))
      item.lockedFields.push('seasonNumber')

    await updateIfChangedAndBroadcast(item)

    // 2. TRIGGER BACKGROUND ENRICHMENT
    const runBackgroundEnrichment = async () => {
      repositoryService.setBulkUpdateStatus(true)
      try {
        if (mediaType === 'season' && item.parentId) {
          const parent = repositoryService.getItemById(item.parentId) as MediaFolder
          if (parent && parent.mediaType === 'tv') {
            await tvShowService.syncTvShowStructure(parent, 'smart', 'smart', {
              scopedToId: item.id
            })
          }
        }
        await fetchAndApplyMetadata(item, { force: true })
      } catch (err) {
        log(`[Manual Match] Background enrichment failed: ${err}`)
      } finally {
        repositoryService.setBulkUpdateStatus(wasBulkUpdating)
      }
    }

    runBackgroundEnrichment()
    return [item]
  } catch (err) {
    log(`[Manual Match] Priming failed: ${err}`)
    repositoryService.setBulkUpdateStatus(wasBulkUpdating)
    return []
  }
}

export async function clearItemMetadata(
  itemId: string,
  options: { childrenOnly?: boolean; targetedClear?: boolean } = {}
): Promise<LibraryItem | null> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return null

  const itemsToFullClear: LibraryItem[] = []
  const itemsToUpdate: LibraryItem[] = []

  if (options.childrenOnly) {
    if (item.type === 'folder') {
      const descendants = repositoryService.getAllDescendantsAsList(item as MediaFolder)
      itemsToFullClear.push(...descendants)
      const parentAsRecord = item as any
      parentAsRecord.tmdbSeasons = null
      parentAsRecord.tmdbEpisodes = null
      parentAsRecord._lastSeenLocalMaxSeason = undefined
      parentAsRecord._lastSeenLocalMaxEpisode = undefined
      parentAsRecord._v = Date.now()
    }
  } else if (options.targetedClear) {
    itemsToFullClear.push(item)
    if (item.type === 'folder') {
      const children = repositoryService.getChildren(item.id)
      if (item.mediaType === 'tv') {
        for (const child of children) {
          if (child.mediaType === 'season' || child.mediaType === 'episode') {
            itemsToFullClear.push(child)
            if (child.type === 'folder') {
              const episodes = repositoryService.getChildren(child.id)
              itemsToFullClear.push(...episodes.filter((e) => e.mediaType === 'episode'))
            }
          }
        }
      } else if (item.mediaType === 'season') {
        itemsToFullClear.push(...children.filter((c) => c.mediaType === 'episode'))
      }
    }
  } else {
    itemsToFullClear.push(item)
    if (item.type === 'folder') {
      itemsToFullClear.push(...repositoryService.getAllDescendantsAsList(item as MediaFolder))
    }
  }

  // Capture show ID before clearing resets mediaType
  let showIdForVirtualSync: string | null = null
  if (item.mediaType === 'tv') {
    showIdForVirtualSync = item.id
  } else if (item.mediaType === 'season') {
    const parent = repositoryService.findParent(item.id)
    if (parent?.mediaType === 'tv') showIdForVirtualSync = parent.id
  }

  itemsToUpdate.push(item, ...itemsToFullClear)
  const uniqueItems = Array.from(new Set(itemsToUpdate))

  for (const target of itemsToFullClear) {
    await _unlinkItemImages(target, { respectLocks: false })
  }

  for (const target of itemsToFullClear) {
    _resetItemMetadataFields(target, { respectLocks: false })
  }

  // Bulk-clear entity metadata in DB, then broadcast
  const entityIds = metadataRepo.fetchEntityIdsForItemIds(itemsToFullClear.map((i) => i.id))
  metadataRepo.bulkClearEntityMetadata(entityIds)

  if (showIdForVirtualSync) {
    syncVirtualSeasonFolders(showIdForVirtualSync)
  }

  const now = Date.now()
  for (const i of uniqueItems) i._v = now

  await broadcastModifiedItems(uniqueItems, { updateSuggestions: true })
  return item
}

async function _unlinkItemImages(
  item: LibraryItem,
  options: { respectLocks?: boolean } = { respectLocks: true }
) {
  if (pathsService.isRemoteLibrary()) return

  const fields: ('posterPath' | 'backdropPath' | 'logoPath')[] = [
    'posterPath',
    'backdropPath',
    'logoPath'
  ]
  for (const field of fields) {
    const val = item[field]
    if (val && (!options.respectLocks || !repositoryService.isFieldLocked(item, field))) {
      try {
        const p = pathsService.resolveAssetPath(val)
        if (p) await fs.unlink(p)
      } catch { }
    }
  }
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
        case 'runtime':
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

export async function setImage(
  itemId: string,
  imageType: 'poster' | 'backdrop' | 'logo',
  source:
    | { type: 'tmdb'; path: string }
    | { type: 'local'; path: string }
    | { type: 'local'; buffer: Buffer; originalName: string }
): Promise<LibraryItem | null> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return null

  const sourcePath = 'path' in source ? source.path : undefined
  const originalName = 'originalName' in source ? source.originalName : undefined
  const extension = path.extname(sourcePath || originalName || '') || '.jpg'

  let fileName = ''
  switch (imageType) {
    case 'poster':
      fileName = `${item.id}${extension}`
      break
    case 'backdrop':
      fileName = `${item.id}-backdrop${extension}`
      break
    case 'logo':
      fileName = `${item.id}-logo${extension || '.svg'}`
      break
  }

  const destPath = pathsService.resolveAssetPath(fileName)
  if (!destPath) return null

  try {
    if (source.type === 'tmdb') {
      const size = imageType === 'backdrop' ? 'original' : 'w500'
      const url = `https://image.tmdb.org/t/p/${size}${source.path}`
      await downloadImage(url, destPath)
    } else if ('buffer' in source) {
      await fs.writeFile(destPath, source.buffer)
    } else {
      await fs.copyFile(source.path, destPath)
    }

    const field = `${imageType}Path` as 'posterPath' | 'backdropPath' | 'logoPath'
      ; (item as any)[field] = fileName
    item._v = Date.now()
    await updateIfChangedAndBroadcast(item)
    return item
  } catch (err) {
    log(`Failed to set image: ${err}`)
    return null
  }
}

export async function removeImage(
  itemId: string,
  imageType: 'poster' | 'backdrop' | 'logo'
): Promise<LibraryItem | null> {
  const item = repositoryService.getItemById(itemId)
  if (item) {
    ; (item as any)[`${imageType}Path`] = null
    item._v = Date.now()
    await updateIfChangedAndBroadcast(item)
  }
  return item
}

export const fetchCredits = async (itemId: string) => {
  const item = repositoryService.getItemById(itemId)
  if (item && item.tmdbId && item.mediaType) {
    const settings = await settingsService.readSettings()
    const credits = await retrieverService.getCredits(
      item.tmdbId,
      item.mediaType as any,
      settings.tmdbApiKey!
    )
    if (credits) {
      metadataMapping.applyCreditsToItem(item, credits)
      await updateIfChangedAndBroadcast(item)
    }
  }
}

export async function clearVirtualFolderMetadata(_itemIds: string[]): Promise<boolean> {
  return true
}
