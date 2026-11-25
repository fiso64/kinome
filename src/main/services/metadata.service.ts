import path from 'path'
import fs from 'fs/promises'

import * as repositoryService from './repository.service'
import * as virtualTagsService from './virtualTags.service'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import { createTmdbProvider, type MetadataProvider, type ProviderDetails, type ProviderMatch } from './metadata-provider'
import * as tvShowService from './tv-show.service'
import * as metadataMapping from './metadata-processing.service'
import { processInChunks } from '../utils/concurrency'
import { downloadImage } from '../utils/download'
import { comparableTitle, isExtraVideoName, parseTitle, type TitleQuery } from '@shared/title-parser'
import { parseEpisodeName } from '../utils/tv-parser'
import { isSupportedVideoFile } from '@shared/local-media'
import { updateIfChangedAndBroadcast, broadcastModifiedItems } from './item-update.service'
import * as metadataRepo from '../database/repositories/metadata.repo'
import { syncAllGroupings, syncVirtualSeasonFolders } from './grouping.service'
import { getTransport } from '../transport.registry'
import { runWithoutAccount } from '../request-context'
import * as filesystemService from './filesystem.service'
import * as autocompleteService from './autocomplete.service'

import type { LibraryItem, MediaFile, MediaFolder } from '@shared/types'
import { RESETTABLE_METADATA_KEYS } from '@shared/types'
import { ENTITY_SCALAR_METADATA_FIELDS } from '@shared/metadata-fields'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Metadata Service] ${message}`)
}

/**
 * Phase 2: Metadata Enrichment (DB -> API)
 */
export async function enrichDatabase(syncGroupings = false) {
  return runEnrichment({
    includeStructuralPrepass: true,
    runMaintenance: true,
    syncGroupings
  })
}

export async function enrichItems(
  itemIds: Iterable<string>,
  options: { runMaintenance?: boolean; deferFileChangeRefresh?: boolean; structuralPrepass?: boolean } = {}
) {
  const scopedItemIds = [...new Set(itemIds)]
  if (scopedItemIds.length === 0) return

  return runEnrichment({
    itemIds: scopedItemIds,
    includeStructuralPrepass: options.structuralPrepass ?? false,
    runMaintenance: options.runMaintenance ?? false,
    deferFileChangeRefresh: options.deferFileChangeRefresh
  })
}

async function runEnrichment(options: {
  itemIds?: string[]
  includeStructuralPrepass: boolean
  runMaintenance: boolean
  deferFileChangeRefresh?: boolean
  syncGroupings?: boolean
}) {
  return runWithoutAccount(async () => {
    const settings = await settingsService.readSettings()
    if (!settings.tmdbApiKey) {
      log('Enrichment skipped: No TMDB API key.')
      if (options.runMaintenance && options.syncGroupings) await maintenancePass(true)
      return
    }

    getTransport().notifyScanStatusChanged({ isMetadataFetchingLibrary: true })

    try {
      // 1. Preprocess TV Structural Changes
      const tvShowsWithChanges = new Map<string, LibraryItem>()
      const tvShowsToSync = options.includeStructuralPrepass
        ? repositoryService.getTvShowsForStructuralSync(options.itemIds)
        : []

      if (tvShowsToSync.length > 0) {
        log(`[Phase 2] Preprocessing structure for ${tvShowsToSync.length} TV shows.`)
        for (const show of tvShowsToSync) {
          const modified = await tvShowService.syncTvShowStructure(show as MediaFolder)
          if (modified.length > 0) {
            log(
              `[Phase 2] [Structure] TV Show "${show.name}" has ${modified.length} structural changes.`
            )
            if (show.tmdbId) {
              tvShowsWithChanges.set(show.id, show)
            }
          }
        }
      }

      // 2. Discovery: Find "Logical Entry Points"
      const entryById = new Map(
        repositoryService.getDiscoveryItemsForPhase2(options.itemIds).map((entry) => [entry.item.id, entry])
      )
      for (const [id, item] of tvShowsWithChanges) {
        if (!entryById.has(id)) entryById.set(id, { item, needsTmdbBackfill: false })
      }
      const entryPoints = [...entryById.values()].filter(
        (entry) => !options.deferFileChangeRefresh || !entry.fileChangeRevision
      )

      if (entryPoints.length === 0) {
        log('[Phase 2] No dirty entry points found. Enrichment skipped.')
      } else {
        log(
          `[Phase 2] Discovery complete. Found ${entryPoints.length} logical entry points for enrichment.`
        )

        // 3. The Orchestration Loop
        const provider = createTmdbProvider(settings.tmdbApiKey)
        await processInChunks(entryPoints, 5, async ({ item, fileChangeRevision, needsTmdbBackfill, airDatePassed }) => {
          const force = tvShowsWithChanges.has(item.id)
          // Provider facts alone: titles, artwork, episodes and structure stay as they are.
          const backfillOnly = (needsTmdbBackfill || !!airDatePassed) && !force && !fileChangeRevision
          const reason = fileChangeRevision ? 'file changed'
            : force ? 'structure changed'
            : !backfillOnly ? 'missing metadata'
            : needsTmdbBackfill ? 'supplemental metadata backfill' : 'next air date passed'
          log(`[Phase 2] [${item.mediaType || item.type}] Enriching "${item.name}" (${reason})`)
          await fetchAndApplyMetadata(item, {
            force, provider, fileChangeRevision, backfillOnly, deferGroupingSync: options.runMaintenance
          })
        })
      }

      // 4. Maintenance Pass
      if (options.runMaintenance) {
        await maintenancePass(entryPoints.length > 0 || options.syncGroupings)
      }
    } finally {
      getTransport().notifyScanStatusChanged({ isMetadataFetchingLibrary: false })
    }

    await repositoryService.writeDb()
    log('[Phase 2] Enrichment complete.')
  }) // runWithoutAccount
}

export async function maintenancePass(syncGroupings = false) {
  log('[Maintenance] Starting pass...')
  const libraryDataPath = pathsService.getLibraryDataPath()
  const imagesDir = path.join(libraryDataPath, 'images')

  await filesystemService.verifyImagePaths(imagesDir)
  await publishLibraryMetadata(syncGroupings)
  log('[Maintenance] Pass complete.')
}

export async function publishLibraryMetadata(syncGroupings: boolean) {
  return runWithoutAccount(async () => {
    const settings = await settingsService.readSettings()
    log('[Maintenance] Syncing virtual tags via SQL...')
    virtualTagsService.applyVirtualTags(settings.virtualTags)
    if (syncGroupings) syncAllGroupings()

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
  })
}

function isGenericMediaTitle(title: string): boolean {
  return !title || /^(?:(?:some )?release|movie|video|feature|main|downloads?|folder|untitled|[1-9]\d{2,3}[pi])(?: \d{1,4})?$/.test(comparableTitle(title))
}

function titleFromFeatureFiles(folderId: string): (TitleQuery & { alternate?: TitleQuery }) | undefined {
  let feature: ReturnType<typeof parseTitle> | undefined
  let titleKey: string | undefined
  const children = repositoryService.getChildren(folderId, ['name', 'type', 'isMissing'])
  for (const file of children) {
    if (file.type !== 'file' || file.isMissing || !isSupportedVideoFile(file.name) || isExtraVideoName(file.name)) continue
    const episode = parseEpisodeName(file.name)
    if (episode?.kind === 'episode' || episode?.kind === 'range' || episode?.kind === 'date') return
    const candidate = parseTitle(file.name, 'file')
    if (isGenericMediaTitle(candidate.title)) return
    const key = comparableTitle(candidate.title)
    if (feature && (key !== titleKey || (feature.year && candidate.year && feature.year !== candidate.year))) return
    if (!feature || (candidate.year && !feature.year)) feature = candidate
    titleKey = key
  }
  return feature
}

export async function fetchAndApplyMetadata(
  item: LibraryItem,
  options: {
    force?: boolean
    year?: number
    provider?: MetadataProvider
    fileChangeRevision?: string
    backfillOnly?: boolean
    deferGroupingSync?: boolean
  } = {}
): Promise<LibraryItem[]> {
  const typeLocked = repositoryService.isFieldLocked(item, 'mediaType')
  if (typeLocked && item.mediaType == null) return []

  const settings = await settingsService.readSettings()
  const libraryDataPath = pathsService.getLibraryDataPath()
  const provider = options.provider ?? createTmdbProvider(settings.tmdbApiKey!)
  const allModifiedItems: LibraryItem[] = [item]

  if (pathsService.isRemoteLibrary()) return []
  // Another item of the same title may have fetched the facts already in this pass.
  if (options.backfillOnly && metadataRepo.hasSupplementalTmdbMetadata(item.id) &&
    !metadataRepo.hasPassedAirDate(item.id)) return []

  const fileChangeRefresh = options.fileChangeRevision
    ? { completed: new Map<string, string>(), failed: false, onlyChangedSeasons: !options.force }
    : undefined

  log(`[Orchestrator] fetchAndApplyMetadata for "${item.name}"`)

  const wasBulkUpdating = repositoryService.getBulkUpdateStatus()
  repositoryService.setBulkUpdateStatus(true)

  try {
    let identifiedDetails: ProviderDetails | undefined
    // 1. Identification
    if (!item.tmdbId && !item.lastRefreshedAt) {
      const configuredType = item.parentId
        ? (repositoryService.getItemById(item.parentId) as MediaFolder | null)?.folderSettings?.childrenTypeHint
        : undefined
      const storedType = item.mediaType === 'movie' || item.mediaType === 'tv' ? item.mediaType : undefined
      const folderType = configuredType === 'movie' || configuredType === 'tv' ? configuredType : undefined
      const knownType = typeLocked ? storedType : folderType ?? storedType
      const typeHint = knownType ?? (item.type === 'file' ? 'movie' : 'multi')
      const parsed = parseTitle(item.name, item.type)
      const explicitId = parsed.conflictingIds ? undefined : parsed.ids.tmdb
      // A provider ID is scoped to a media type. Preserve movie discovery
      // for loose features and avoid guessing an ID namespace for loose episodes.
      const episode = explicitId && !knownType && item.type === 'file' ? parseEpisodeName(item.name) : null
      const hasEpisodeCoordinates = episode?.kind === 'episode' || episode?.kind === 'range' || episode?.kind === 'date'
      const direct = explicitId && typeHint !== 'multi' && !hasEpisodeCoordinates
        ? { id: Number(explicitId), type: typeHint } : undefined
      let result: ProviderMatch | null
      let rule
      if (direct) {
        identifiedDetails = await provider.details(direct) ?? undefined
        result = identifiedDetails ? direct : null
        rule = 'explicit provider ID'
      } else {
        const useFeature = item.type === 'folder' && typeHint !== 'tv' && isGenericMediaTitle(parsed.title)
        const query = useFeature ? titleFromFeatureFiles(item.id) : parsed
        const queryType = useFeature ? 'movie' : typeHint
        const year = options.year ?? query?.year
        const alternate = year === undefined ? query?.alternate : undefined
        rule = useFeature ? 'feature filename' : 'item name'
        result = query?.title ? await provider.match(query.title, queryType, year, alternate) : null
      }
      if (process.env.KINOME_LOG_LEVEL === 'debug') {
        log(`[Identification] "${item.id}" via ${rule} -> ${result ? `${result.type} ${result.id}` : 'unresolved'}`)
      }

      if (result) {
        item.tmdbId = result.id
        if (!typeLocked) {
          item.mediaType = result.type
        }
      } else {
        item.tmdbId = null
        item.lastRefreshedAt = Date.now()
        await updateIfChangedAndBroadcast(item)
        return allModifiedItems
      }
    }

    // 2. Save provider facts independently of item locks and materialize the item.
    if (item.tmdbId && (item.mediaType === 'movie' || item.mediaType === 'tv')) {
      const match = { id: item.tmdbId, type: item.mediaType }
      const details = identifiedDetails ?? await provider.details(match, { includeArtwork: !options.backfillOnly })
      if (options.backfillOnly) {
        if (details?.metadata) {
          metadataRepo.saveProviderMatch(item.id, provider.name, match, details, { supplementalOnly: true })
        }
        return []
      }
      const { entityId, metadataChanged } = metadataRepo.saveProviderMatch(item.id, provider.name, match, details)
      if (!details) {
        if (item.type === 'folder' && item.mediaType === 'tv' && item.folderSettings?.processTvChildren !== false) {
          await tvShowService.syncTvShowStructure(item)
        }
        // Keep the matched identity and pending freshness state for the next pass.
        if (!item.lastRefreshedAt) await updateIfChangedAndBroadcast(item)
        return []
      }
      await metadataMapping.applyMetadataToItem(item, details)
      if (metadataChanged) item.tmdbMetadata = details.metadata
      const credits = await provider.credits(match)
      if (credits) {
        metadataRepo.saveProviderCredits(entityId, credits)
        item.tmdbCredits = credits
      }
      for (const id of metadataRepo.findOtherItemsForEntity(entityId, item.id)) {
        const copy = repositoryService.getItemById(id)
        if (!copy || copy.mediaType !== match.type || copy.tmdbId !== match.id) continue
        metadataMapping.applyProviderFields(copy, details)
        if (metadataChanged) copy.tmdbMetadata = details.metadata
        allModifiedItems.push(copy)
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
      (item.mediaType === 'tv' && (item.folderSettings?.processTvChildren !== false || fileChangeRefresh)) ||
      item.mediaType === 'season' ||
      options.force
    ) {
      const target =
        item.mediaType === 'season'
          ? (repositoryService.findParent(item.id) as MediaFolder)
          : (item as MediaFolder)
      if (target && target.tmdbId) {
        await ensureSeasonCounts(target, provider)
        const modified = await metadataMapping.applyTvShowData(target, settings, libraryDataPath, {
          respectLocks: true,
          force: options.force,
          provider,
          fileChangeRefresh
        })
        allModifiedItems.push(...modified)
      }
    }

    // 5. Finalize
    item.lastRefreshedAt = Date.now()
    const modifiedItems = [...new Map(allModifiedItems.map((changed) => [changed.id, changed])).values()]
    await updateIfChangedAndBroadcast(modifiedItems, { settings, deferGroupingSync: options.deferGroupingSync })
    if (fileChangeRefresh) {
      if (!fileChangeRefresh.failed) {
        fileChangeRefresh.completed.set(item.id, options.fileChangeRevision!)
      }
      metadataRepo.completeFileChangeRefresh(fileChangeRefresh.completed)
    }

    return allModifiedItems
  } catch (error) {
    log(`[Orchestrator] Error: ${error}`)
    return []
  } finally {
    repositoryService.setBulkUpdateStatus(wasBulkUpdating)
  }
}

/**
 * A show's TMDB season sizes are kept on the loaded item only, never stored.
 * Structure sync needs them to accept episode numbers that are not written as
 * SxxEyy, so a sync started outside a show refresh loads them first.
 */
export async function ensureSeasonCounts(show: MediaFolder, provider?: MetadataProvider): Promise<void> {
  if (show.tmdbSeasons || !show.tmdbId || pathsService.isRemoteLibrary()) return
  try {
    const source = provider ?? createTmdbProvider((await settingsService.readSettings()).tmdbApiKey!)
    const details = await source.details({ id: show.tmdbId, type: 'tv' })
    if (details?.seasons) show.tmdbSeasons = details.seasons
  } catch (error) {
    log(`[Structure Sync] Could not load season sizes for "${show.name}": ${error}`)
  }
}

/**
 * Gives an item the identity the user chose and locks it. See the overwrite
 * rules in spec/backend/metadata_locking.md.
 */
export async function assignManualIdentity(
  itemId: string,
  result: Record<string, any>,
  mediaType: ManualMatchType
): Promise<LibraryItem | null> {
  const current = repositoryService.getItemById(itemId)
  if (!current) return null
  // An episode is identified by its place in its show. The show itself is the folder above it.
  const numbers = mediaType === 'episode' ? ['seasonNumber', 'episodeNumber'] as const
    : mediaType === 'season' ? ['seasonNumber'] as const : []
  const chosen: Record<string, number> = {}
  for (const field of numbers) {
    const value = result[field === 'seasonNumber' ? 'season_number' : 'episode_number']
    if (typeof value === 'number') chosen[field] = value
  }
  if (mediaType === 'episode' && (current.type !== 'file' || Object.keys(chosen).length < 2)) return null
  const tmdbId = mediaType === 'episode' ? null : result.id
  // Edits describe an identity. They survive only when the same match is applied again.
  const sameIdentity = (current.tmdbId ?? null) === tmdbId && current.mediaType === mediaType &&
    Object.entries(chosen).every(([field, value]) => (current as Record<string, any>)[field] === value)

  const item = await clearItemMetadata(itemId, { targetedClear: true, preserveEdits: sameIdentity })
  if (!item) return null

  Object.assign(item, chosen)
  item.tmdbId = tmdbId
  item.mediaType = mediaType
  item.lastRefreshedAt = null
  const identity = [...(mediaType === 'episode' ? [] : ['tmdbId']), 'mediaType', ...Object.keys(chosen)]
  item.lockedFields = [...new Set([...(item.lockedFields ?? []).filter((field) => tmdbId !== null || field !== 'tmdbId'), ...identity])]

  if (mediaType === 'movie' || mediaType === 'tv') {
    metadataRepo.saveProviderMatch(item.id, 'tmdb', { id: result.id, type: mediaType })
  }
  await updateIfChangedAndBroadcast(item)
  return item
}

export type ManualMatchType = 'movie' | 'tv' | 'season' | 'episode'

/** The matched show a file belongs to: the nearest TV folder above it. */
export function findShowFor(itemId: string): MediaFolder | null {
  for (let parent = repositoryService.findParent(itemId); parent; parent = repositoryService.findParent(parent.id)) {
    if (parent.mediaType === 'tv') return parent.tmdbId ? parent : null
  }
  return null
}

/** Gives one manually matched episode the details of its place in the show. */
async function enrichMatchedEpisode(episode: MediaFile): Promise<void> {
  const show = findShowFor(episode.id)
  if (!show || episode.seasonNumber == null) return
  const settings = await settingsService.readSettings()
  await ensureSeasonCounts(show)
  const modified = await metadataMapping.fetchAndApplyEpisodeData(
    { ...show, seasonNumber: episode.seasonNumber, lastRefreshedAt: null },
    show.tmdbId!, settings.tmdbApiKey!, pathsService.getLibraryDataPath(), show.tmdbSeasons ?? undefined,
    { respectLocks: true, force: true, localEpisodes: [episode] }
  )
  await updateIfChangedAndBroadcast(modified.filter((item) => item.id !== show.id))
  // A loose episode is listed under its show's generated season folders.
  if (episode.parentId === show.id) syncVirtualSeasonFolders(show.id)
}

export async function applyManualMatch(
  itemId: string,
  result: Record<string, any>,
  mediaType: ManualMatchType
): Promise<LibraryItem[]> {
  const wasBulkUpdating = repositoryService.getBulkUpdateStatus()
  repositoryService.setBulkUpdateStatus(true)

  try {
    const item = await assignManualIdentity(itemId, result, mediaType)
    if (!item) {
      repositoryService.setBulkUpdateStatus(wasBulkUpdating)
      return []
    }
    log(`[Manual Match] Primed "${item.name}" for ${mediaType} match.`)

    // 2. TRIGGER BACKGROUND ENRICHMENT
    const runBackgroundEnrichment = async () => {
      repositoryService.setBulkUpdateStatus(true)
      try {
        if (mediaType === 'season' && item.parentId) {
          const parent = repositoryService.getItemById(item.parentId) as MediaFolder
          if (parent && parent.mediaType === 'tv') {
            await ensureSeasonCounts(parent)
            await tvShowService.syncTvShowStructure(parent, 'smart', 'smart', {
              scopedToId: item.id
            })
          }
        }
        if (mediaType === 'episode') await enrichMatchedEpisode(item as MediaFile)
        else await fetchAndApplyMetadata(item, { force: true })
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
  options: { childrenOnly?: boolean; targetedClear?: boolean; preserveEdits?: boolean } = {}
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
      // A rematch resets the seasons and episodes that follow from it. A child
      // whose identity the user set keeps it until that child is cleared.
      const follows = (child: LibraryItem) => !repositoryService.hasIdentityLock(child)
      const children = repositoryService.getChildren(item.id)
      if (item.mediaType === 'tv') {
        for (const child of children) {
          if (child.mediaType === 'season' || child.mediaType === 'episode') {
            if (follows(child)) itemsToFullClear.push(child)
            if (child.type === 'folder') {
              const episodes = repositoryService.getChildren(child.id)
              itemsToFullClear.push(...episodes.filter((e) => e.mediaType === 'episode' && follows(e)))
            }
          }
        }
      } else if (item.mediaType === 'season') {
        itemsToFullClear.push(...children.filter((c) => c.mediaType === 'episode' && follows(c)))
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

  const respectLocks = options.preserveEdits === true
  for (const target of itemsToFullClear) {
    await _unlinkItemImages(target, { respectLocks })
    _resetItemMetadataFields(target, { respectLocks })
  }

  repositoryService.runTransaction(() => {
    metadataRepo.bulkClearItemMetadata(itemsToFullClear.map(({ id }) => id))
    if (respectLocks) {
      for (const target of itemsToFullClear) {
        if (target.lockedFields?.length) metadataRepo.upsertMetadata(target.id, target)
      }
    }
  })

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
  const scalarResetValues = new Map(ENTITY_SCALAR_METADATA_FIELDS.map((field) => [field.key, field.resetValue]))

  for (const key of RESETTABLE_METADATA_KEYS) {
    if (key === 'tags' || (options.respectLocks && key === 'lockedFields')) continue
    if (Object.prototype.hasOwnProperty.call(item, key)) {
      if (options.respectLocks && repositoryService.isFieldLocked(item, key)) {
        continue
      }
      const itemAsRecord = item as Record<string, any>
      if (scalarResetValues.has(key)) {
        itemAsRecord[key] = scalarResetValues.get(key)
        continue
      }

      switch (key) {
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

        case 'tmdbSeasons':
        case 'tmdbEpisodes':
        case 'tmdbCredits':
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
    item[field] = fileName
    item.lockedFields = [...new Set([...(item.lockedFields ?? []), field])]
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
    const field = `${imageType}Path` as const
    item[field] = null
    item.lockedFields = [...new Set([...(item.lockedFields ?? []), field])]
    item._v = Date.now()
    await updateIfChangedAndBroadcast(item)
  }
  return item
}

export const fetchCredits = async (itemId: string) => {
  const item = repositoryService.getItemById(itemId)
  if (!item?.tmdbId || (item.mediaType !== 'movie' && item.mediaType !== 'tv')) return
  const settings = await settingsService.readSettings()
  const provider = createTmdbProvider(settings.tmdbApiKey!)
  const match = { id: item.tmdbId, type: item.mediaType }
  const credits = await provider.credits(match)
  if (credits) {
    const { entityId } = metadataRepo.saveProviderMatch(item.id, provider.name, match)
    metadataRepo.saveProviderCredits(entityId, credits)
    await updateIfChangedAndBroadcast({ id: item.id, tmdbCredits: credits, _v: Date.now() } as LibraryItem)
  }
}

export async function clearVirtualFolderMetadata(_itemIds: string[]): Promise<boolean> {
  return true
}
