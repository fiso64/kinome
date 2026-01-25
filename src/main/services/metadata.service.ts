import path from 'path'
import fs from 'fs/promises'

import * as repositoryService from './repository.service'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import * as retrieverService from './retriever.service'
import * as searchService from './search.service'
import * as tvShowService from './tv-show.service'
import * as virtualTagsService from './virtualTags.service'

import type { LibraryItem, MediaFile, MediaFolder } from '../../shared/types'
import { RESETTABLE_METADATA_KEYS } from '../../shared/types'
import { getTransport } from '../transport.registry'
import { processInChunks } from '../utils/concurrency'
import { downloadImage } from '../utils/download'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Metadata Service] ${message}`)
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

function buildMemoryTree(items: LibraryItem[]): MediaFolder | null {
  const itemMap = new Map<string, LibraryItem>()
  let root: MediaFolder | null = null

  // 1. Initialize map and children arrays for folders
  for (const item of items) {
    if (item.type === 'folder') {
      (item as MediaFolder).children = []
    }
    itemMap.set(item.id, item)
  }

  // 2. Link children to parents
  for (const item of items) {
    if (!item.parentId) {
      if (item.type === 'folder') root = item as MediaFolder
    } else {
      const parent = itemMap.get(item.parentId)
      if (parent && parent.type === 'folder') {
        (parent as MediaFolder).children!.push(item)
      }
    }
  }

  return root
}

export async function fetchMetadataForLibrary() {
  // Reconstruct the full tree in memory to allow recursive traversal for metadata checking.
  // Using getAllItemsAsList is more efficient than recursively querying children.
  const allItems = repositoryService.getAllItemsAsList()
  if (allItems.length === 0) return

  const dbRoot = buildMemoryTree(allItems)
  if (!dbRoot) return

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
    dbRoot,
    newItemsToFetch,
    itemsMissingPosters,
    itemsMissingCredits,
    allTvShows
  )
  if (allTvShows.length > 0) {
    log(`[Metadata] Performing local analysis for ${allTvShows.length} TV shows.`)
    for (const show of allTvShows) {
      tvShowService.processTvShowStructure(show)
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
  const finalizeBatch = (updatedItems: LibraryItem[]): void => {
    if (updatedItems.length > 0) {
      // Persist to DB
      repositoryService.runTransaction(() => {
        for (const item of updatedItems) {
          repositoryService.updateItem(item.id, item)
        }
      })

      for (const item of updatedItems) {
        item.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(item, settings)
      }
      // Note: searchService.updateIndexForItems is handled by DB triggers on repositoryService.updateItem
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
        tvShowService.processTvShowStructure(item as MediaFolder)
      
      // Mark as processed by setting version
      if (item.posterPath || item.tmdbId === null || item.tmdbId) {
        item._v = Date.now()
        updatedItemsBatch.push(item)
      }
    }
    await processInChunks(newItemsToFetch, 17, task)
    finalizeBatch(updatedItemsBatch)
  }
  if (itemsMissingPosters.length > 0) {
    log(`[Metadata] Starting poster refetch for ${itemsMissingPosters.length} items...`)
    const updatedItemsBatch: LibraryItem[] = []
    const task = async (item: LibraryItem): Promise<void> => {
      await retrieverService.refetchPoster(item, settings.tmdbApiKey, libraryDataPath)
      if (item.posterPath) updatedItemsBatch.push(item)
    }
    await processInChunks(itemsMissingPosters, 17, task)
    finalizeBatch(updatedItemsBatch)
  }
  if (itemsMissingCredits.length > 0) {
    log(`[Metadata] Starting credits fetch for ${itemsMissingCredits.length} items...`)
    const updatedItemsBatch: LibraryItem[] = []
    const task = async (item: LibraryItem): Promise<void> => {
      await retrieverService.fetchAndApplyCredits(item, settings.tmdbApiKey)
      if (item.tmdbCreditsFetched) updatedItemsBatch.push(item)
    }
    await processInChunks(itemsMissingCredits, 17, task)
    finalizeBatch(updatedItemsBatch)
  }
  await repositoryService.writeDb()
  log('[Metadata] Finished all fetching and saved final DB.')
  // TODO: Update and broadcast autocomplete suggestions
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
  tvShowService.processTvShowStructure(show)

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
    // Persist changes to DB so they are available immediately
    if (itemsToUpdate.length > 0) {
      repositoryService.runTransaction(() => {
        for (const item of itemsToUpdate) {
          repositoryService.updateItem(item.id, item)
        }
      })
    }
    repositoryService.setBulkUpdateStatus(wasBulkUpdating)
  }
  return itemsToUpdate
}

async function _resetItemMetadata(item: LibraryItem, imagesDir: string) {
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
    // We check hasOwnProperty because we only want to reset properties that actually exist.
    // A property set to `undefined` will not be present.
    if (Object.prototype.hasOwnProperty.call(item, key)) {
      const itemAsAny = item as any
      switch (key) {
        // --- Reset to empty objects/arrays ---
        case 'tags':
          itemAsAny[key] = {}
          break
        case 'genres':
          itemAsAny[key] = []
          break

        // --- Reset to false ---
        case 'tmdbDetailsFetched':
        case 'tmdbEpisodesFetched':
        case 'tmdbCreditsFetched':
          itemAsAny[key] = false
          break

        // --- Reset to undefined (property will be removed) ---
        case 'title':
        case 'mediaType':
        case 'opensAsFolder':
        case 'seasonNumber':
        case 'episodeNumber':
        case 'virtualTags':
        case 'posterPath':
        case 'backdropPath':
        case 'logoPath':
        case 'continueWatchingDismissed':
        case 'nextUpDismissed':
        case '_lastSeenLocalMaxSeason':
        case '_lastSeenLocalMaxEpisode':
          itemAsAny[key] = undefined
          break

        // --- Reset to null (property exists but has no value) ---
        case 'overview':
        case 'tmdbId':
        case 'year':
        case 'tmdbSeasons':
        case 'tmdbEpisodes':
        case 'tmdbCredits':
          itemAsAny[key] = null
          break
      }
    }
  }
  item._v = Date.now()
}

async function _clearChildrenRecursively(
  folder: MediaFolder,
  imagesDir: string,
  modifiedItems: LibraryItem[]
): Promise<void> {
  for (const child of folder.children) {
    await _resetItemMetadata(child, imagesDir)
    modifiedItems.push(child)
    if (child.type === 'folder') await _clearChildrenRecursively(child, imagesDir, modifiedItems)
  }
}

async function _finalizeMetadataClear(modifiedItems: LibraryItem[]): Promise<LibraryItem[]> {
  repositoryService.setBulkUpdateStatus(false)
  // Virtual tags are reapplied via _finalizeItemUpdate -> applyVirtualTags logic in library.service
  log(`Finished metadata clear for ${modifiedItems.length} items.`)
  return modifiedItems
}

export async function clearItemMetadata(
  itemId: string,
  childrenOnly: boolean
): Promise<LibraryItem[]> {
  const item = repositoryService.getItemById(itemId)
  if (!item) return []
  log(`Starting metadata clear for item "${item.name}"... Children only: ${childrenOnly}`)
  repositoryService.setBulkUpdateStatus(true)
  try {
    const imagesDir = path.join(pathsService.getLibraryDataPath(), 'images')
    const modifiedItems: LibraryItem[] = []

    if (!childrenOnly) {
      await _resetItemMetadata(item, imagesDir)
      modifiedItems.push(item)
    }

    if (item.type === 'folder') {
      await _clearChildrenRecursively(item, imagesDir, modifiedItems)
    }

    return await _finalizeMetadataClear(modifiedItems)
  } catch (error) {
    console.error('Failed during metadata clearing process:', error)
    repositoryService.setBulkUpdateStatus(false)
    return []
  }
}

export async function clearVirtualFolderMetadata(itemIds: string[]): Promise<LibraryItem[]> {
  log(`Starting metadata clear for ${itemIds.length} items from virtual folder...`)
  repositoryService.setBulkUpdateStatus(true)
  try {
    const imagesDir = path.join(pathsService.getLibraryDataPath(), 'images')
    const modifiedItems: LibraryItem[] = []
    for (const itemId of itemIds) {
      const item = repositoryService.getItemById(itemId)
      if (!item) continue
      await _resetItemMetadata(item, imagesDir)
      modifiedItems.push(item)
      if (item.type === 'folder') await _clearChildrenRecursively(item, imagesDir, modifiedItems)
    }
    return await _finalizeMetadataClear(modifiedItems)
  } catch (error) {
    console.error('Failed during virtual folder metadata clearing process:', error)
    repositoryService.setBulkUpdateStatus(false)
    return []
  }
}

export async function backgroundFetchAndApplyDetails(item: LibraryItem): Promise<LibraryItem[]> {
  const needsDetailsFetch = !item.tmdbDetailsFetched && item.tmdbId
  const needsEpisodeFetch =
    item.type === 'folder' &&
    (item.mediaType === 'tv' || item.mediaType === 'season') &&
    !item.tmdbEpisodesFetched
  if (!needsDetailsFetch && !needsEpisodeFetch) return []

  if (pathsService.isRemoteLibrary()) {
    log(`[Details] Skipping metadata fetch for "${item.name}" on remote read-only library.`)
    return []
  }
  repositoryService.setBulkUpdateStatus(true)
  const allModifiedItems: LibraryItem[] = []
  try {
    const settings = await settingsService.readSettings()
    if (!settings.tmdbApiKey) return []
    if (needsDetailsFetch) {
      log(`[Details] Item details missing. Starting full fetch for "${item.name}"`)
      const modified = await retrieverService.fetchItemDetails(
        item,
        settings,
        pathsService.getLibraryDataPath()
      )
      allModifiedItems.push(...modified)
    } else if (needsEpisodeFetch && item.type === 'folder') {
      const dbRoot = repositoryService.getRoot()
      if (!dbRoot) throw new Error('Cannot fetch episodes: database root not found.')
      if (item.mediaType === 'season') {
        const showFolder = repositoryService.findParent(item.id)
        if (showFolder && showFolder.tmdbId && showFolder.process_tv_children !== false) {
          if (!showFolder.tmdbDetailsFetched) {
            log(`[Details] Parent show "${showFolder.name}" details missing, fetching them first.`)
            const modifiedParent = await retrieverService.fetchItemDetails(
              showFolder,
              settings,
              pathsService.getLibraryDataPath()
            )
            allModifiedItems.push(...modifiedParent)
          }
          if (showFolder.tmdbSeasons) {
            log(`[Details] Season episodes missing. Fetching for "${item.name}"`)
            // Populate children so retriever can find the local files
            item.children = repositoryService.getChildren(item.id)

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
        log(`[Details] TV Show episode data missing. Processing children for "${item.name}"`)
        // Populate children (Seasons/Episodes) so retriever can process them
        item.children = repositoryService.getChildren(item.id)
        // Also populate grandchildren if necessary (for "File Mode" or deep structures)
        for (const child of item.children) {
          if (child.type === 'folder') {
            child.children = repositoryService.getChildren(child.id)
          }
        }

        const modifiedChildren = await retrieverService.applyTvShowData(
          item,
          settings,
          pathsService.getLibraryDataPath()
        )
        allModifiedItems.push(item, ...modifiedChildren)
      }
    }
    item._v = Date.now()
  } finally {
    repositoryService.setBulkUpdateStatus(false)
    const uniqueItems = [...new Map(allModifiedItems.map((it) => [it.id, it])).values()]
    const itemsToUpdate = uniqueItems.length > 0 ? uniqueItems : [item]
    // No need to update search index here, it's handled by _finalizeItemUpdate in library.service
    log(`[Details] Background processing complete for "${item.name}"`)
    return itemsToUpdate
  }
}

export async function applyTmdbResult(
  itemId: string,
  result: any,
  mediaType: 'movie' | 'tv' | 'season'
): Promise<LibraryItem | null> {
  if (pathsService.isRemoteLibrary()) {
    throw new Error('Applying metadata is not available for read-only remote libraries.')
  }
  repositoryService.markAsUserEdited(itemId)
  const item = repositoryService.getItemById(itemId)
  if (!item) return null
  const settings = await settingsService.readSettings()
  const libraryDataPath = pathsService.getLibraryDataPath()
  if (!settings.tmdbApiKey) return null
  repositoryService.setBulkUpdateStatus(true)
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
        const posterDestPath = path.join(
          pathsService.getLibraryDataPath(),
          'images',
          `${item.id}.jpg`
        )
        try {
          await downloadImage(posterUrl, posterDestPath)
          item.posterPath = `${item.id}.jpg`
        } catch (e) {
          console.error('Failed to download season poster', e)
        }
      }
      item.tmdbDetailsFetched = true
      item.tmdbEpisodesFetched = undefined
      const episodeFiles = item.children.filter((c) => c.type === 'file') as MediaFile[]
      if (
        typeof item.seasonNumber === 'number' &&
        !episodeFiles.some((ef) => typeof ef.episodeNumber !== 'undefined')
      ) {
        tvShowService.assignEpisodesByStrategy(episodeFiles, item.seasonNumber, 'smart')
      }
      const showFolder = repositoryService.findParent(item.id)
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
        tvShowService.processTvShowStructure(item as MediaFolder)
      }
      await retrieverService.fetchItemDetails(item, settings, libraryDataPath)
      if (mediaType === 'movie' || mediaType === 'tv')
        await retrieverService.fetchAndApplyCredits(item, settings.tmdbApiKey)
    }
  } finally {
    repositoryService.setBulkUpdateStatus(false)
  }
  item._v = Date.now()
  // Virtual tags will be computed in _finalizeItemUpdate
  return item
}

export async function setImage(
  itemId: string,
  imageType: 'poster' | 'backdrop' | 'logo',
  source: { type: 'tmdb'; path: string } | { type: 'local'; path: string }
): Promise<LibraryItem | null> {
  if (pathsService.isRemoteLibrary()) {
    throw new Error('Setting images is not available for remote libraries.')
  }
  repositoryService.markAsUserEdited(itemId)
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
