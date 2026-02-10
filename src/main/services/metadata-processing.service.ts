import path from 'path'
import fs from 'fs/promises'

import { downloadImage } from '../utils/download'
import * as repositoryService from './repository.service'
import * as pathsService from './paths.service'
import * as retrieverService from './retriever.service'
import { updateIfChangedAndBroadcast } from './item-update.service'

import type {
  LibraryItem,
  MediaFile,
  MediaFolder,
  Person,
  Settings,
  TmdbEpisode,
  TmdbSeason
} from '@shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Metadata Processing] ${message}`)
}

/**
 * High-level "Apply" logic.
 * Takes raw TMDB data and "paints" it onto a LibraryItem, respecting locks.
 */
export async function applyMetadataToItem(
  item: LibraryItem,
  data: any,
  options: { respectLocks?: boolean; libraryDataPath: string }
): Promise<void> {
  const { respectLocks, libraryDataPath } = options

  // 1. Basic Fields
  const title = data.title || data.name
  if (title && (!respectLocks || !repositoryService.isFieldLocked(item, 'title'))) {
    item.title = title
  }

  if (data.overview && (!respectLocks || !repositoryService.isFieldLocked(item, 'overview'))) {
    item.overview = data.overview
  }

  const date = data.release_date || data.first_air_date
  if (date && (!respectLocks || !repositoryService.isFieldLocked(item, 'year'))) {
    item.year = new Date(date).getFullYear()
  }

  if (
    data.genres &&
    Array.isArray(data.genres) &&
    (!respectLocks || !repositoryService.isFieldLocked(item, 'genres'))
  ) {
    item.genres = data.genres.map((g: { name: string }) => g.name)
  }

  // 2. Images
  await downloadAndApplyImage(
    item,
    'poster',
    data.poster_path,
    'https://image.tmdb.org/t/p/w500',
    `${item.id}.jpg`
  )
  await downloadAndApplyImage(
    item,
    'backdrop',
    data.backdrop_path,
    'https://image.tmdb.org/t/p/original',
    `${item.id}-backdrop.jpg`
  )

  // 3. TV Specific
  if (item.mediaType === 'tv' && data.seasons) {
    ;(item as MediaFolder).tmdbSeasons = data.seasons
  }

  // 4. Logo (If available in images sub-object)
  if (data.images?.logos) {
    const logos = data.images.logos
    const bestLogo =
      logos.find((l: any) => l.iso_639_1 === 'en') ||
      logos.find((l: any) => l.iso_639_1 === null) ||
      logos[0]
    if (bestLogo) {
      const extension = path.extname(bestLogo.file_path)
      await downloadAndApplyImage(
        item,
        'logo',
        bestLogo.file_path,
        'https://image.tmdb.org/t/p/w500',
        `${item.id}-logo${extension}`
      )
    }
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

/**
 * Processes a raw TMDB credits object and attaches a structured `tmdbCredits` object to the item.
 */
export function applyCreditsToItem(item: LibraryItem, creditsData: any) {
  const isTv = item.mediaType === 'tv'
  const isAggregated = isTv && creditsData.cast?.[0]?.roles

  if (!isAggregated) {
    item.tmdbCredits = {
      cast: (creditsData.cast ?? []).map((p: any) => ({
        id: p.id,
        name: p.name,
        profile_path: p.profile_path,
        character: p.character,
        order: p.order
      })),
      crew: (creditsData.crew ?? []).map((p: any) => ({
        id: p.id,
        name: p.name,
        profile_path: p.profile_path,
        job: p.job
      }))
    }
    return
  }

  // --- Aggregate TV Credits logic ---
  const IMPORTANT_JOBS = ['Creator', 'Director', 'Screenplay', 'Writer']
  const people = new Map<
    number,
    {
      personData: any
      actingScore: number
      crewScore: number
      characters: string[]
      jobs: string[]
    }
  >()

  const ensurePerson = (personId: number, initialData: any) => {
    if (!people.has(personId)) {
      people.set(personId, {
        personData: initialData,
        actingScore: Infinity,
        crewScore: Infinity,
        characters: [],
        jobs: []
      })
    }
    return people.get(personId)!
  }

  ;(creditsData.cast ?? []).forEach((castMember: any) => {
    const p = ensurePerson(castMember.id, castMember)
    p.actingScore = Math.min(p.actingScore, castMember.order)
    p.characters.push(...(castMember.roles ?? []).map((r: any) => r.character))
    p.personData = { ...p.personData, ...castMember }
  })
  ;(creditsData.crew ?? []).forEach((crewMember: any) => {
    let bestJobIndex = Infinity
    const importantJobsForPerson: string[] = []

    ;(crewMember.jobs ?? []).forEach((jobInfo: any) => {
      const index = IMPORTANT_JOBS.indexOf(jobInfo.job)
      if (index !== -1) {
        bestJobIndex = Math.min(bestJobIndex, index)
        importantJobsForPerson.push(jobInfo.job)
      }
    })

    if (bestJobIndex !== Infinity) {
      const p = ensurePerson(crewMember.id, crewMember)
      p.crewScore = Math.min(p.crewScore, bestJobIndex)
      p.jobs.push(...importantJobsForPerson)
      p.personData = { ...p.personData, ...crewMember }
    }
  })

  const finalCast: Person[] = []
  const finalCrew: Person[] = []

  people.forEach((p) => {
    const isPrimarilyActor = p.actingScore <= 15 || p.actingScore < p.crewScore
    if (isPrimarilyActor) {
      finalCast.push({
        id: p.personData.id,
        name: p.personData.name,
        profile_path: p.personData.profile_path,
        character: [...new Set(p.characters)].join(' / '),
        order: p.actingScore
      })
    } else {
      finalCrew.push({
        id: p.personData.id,
        name: p.personData.name,
        profile_path: p.personData.profile_path,
        job: [...new Set(p.jobs)].join(' / '),
        order: p.crewScore
      })
    }
  })

  finalCast.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
  finalCrew.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
  item.tmdbCredits = { cast: finalCast, crew: finalCrew }
}

/**
 * Propagates TV show metadata down to its hierarchy (Seasons and Episodes).
 */
export async function applyTvShowData(
  show: MediaFolder,
  settings: Settings,
  libraryDataPath: string,
  options: { respectLocks?: boolean; force?: boolean } = { respectLocks: true }
): Promise<LibraryItem[]> {
  const allModifiedItems: LibraryItem[] = []
  if (!show.tmdbId || !show.tmdbSeasons) return []

  const children = repositoryService.getChildren(show.id)

  // 1. Process Season Folders
  const seasonFolders = children.filter(
    (c) => c.type === 'folder' && c.mediaType === 'season' && typeof c.seasonNumber === 'number'
  ) as MediaFolder[]

  for (const seasonFolder of seasonFolders) {
    let seasonChanged = false
    const tmdbSeason = show.tmdbSeasons.find((s) => s.season_number === seasonFolder.seasonNumber)

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

    const modifiedInSeason = await fetchAndApplyEpisodeData(
      seasonFolder,
      show.tmdbId,
      settings.tmdbApiKey!,
      libraryDataPath,
      show.tmdbSeasons,
      options
    )
    allModifiedItems.push(...modifiedInSeason)
    if (seasonChanged) allModifiedItems.push(seasonFolder)
  }

  // 2. Process Loose Episodes (Scenario B)
  const looseEpisodes = children.filter(
    (c) => c.type === 'file' && typeof (c as MediaFile).seasonNumber === 'number'
  ) as MediaFile[]

  if (looseEpisodes.length > 0) {
    const seasonsToFetch = new Set(looseEpisodes.map((f) => f.seasonNumber as number))
    for (const seasonNum of seasonsToFetch) {
      const episodesInThisSeason = looseEpisodes.filter((f) => f.seasonNumber === seasonNum)

      // For loose files, we create a temporary "proxy" folder to satisfy fetchAndApplyEpisodeData
      const proxySeasonFolder: MediaFolder = {
        ...show,
        seasonNumber: seasonNum,
        children: episodesInThisSeason,
        lastRefreshedAt: null // Force it to fetch
      }

      const modifiedInSeason = await fetchAndApplyEpisodeData(
        proxySeasonFolder,
        show.tmdbId,
        settings.tmdbApiKey!,
        libraryDataPath,
        show.tmdbSeasons,
        options
      )
      // Filter out the proxy itself (same ID as show)
      allModifiedItems.push(...modifiedInSeason.filter((m) => m.id !== show.id))
    }
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
  options: { respectLocks?: boolean; force?: boolean } = { respectLocks: true }
): Promise<LibraryItem[]> {
  const seasonNumber = seasonFolder.seasonNumber
  if (seasonNumber === null || typeof seasonNumber === 'undefined') return []

  // Guard: Does this season even exist in TMDB?
  if (tmdbSeasons && !tmdbSeasons.some((s) => s.season_number === seasonNumber)) {
    return []
  }

  const modifiedItems: LibraryItem[] = []
  let tmdbEpisodes: TmdbEpisode[] | null = seasonFolder.tmdbEpisodes || null

  // Fetch if not cached or forced
  if (!tmdbEpisodes || options.force) {
    const details = await retrieverService.getSeasonDetails(showTmdbId, seasonNumber, tmdbApiKey)
    if (details) {
      tmdbEpisodes = (details.episodes ?? []).map((e: any) => ({
        episode_number: e.episode_number,
        name: e.name,
        overview: e.overview,
        still_path: e.still_path
      }))

      seasonFolder.tmdbEpisodes = tmdbEpisodes
      seasonFolder.lastRefreshedAt = Date.now()
      modifiedItems.push(seasonFolder)
    }
  }

  if (!tmdbEpisodes) return modifiedItems

  const children = seasonFolder.children || repositoryService.getChildren(seasonFolder.id)
  const localEpisodes = children.filter((c) => c.type === 'file') as MediaFile[]

  for (const localEpisode of localEpisodes) {
    if (typeof localEpisode.episodeNumber === 'undefined') continue
    const tmdbEpisode = tmdbEpisodes.find((e) => e.episode_number === localEpisode.episodeNumber)

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
    modifiedItems.push(localEpisode)
  }

  return modifiedItems
}
