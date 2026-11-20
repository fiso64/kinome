import path from 'path'
import fs from 'fs/promises'

import { downloadImage } from '../utils/download'
import * as repositoryService from './repository.service'
import * as pathsService from './paths.service'
import { getFileChangeRevisions } from '../database/repositories/metadata.repo'
import { createTmdbProvider, type MetadataProvider, type ProviderDetails } from './metadata-provider'
import { updateIfChangedAndBroadcast } from './item-update.service'

import type {
  LibraryItem,
  MediaFile,
  MediaFolder,
  Settings,
  TmdbEpisode,
  TmdbSeason
} from '@shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Metadata Processing] ${message}`)
}

export function applyProviderFields(item: LibraryItem, details: ProviderDetails): void {
  const { title, originalTitle, overview, releaseDate, year, runtime, genres } = details
  const fields = { title, originalTitle, overview, releaseDate, year, tmdbRuntime: runtime, genres }
  for (const [field, value] of Object.entries(fields)) {
    if (!repositoryService.isFieldLocked(item, field)) Object.assign(item, { [field]: value })
  }
}

export async function applyMetadataToItem(item: LibraryItem, details: ProviderDetails): Promise<void> {
  applyProviderFields(item, details)
  if (item.type === 'folder' && item.mediaType === 'tv') item.tmdbSeasons = details.seasons ?? []

  for (const kind of ['poster', 'backdrop', 'logo'] as const) {
    const url = details.artwork[kind]
    if (!url) continue
    const extension = kind === 'logo' ? path.extname(new URL(url).pathname) : '.jpg'
    const suffix = kind === 'poster' ? '' : `-${kind}`
    await downloadAndApplyImage(item, kind, url, '', `${item.id}${suffix}${extension}`)
  }
}

/**
 * Downloads and applies an image to an item, respecting locks.
 */
export async function downloadAndApplyImage(
  item: LibraryItem,
  imageType: 'poster' | 'backdrop' | 'logo',
  tmdbPath: string | null | undefined,
  imageUrlPrefix: string,
  fileName: string,
  options: { force?: boolean; respectLocks?: boolean } = { respectLocks: true }
): Promise<void> {
  const itemAsAny = item as any
  const key: 'posterPath' | 'backdropPath' | 'logoPath' = `${imageType}Path`

  if (options.respectLocks && repositoryService.isFieldLocked(item, key)) {
    return
  }

  // Idempotency: skip if already has a value and not forced
  if (itemAsAny[key] && !options.force) {
    return
  }

  if (tmdbPath) {
    const imageUrl = `${imageUrlPrefix}${tmdbPath}`
    const destPath = pathsService.isRemoteLibrary() ? null : pathsService.resolveAssetPath(fileName)
    if (destPath) {
      try {
        await downloadImage(imageUrl, destPath)
        itemAsAny[key] = fileName
        log(`Downloaded ${imageType} for "${item.title ?? item.name}"`)
      } catch (err) {
        // Failed downloads are logged in downloadImage utility
      }
    }
  } else {
    // If TMDB has no image, we mark it as null so we don't keep trying
    itemAsAny[key] = null
  }
}

interface EpisodeFetchOptions {
  respectLocks?: boolean
  force?: boolean
  provider?: MetadataProvider
  getEpisodes?: (number: number) => Promise<TmdbEpisode[] | null>
  localEpisodes?: MediaFile[]
  onFetch?: (success: boolean) => void
}

interface FileChangeRefresh {
  completed: Map<string, string>
  failed: boolean
  onlyChangedSeasons: boolean
}

/**
 * Propagates TV show metadata down to its hierarchy (Seasons and Episodes).
 */
export async function applyTvShowData(
  show: MediaFolder,
  settings: Settings,
  libraryDataPath: string,
  options: EpisodeFetchOptions & { fileChangeRefresh?: FileChangeRefresh } = { respectLocks: true }
): Promise<LibraryItem[]> {
  const allModifiedItems: LibraryItem[] = []
  if (!show.tmdbId || !show.tmdbSeasons) return []

  const children = repositoryService.getChildren(show.id, [...repositoryService.CORE_FIELDS, 'overview', 'lastRefreshedAt']).filter((child) => !child.isMissing)
  const refresh = options.fileChangeRefresh
  const revisions = refresh ? getFileChangeRevisions(children.map(({ id }) => id)) : new Map<string, string>()
  const seasonsByNumber = new Map(show.tmdbSeasons.map((season) => [season.season_number, season]))
  const provider = options.provider ?? createTmdbProvider(settings.tmdbApiKey!)
  const tmdbId = show.tmdbId
  const episodeRequests = new Map<number, Promise<TmdbEpisode[] | null>>()

  const getEpisodes = (number: number) => {
    const pending = episodeRequests.get(number)
    if (pending) return pending
    const request = provider.episodes(tmdbId, number).catch((error) => {
      console.error(`[Metadata Processing] Episode fetch failed for TMDB show ${tmdbId}, season ${number}`, error)
      return null
    })
    episodeRequests.set(number, request)
    return request
  }

  const recordFetch = (ids: string[], success: boolean) => {
    if (!refresh) return
    if (!success) {
      refresh.failed = true
      return
    }
    for (const id of ids) {
      const revision = revisions.get(id)
      if (revision) refresh.completed.set(id, revision)
    }
  }

  // 1. Process Season Folders
  const seasonFolders = children.filter(
    (c) => c.type === 'folder' && c.mediaType === 'season' && typeof c.seasonNumber === 'number'
  ) as MediaFolder[]

  for (const seasonFolder of seasonFolders) {
    let seasonChanged = false
    const seasonIsStale = revisions.has(seasonFolder.id)
    if (refresh?.onlyChangedSeasons && !seasonIsStale && show.folderSettings?.processTvChildren === false) continue
    const tmdbSeason = seasonsByNumber.get(seasonFolder.seasonNumber!)

    if (tmdbSeason) {
      if (!options.respectLocks || !repositoryService.isFieldLocked(seasonFolder, 'title')) {
        if (seasonFolder.title !== tmdbSeason.name) {
          seasonFolder.title = tmdbSeason.name
          seasonChanged = true
        }
      }
      if (!options.respectLocks || !repositoryService.isFieldLocked(seasonFolder, 'overview')) {
        if (seasonFolder.overview !== tmdbSeason.overview) {
          seasonFolder.overview = tmdbSeason.overview
          seasonChanged = true
        }
      }
      if (tmdbSeason.poster_path) {
        const posterFileName = `${seasonFolder.id}.jpg`
        if (seasonFolder.posterPath !== posterFileName) {
          await downloadAndApplyImage(
            seasonFolder,
            'poster',
            tmdbSeason.poster_path,
            'https://image.tmdb.org/t/p/w500',
            posterFileName,
            options
          )
          seasonChanged = true
        }
      }
    }

    if (!seasonFolder.isVirtual && (!refresh?.onlyChangedSeasons || seasonIsStale || !seasonFolder.lastRefreshedAt)) {
      const modifiedInSeason = await fetchAndApplyEpisodeData(
        seasonFolder,
        tmdbId,
        settings.tmdbApiKey!,
        libraryDataPath,
        show.tmdbSeasons,
        {
          ...options,
          force: options.force || seasonIsStale,
          getEpisodes,
          onFetch: (success) => recordFetch([seasonFolder.id], success)
        }
      )
      allModifiedItems.push(...modifiedInSeason)
    }
    if (seasonChanged) allModifiedItems.push(seasonFolder)
  }

  // Group loose episodes once. Files belonging to a different season must
  // never be compared against this season's provider episode numbers.
  const looseBySeason = new Map<number, MediaFile[]>()
  for (const child of children) {
    if (child.type !== 'file' || child.mediaType !== 'episode' || child.seasonNumber == null) continue
    let episodes = looseBySeason.get(child.seasonNumber)
    if (!episodes) looseBySeason.set(child.seasonNumber, (episodes = []))
    episodes.push(child)
  }

  for (const [seasonNumber, episodes] of looseBySeason) {
    const ids = episodes.map(({ id }) => id)
    if (refresh?.onlyChangedSeasons && !ids.some((id) => revisions.has(id))) continue
    const proxySeason: MediaFolder = { ...show, seasonNumber, lastRefreshedAt: null }
    const modified = await fetchAndApplyEpisodeData(
      proxySeason,
      tmdbId,
      settings.tmdbApiKey!,
      libraryDataPath,
      show.tmdbSeasons,
      {
        ...options,
        localEpisodes: episodes,
        getEpisodes,
        onFetch: (success) => recordFetch(ids, success)
      }
    )
    allModifiedItems.push(...modified.filter((item) => item.id !== show.id))
  }

  return allModifiedItems
}

/**
 * Fetches (from API or cache) and applies episode metadata to a season context.
 */
export async function fetchAndApplyEpisodeData(
  seasonFolder: MediaFolder,
  showTmdbId: number,
  tmdbApiKey: string,
  libraryDataPath: string,
  tmdbSeasons: TmdbSeason[] | undefined,
  options: EpisodeFetchOptions = { respectLocks: true }
): Promise<LibraryItem[]> {
  const seasonNumber = seasonFolder.seasonNumber
  if (seasonNumber == null) return []

  // Guard: Does this season even exist in TMDB?
  if (tmdbSeasons && !tmdbSeasons.some((s) => s.season_number === seasonNumber)) {
    options.onFetch?.(true)
    return []
  }

  const modifiedItems: LibraryItem[] = []
  let tmdbEpisodes: TmdbEpisode[] | null = seasonFolder.tmdbEpisodes || null

  // Fetch if not cached or forced
  if (!tmdbEpisodes || options.force) {
    const episodes = options.getEpisodes
      ? await options.getEpisodes(seasonNumber)
      : await (options.provider ?? createTmdbProvider(tmdbApiKey)).episodes(showTmdbId, seasonNumber)
    options.onFetch?.(episodes !== null)
    if (episodes) {
      tmdbEpisodes = episodes
      const alreadyFetched = !!seasonFolder.lastRefreshedAt

      seasonFolder.tmdbEpisodes = tmdbEpisodes
      if (!alreadyFetched || options.force) {
        seasonFolder.lastRefreshedAt = Date.now()
        modifiedItems.push(seasonFolder)
      }
    }
  }

  if (!tmdbEpisodes) return modifiedItems

  // Always fetch with overview included — callers may pass children with only
  // CORE_FIELDS, which excludes overview. We need it for change detection.
  const localEpisodes = options.localEpisodes ?? repositoryService.getChildren(
    seasonFolder.id, [...repositoryService.CORE_FIELDS, 'overview']
  ).filter((item): item is MediaFile => item.type === 'file' && !item.isMissing)
  const episodesByNumber = new Map(tmdbEpisodes.map((episode) => [episode.episode_number, episode]))

  for (const localEpisode of localEpisodes) {
    if (
      options.respectLocks &&
      localEpisode.mediaType !== 'episode' &&
      repositoryService.isFieldLocked(localEpisode, 'mediaType')
    ) continue
    if (localEpisode.episodeNumber == null) continue
    const tmdbEpisode = episodesByNumber.get(localEpisode.episodeNumber)

    // Snapshot fields before mutation to detect real changes
    const before = {
      title: localEpisode.title,
      overview: localEpisode.overview,
      mediaType: localEpisode.mediaType,
      posterPath: localEpisode.posterPath
    }

    if (tmdbEpisode) {
      if (!options.respectLocks || !repositoryService.isFieldLocked(localEpisode, 'title')) {
        localEpisode.title = tmdbEpisode.name
      }
      if (!options.respectLocks || !repositoryService.isFieldLocked(localEpisode, 'overview')) {
        localEpisode.overview = tmdbEpisode.overview
      }
      localEpisode.mediaType = 'episode'
      if (tmdbEpisode.still_path) {
        await downloadAndApplyImage(
          localEpisode,
          'poster',
          tmdbEpisode.still_path,
          'https://image.tmdb.org/t/p/w500',
          `${localEpisode.id}.jpg`
        )
      }
    } else {
      // Clear metadata if no match found (unless locked)
      if (!options.respectLocks || !repositoryService.isFieldLocked(localEpisode, 'title'))
        localEpisode.title = undefined
      if (!options.respectLocks || !repositoryService.isFieldLocked(localEpisode, 'overview'))
        localEpisode.overview = undefined
      if (!options.respectLocks || !repositoryService.isFieldLocked(localEpisode, 'posterPath'))
        localEpisode.posterPath = undefined
    }

    // Normalize null/undefined for comparison — DB returns null, clearing sets undefined
    const eq = (a: any, b: any) => (a ?? null) === (b ?? null)
    const changed =
      !eq(localEpisode.title, before.title) ||
      !eq(localEpisode.overview, before.overview) ||
      !eq(localEpisode.mediaType, before.mediaType) ||
      !eq(localEpisode.posterPath, before.posterPath)

    if (changed) {
      modifiedItems.push(localEpisode)
    }
  }

  return modifiedItems
}
