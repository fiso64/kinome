import path from 'path'
import type {
  LibraryItem,
  MediaFile,
  MediaFolder,
  Person,
  Settings,
  TmdbEpisode,
  TmdbSeason
} from '../../shared/types'
import { downloadImage } from '../utils/download'
import { parseTitle } from '../utils/title-parser'
import * as repositoryService from './repository.service'

const genreCache = new Map<number, string>()

export async function cacheGenreLists(tmdbApiKey: string): Promise<void> {
  // Don't re-fetch if the cache is already populated.
  if (genreCache.size > 0) {
    return
  }
  console.log('[TMDB] Caching genre lists...')

  const endpoints = ['movie', 'tv']
  try {
    const promises = endpoints.map((type) => {
      const url = `https://api.themoviedb.org/3/genre/${type}/list?api_key=${tmdbApiKey}`
      console.log(`[TMDB] Fetching from: ${url}`)
      return fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to fetch ${type} genres.`)
          return res.json()
        })
        .then((data) => {
          for (const genre of data.genres) {
            genreCache.set(genre.id, genre.name)
          }
        })
    })
    await Promise.all(promises)
    console.log(`[TMDB] Successfully cached ${genreCache.size} unique genres.`)
  } catch (error) {
    console.error('[TMDB] Failed to cache genre lists:', error)
  }
}

const SPECIAL_SUBFOLDER_NAMES = [
  'extras',
  'featurettes',
  'specials',
  'behind the scenes',
  'deleted scenes',
  'interviews'
]

function getImagesPath(libraryDataPath: string): string {
  return path.join(libraryDataPath, 'images')
}

/**
 * Fetches season episode data directly from the TMDB API.
 * This is a lightweight utility for flat TV shows where there's no Season folder item.
 * @param showTmdbId The TMDB ID of the parent TV show.
 * @param seasonNumber The season number to fetch (usually 1 for flat shows).
 * @param tmdbApiKey The TMDB API key.
 * @returns The season data including episodes array, or null if fetch fails.
 */
export async function fetchSeasonEpisodes(
  showTmdbId: number,
  seasonNumber: number,
  tmdbApiKey: string
): Promise<{ episodes: Array<{ episode_number: number; name: string; overview: string; still_path?: string }> } | null> {
  try {
    const url = `https://api.themoviedb.org/3/tv/${showTmdbId}/season/${seasonNumber}?api_key=${tmdbApiKey}`
    console.log(`[TMDB] Fetching season ${seasonNumber} episodes for show ${showTmdbId}`)
    const response = await fetch(url)
    if (!response.ok) {
      console.error(`[TMDB] Season fetch failed: ${response.statusText}`)
      return null
    }
    const data = await response.json()
    return {
      episodes: (data.episodes || []).map((e: any) => ({
        episode_number: e.episode_number,
        name: e.name,
        overview: e.overview,
        still_path: e.still_path
      }))
    }
  } catch (error) {
    console.error(`[TMDB] Error fetching season ${seasonNumber}:`, error)
    return null
  }
}

export async function searchTmdbAndApplyMetadata(
  item: LibraryItem,
  tmdbApiKey: string,
  libraryDataPath: string,
  typeHint?: 'movie' | 'tv'
): Promise<void> {
  let endpoint: 'movie' | 'tv' | 'multi'

  // If a parent folder provides a hint, it takes precedence.
  if (typeHint) {
    endpoint = typeHint
  } else {
    // Otherwise, apply heuristics to determine the best search endpoint
    endpoint = 'multi' // Default
    if (item.type === 'file') {
      endpoint = 'movie'
    } else if (item.type === 'folder') {
      const children = item.children || []
      const videoFiles = children.filter((c) => c.type === 'file')
      const significantSubfolders = children.filter(
        (c) => c.type === 'folder' && !SPECIAL_SUBFOLDER_NAMES.includes(c.name.toLowerCase())
      )

      if (videoFiles.length === 1 && significantSubfolders.length === 0) {
        endpoint = 'movie'
      } else if (videoFiles.length === 0 && significantSubfolders.length > 0) {
        // Heuristic: Folder with only other folders is likely a TV show container
        endpoint = 'tv'
      }
      // If it's a mix, we stick with 'multi'
    }
  }

  const query = parseTitle(item.name)
  if (!query) return

  const searchUrl = `https://api.themoviedb.org/3/search/${endpoint}?api_key=${tmdbApiKey}&query=${encodeURIComponent(query)}`
  console.log(`[TMDB] Fetching from: ${searchUrl}`)

  try {
    const searchResponse = await fetch(searchUrl)
    if (!searchResponse.ok) {
      console.error(`TMDB search failed for "${query}": ${searchResponse.statusText}`)
      return
    }

    const searchResults = await searchResponse.json()
    const firstResultTitle =
      searchResults.results?.[0]?.title ?? searchResults.results?.[0]?.name ?? 'None'
    console.log(
      `[TMDB] Query: "${query}" | Endpoint: ${endpoint} | Top Result: "${firstResultTitle}"`
    )

    // For 'multi' search, filter out people results.
    const result = (
      endpoint === 'multi'
        ? searchResults.results?.filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
        : searchResults.results
    )?.[0]

    if (result) {
      // Step 1: Populate item with data from the search result.
      item.tmdbId = result.id
      item.mediaType = result.media_type ?? endpoint // Fallback to our guessed endpoint type

      // TODO: Check if/how/when data gets truncated for TMDB search results vs detail results.
      // For now, we are trusting the search result data to be sufficient for library browsing.
      if (!repositoryService.isFieldLocked(item, 'title')) {
        item.title = result.title || result.name // 'title' for movie, 'name' for tv
      }
      if (!repositoryService.isFieldLocked(item, 'overview')) {
        item.overview = result.overview
      }
      if (item.type === 'file') {
        item.opensAsFolder = true
      }
      const date = result.release_date || result.first_air_date
      if (date && !repositoryService.isFieldLocked(item, 'year')) {
        item.year = new Date(date).getFullYear()
      }
      if (
        result.genre_ids &&
        Array.isArray(result.genre_ids) &&
        genreCache.size > 0 &&
        !repositoryService.isFieldLocked(item, 'genres')
      ) {
        item.genres = result.genre_ids
          .map((id: number) => genreCache.get(id))
          .filter((name): name is string => !!name)
      }

      // Download the poster from the search result.
      if (result.poster_path) {
        const posterUrl = `https://image.tmdb.org/t/p/w500${result.poster_path}`
        const imagesDir = getImagesPath(libraryDataPath)
        const posterFileName = `${item.id}.jpg`
        const posterDestPath = path.join(imagesDir, posterFileName)
        try {
          await downloadImage(posterUrl, posterDestPath)
          item.posterPath = posterFileName
        } catch {
          console.error(`Failed to download or save poster for item: ${item.name}`)
        }
      }

      // Make a dedicated request for credits.
      // This is done during the scan so that cast & crew are immediately
      // available in the search index for filtering.
      if (item.mediaType === 'movie' || item.mediaType === 'tv') {
        await fetchAndApplyCredits(item, tmdbApiKey)
      }
    } else {
      console.log(`No TMDB result found for "${query}" with endpoint "${endpoint}"`)
      item.tmdbId = null // Explicitly mark as not found to prevent re-scanning
    }
  } catch (error) {
    console.error(`Error fetching metadata for "${item.name}":`, error)
  }
}

export async function refetchPoster(
  item: LibraryItem,
  tmdbApiKey: string,
  libraryDataPath: string
): Promise<void> {
  if (!item.tmdbId || !item.mediaType) {
    console.log(`Skipping poster refetch for "${item.name}", no tmdbId or mediaType.`)
    return
  }

  const detailUrl = `https://api.themoviedb.org/3/${item.mediaType}/${item.tmdbId}?api_key=${tmdbApiKey}`
  console.log(`[TMDB] Fetching from: ${detailUrl}`)

  try {
    const response = await fetch(detailUrl)
    if (!response.ok) {
      throw new Error(`TMDB detail fetch failed for poster: ${response.statusText}`)
    }
    const details = await response.json()

    if (details.poster_path) {
      const posterUrl = `https://image.tmdb.org/t/p/w500${details.poster_path}`
      const imagesDir = getImagesPath(libraryDataPath)
      const posterFileName = `${item.id}.jpg`
      const posterDestPath = path.join(imagesDir, posterFileName)
      try {
        await downloadImage(posterUrl, posterDestPath)
        item.posterPath = posterFileName
        console.log(`[TMDB] Downloaded poster for "${item.title ?? item.name}"`)
      } catch {
        // Error is logged inside downloadImage
      }
    }
  } catch (error) {
    console.error(`Error refetching poster for "${item.name}":`, error)
  }
}

/**
 * Processes a raw TMDB credits object and attaches a structured `tmdbCredits` object to the item.
 * It handles both the simple format for movies and the complex "aggregate_credits" format for TV shows.
 * @param item The library item to which credits will be applied.
 * @param creditsData The raw credits object from the TMDB API.
 */
function applyCreditsToItem(item: LibraryItem, creditsData: any) {
  const isTv = item.mediaType === 'tv'
  // aggregate_credits (from the dedicated endpoint) has a `roles` array on cast members.
  // The simple `credits` (from append_to_response) does not. This is our differentiator.
  const isAggregated = isTv && creditsData.cast?.[0]?.roles

  if (!isAggregated) {
    // Simple case for movies or non-aggregated TV credits from `append_to_response`.
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

  // --- Start of complex TV aggregate credits logic ---
  // This logic is specifically for the data from the /tv/{id}/aggregate_credits endpoint.

  // Step 1: Unify roles and determine importance scores.
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

  // Helper to initialize or retrieve a person from the map.
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

    // Process cast members to get their best acting score.
    ; (creditsData.cast ?? []).forEach((castMember: any) => {
      const p = ensurePerson(castMember.id, castMember)
      p.actingScore = Math.min(p.actingScore, castMember.order)
      p.characters.push(...(castMember.roles ?? []).map((r: any) => r.character))
      p.personData = { ...p.personData, ...castMember } // Merge to get best data (e.g., profile_path)
    })

    // Process crew members to get their best crew score.
    ; (creditsData.crew ?? []).forEach((crewMember: any) => {
      let bestJobIndex = Infinity
      const importantJobsForPerson: string[] = []

        ; (crewMember.jobs ?? []).forEach((jobInfo: any) => {
          const index = IMPORTANT_JOBS.indexOf(jobInfo.job)
          if (index !== -1) {
            bestJobIndex = Math.min(bestJobIndex, index)
            importantJobsForPerson.push(jobInfo.job)
          }
        })

      // Only add crew if they have an important job.
      if (bestJobIndex !== Infinity) {
        const p = ensurePerson(crewMember.id, crewMember)
        p.crewScore = Math.min(p.crewScore, bestJobIndex)
        p.jobs.push(...importantJobsForPerson)
        p.personData = { ...p.personData, ...crewMember }
      }
    })

  // Step 2: Determine primary role ("The Cranston Rule") and categorize.
  const finalCast: Person[] = []
  const finalCrew: Person[] = []

  people.forEach((p) => {
    const isPrimarilyActor = p.actingScore <= 15 || p.actingScore < p.crewScore

    if (isPrimarilyActor) {
      finalCast.push({
        id: p.personData.id,
        name: p.personData.name,
        profile_path: p.personData.profile_path,
        // Synthesize a character string from all their acting roles.
        character: [...new Set(p.characters)].join(' / '),
        // Use the best acting score for sorting.
        order: p.actingScore
      })
    } else {
      finalCrew.push({
        id: p.personData.id,
        name: p.personData.name,
        profile_path: p.personData.profile_path,
        // Synthesize a job string from all their important crew roles.
        job: [...new Set(p.jobs)].join(' / '),
        // Use the best crew score for sorting.
        order: p.crewScore
      })
    }
  })

  // Step 3: Sort the final lists for display.
  finalCast.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
  finalCrew.sort((a, b) => {
    // Primary sort: by job importance (lower is better)
    const aOrder = a.order ?? Infinity
    const bOrder = b.order ?? Infinity
    if (aOrder !== bOrder) {
      return aOrder - bOrder
    }
    // Secondary sort: people with images first
    const aHasImage = !!a.profile_path
    const bHasImage = !!b.profile_path
    if (aHasImage !== bHasImage) {
      return aHasImage ? -1 : 1
    }
    return 0
  })

  item.tmdbCredits = { cast: finalCast, crew: finalCrew }
}

export async function fetchAndApplyCredits(item: LibraryItem, tmdbApiKey: string): Promise<void> {
  if (!item.tmdbId || !item.mediaType || (item.mediaType !== 'movie' && item.mediaType !== 'tv')) {
    console.log(`Skipping credits fetch for "${item.name}", not a movie or tv show.`)
    return
  }

  const isTv = item.mediaType === 'tv'
  const endpoint = isTv ? 'aggregate_credits' : 'credits'
  const creditsUrl = `https://api.themoviedb.org/3/${item.mediaType}/${item.tmdbId}/${endpoint}?api_key=${tmdbApiKey}`
  console.log(`[TMDB] Fetching credits for "${item.title ?? item.name}" from ${creditsUrl}`)

  try {
    const response = await fetch(creditsUrl)
    if (!response.ok) {
      throw new Error(`TMDB credits fetch failed: ${response.statusText}`)
    }
    const credits = await response.json()
    applyCreditsToItem(item, credits)
  } catch (error) {
    console.error(`Error fetching credits for "${item.name}":`, error)
    // Don't mark as fetched on error, so it can be retried.
    return
  }

}


async function _downloadAndApplyImageIfNeeded(
  item: LibraryItem,
  imageType: 'poster' | 'backdrop' | 'logo',
  tmdbPath: string | null | undefined,
  imageUrlPrefix: string,
  fileName: string,
  imagesDir: string
): Promise<void> {
  const itemAsAny = item as any
  const key: 'posterPath' | 'backdropPath' | 'logoPath' = `${imageType}Path`

  // Do not overwrite if a path is already set (or explicitly cleared by the user).
  if (typeof itemAsAny[key] !== 'undefined') {
    return
  }

  if (tmdbPath) {
    const imageUrl = `${imageUrlPrefix}${tmdbPath}`
    const destPath = path.join(imagesDir, fileName)
    try {
      await downloadImage(imageUrl, destPath)
      itemAsAny[key] = fileName
      console.log(`[TMDB] Downloaded ${imageType} for "${item.title ?? item.name}"`)
    } catch {
      itemAsAny[key] = null // Mark as failed to prevent retries
    }
  } else {
    itemAsAny[key] = null // No image provided by API
  }
}

export async function fetchItemDetails(
  item: LibraryItem,
  settings: Pick<Settings, 'tmdbApiKey' | 'useLogos'>,
  libraryDataPath: string,
  options: { respectLocks?: boolean } = { respectLocks: true }
): Promise<LibraryItem[]> {
  // Efficiency Rule: Do not re-fetch if already completed


  if (!item.tmdbId || !item.mediaType) {
    console.log(`Skipping details fetch for "${item.name}", no tmdbId or mediaType.`)
    return [item]
  }
  const modifiedItems: LibraryItem[] = [item]

  const imagesDir = getImagesPath(libraryDataPath)
  const detailUrl = `https://api.themoviedb.org/3/${item.mediaType}/${item.tmdbId}?api_key=${settings.tmdbApiKey}&append_to_response=images`

  console.log(`[TMDB] Fetching details for "${item.title ?? item.name}" from ${detailUrl}`)

  try {
    const response = await fetch(detailUrl)
    if (!response.ok) {
      throw new Error(`TMDB detail fetch failed: ${response.statusText}`)
    }
    const details = await response.json()

    // --- Images ---
    await _downloadAndApplyImageIfNeeded(
      item,
      'poster',
      details.poster_path,
      'https://image.tmdb.org/t/p/w500',
      `${item.id}.jpg`,
      imagesDir
    )

    await _downloadAndApplyImageIfNeeded(
      item,
      'backdrop',
      details.backdrop_path,
      'https://image.tmdb.org/t/p/original',
      `${item.id}-backdrop.jpg`,
      imagesDir
    )

    if (settings.useLogos) {
      const logos = details.images?.logos
      const bestLogo =
        logos?.find((l) => l.iso_639_1 === 'en') ||
        logos?.find((l) => l.iso_639_1 === null) ||
        logos?.[0]
      if (bestLogo) {
        const extension = path.extname(bestLogo.file_path)
        await _downloadAndApplyImageIfNeeded(
          item,
          'logo',
          bestLogo.file_path,
          'https://image.tmdb.org/t/p/w500',
          `${item.id}-logo${extension}`,
          imagesDir
        )
      } else if (typeof item.logoPath === 'undefined') {
        item.logoPath = null // No logo found
      }
    } else if (typeof item.logoPath === 'undefined') {
      // If setting is disabled, mark as checked to prevent future fetching.
      item.logoPath = null
    }

    // Update other metadata fields (Conditional on Locks)
    if (details.title || details.name) {
      if (!options.respectLocks || !repositoryService.isFieldLocked(item, 'title')) {
        item.title = details.title || details.name
      }
    }
    if (details.overview && (!options.respectLocks || !repositoryService.isFieldLocked(item, 'overview'))) {
      item.overview = details.overview
    }
    const date = details.release_date || details.first_air_date
    if (date && (!options.respectLocks || !repositoryService.isFieldLocked(item, 'year'))) {
      item.year = new Date(date).getFullYear()
    }
    if (
      details.genres &&
      Array.isArray(details.genres) &&
      (!options.respectLocks || !repositoryService.isFieldLocked(item, 'genres'))
    ) {
      item.genres = details.genres.map((g: { name: string }) => g.name)
    }



    // --- TV Show Specific Logic ---
    if (
      item.type === 'folder' &&
      item.mediaType === 'tv' &&
      (item as MediaFolder).process_tv_children !== false &&
      details.seasons
    ) {
      item.tmdbSeasons = details.seasons // Cache the full season data
      const modifiedChildren = await applyTvShowData(item as MediaFolder, settings, libraryDataPath)
      modifiedItems.push(...modifiedChildren)
    } else if (item.type === 'folder' && item.mediaType === 'season' && details.episodes) {
      // Manual Season level update: episodes are likely present in the response
      const modifiedChildren = await fetchAndApplyEpisodeData(
        item as MediaFolder,
        (item as any).showTmdbId || details.id, // Fallback if showId is missing on item?
        settings.tmdbApiKey!,
        libraryDataPath,
        undefined, // tmdbSeasons not available at this level, will be fetched by function
        { ...options, seasonDetails: details }
      )
      modifiedItems.push(...modifiedChildren)
    }
  } catch (error) {
    console.error(`Error fetching full details for "${item.name}":`, error)
  }
  return modifiedItems
}

/**
 * Processes the children of a TV show folder (seasons, episodes) using
 * the pre-cached `tmdbSeasons` data on the item.
 * This function does NOT fetch the show's own details, only its children's.
 */
export async function applyTvShowData(
  item: MediaFolder,
  settings: Pick<Settings, 'tmdbApiKey' | 'useLogos'>,
  libraryDataPath: string,
  options: { respectLocks?: boolean } = { respectLocks: true }
): Promise<LibraryItem[]> {
  const imagesDir = getImagesPath(libraryDataPath)
  const allModifiedItems: LibraryItem[] = []

  try {
    if (
      item.type === 'folder' &&
      item.mediaType === 'tv' &&
      item.process_tv_children !== false &&
      item.tmdbSeasons
    ) {
      console.log(`[TMDB] Applying TV data to children of "${item.name}".`)
      const tmdbSeasons = item.tmdbSeasons
      const children = item.children || repositoryService.getChildren(item.id)
      const seasonFolders = children.filter(
        (c) => c.type === 'folder' && c.mediaType === 'season'
      ) as MediaFolder[]

      if (seasonFolders.length > 0) {
        // Scenario A: Map TMDB season data to local season folders
        for (const seasonFolder of seasonFolders) {
          let seasonChanged = false
          const tmdbSeason = tmdbSeasons.find((s) => s.season_number === seasonFolder.seasonNumber)
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
                const posterUrl = `https://image.tmdb.org/t/p/w500${tmdbSeason.poster_path}`
                const posterDestPath = path.join(imagesDir, posterFileName)
                try {
                  await downloadImage(posterUrl, posterDestPath)
                  seasonFolder.posterPath = posterFileName
                  seasonChanged = true
                } catch {
                  // Ignore download error
                }
              }
            }
          }

          // Fetch and apply episode metadata for this season folder
          const modifiedInSeason = await fetchAndApplyEpisodeData(
            seasonFolder,
            item.tmdbId!,
            settings.tmdbApiKey!,
            libraryDataPath,
            item.tmdbSeasons,
            options
          )
          allModifiedItems.push(...modifiedInSeason)

          if (seasonChanged) {
            allModifiedItems.push(seasonFolder)
          }
        }
      } else {
        // Scenario B: "File Mode". Find all seasons present in loose files and fetch data for each.
        const children = item.children || repositoryService.getChildren(item.id)
        const filesWithSeason = children.filter(
          (c) => c.type === 'file' && typeof (c as MediaFile).seasonNumber !== 'undefined'
        ) as MediaFile[]

        if (filesWithSeason.length > 0) {
          // Group files by season number to handle multiple seasons in one folder
          const seasonsToFetch = new Set(filesWithSeason.map((f) => f.seasonNumber!))

          for (const seasonNum of seasonsToFetch) {
            const fakeSeasonFolder: MediaFolder = {
              ...(item as MediaFolder),
              seasonNumber: seasonNum,
              children: filesWithSeason.filter((f) => f.seasonNumber === seasonNum)
            }

            const modifiedInSeason = await fetchAndApplyEpisodeData(
              fakeSeasonFolder,
              item.tmdbId!,
              settings.tmdbApiKey!,
              libraryDataPath,
              item.tmdbSeasons,
              options
            )
            allModifiedItems.push(...modifiedInSeason)
          }
        }
      }
    }

    if (item.type === 'folder' && item.mediaType === 'season') {
      // Scenario C: Individual Season update
      const show = repositoryService.findParent(item.id) as MediaFolder
      if (show && show.tmdbId) {
        console.log(`[TMDB] Explicit Managed Copy for Season ${item.seasonNumber} of "${show.name}"`)
        const modifiedInSeason = await fetchAndApplyEpisodeData(
          item as MediaFolder,
          show.tmdbId,
          settings.tmdbApiKey!,
          libraryDataPath,
          show.tmdbSeasons ?? undefined,
          options
        )
        allModifiedItems.push(...modifiedInSeason)
      }
    }

    return allModifiedItems
  } catch (error) {
    console.error(`Error in applyTvShowData for "${item.name}":`, error)
    return []
  }
}

export async function refetchShowSeasons(
  show: MediaFolder,
  settings: Pick<Settings, 'tmdbApiKey' | 'useLogos'>,
  libraryDataPath: string
): Promise<LibraryItem[]> {
  const tmdbApiKey = settings.tmdbApiKey
  if (!show.tmdbId || show.mediaType !== 'tv' || !tmdbApiKey) {
    return []
  }
  const detailUrl = `https://api.themoviedb.org/3/tv/${show.tmdbId}?api_key=${tmdbApiKey}`
  console.log(`[TMDB] Refetching seasons for "${show.title ?? show.name}" from ${detailUrl}`)
  const modifiedItems: LibraryItem[] = []
  try {
    const response = await fetch(detailUrl)
    if (!response.ok) {
      throw new Error(`TMDB detail fetch failed: ${response.statusText}`)
    }
    const details = await response.json()
    if (details.seasons) {
      show.tmdbSeasons = details.seasons
      modifiedItems.push(show)
      console.log(
        `[TMDB] Successfully updated seasons for "${show.title ?? show.name}". Applying data...`
      ) // After updating seasons, re-apply data to children to catch the new season.
      const modifiedChildren = await applyTvShowData(show, settings, libraryDataPath)
      modifiedItems.push(...modifiedChildren)
    }
  } catch (error) {
    console.error(`Error refetching seasons for "${show.name}":`, error)
  }
  return modifiedItems
}

/**
 * Fetches episode data for a specific season from TMDB and applies it to the
 * local file items within that season folder.
 * @param seasonFolder The local folder item representing the season.
 * @param showTmdbId The TMDB ID of the parent show.
 * @param tmdbApiKey
 * @param libraryDataPath
 */
export async function fetchAndApplyEpisodeData(
  seasonFolder: MediaFolder,
  showTmdbId: number,
  tmdbApiKey: string,
  libraryDataPath: string,
  tmdbSeasons: TmdbSeason[] | undefined,
  options: { respectLocks?: boolean; seasonDetails?: any } = { respectLocks: true }
): Promise<MediaFile[]> {
  const seasonNumber = seasonFolder.seasonNumber
  if (seasonNumber === null || typeof seasonNumber === 'undefined') {
    console.warn(
      `[TMDB] fetchAndApplyEpisodeData for "${seasonFolder.name}" failed: seasonNumber is missing.`
    )
    return []
  }

  console.log(`[TMDB] fetchAndApplyEpisodeData for "${seasonFolder.name}" (S${seasonNumber}). showTmdbId=${showTmdbId}`)
  const modifiedEpisodes: MediaFile[] = []

  // If tmdbSeasons is provided, check if the season exists in it.
  // If not provided (e.g., manual season match where parent show data isn't fully loaded),
  // we proceed assuming the season number on seasonFolder is valid for an API attempt.
  if (tmdbSeasons) {
    const seasonExistsInProvidedList = tmdbSeasons.some((s) => s.season_number === seasonNumber)
    if (!seasonExistsInProvidedList) {
      console.log(
        `[TMDB] Skipping episode fetch for S${seasonNumber} as it does not exist in the provided TMDB season list.`
      )
      return []
    }
  }
  // If tmdbSeasons is not provided (e.g., manual match where parent show processing is disabled),
  // we proceed to try fetching, relying on the seasonFolder.seasonNumber.
  if (typeof seasonFolder.seasonNumber !== 'number') {
    console.warn(
      `[TMDB] Season folder "${seasonFolder.name}" (ID: ${seasonFolder.id}) has no valid seasonNumber (${seasonFolder.seasonNumber}). Cannot fetch episodes.`
    )
    return [] // Cannot proceed without a valid season number
  }

  try {
    const episodeApiUrl = `https://api.themoviedb.org/3/tv/${showTmdbId}/season/${seasonNumber}?api_key=${tmdbApiKey}`
    console.log(
      `[TMDB] Fetching episodes for "${seasonFolder.name}" (S${seasonNumber}) from ${episodeApiUrl}`
    )

    const response = await fetch(episodeApiUrl)
    if (!response.ok) {
      throw new Error(`TMDB episode fetch failed: ${response.statusText}`)
    }
    const seasonDetails = await response.json()

    // Apply details from the season endpoint to the season folder itself,
    // only if the properties aren't already set (to respect user edits).
    if (!seasonFolder.title && (!options.respectLocks || !repositoryService.isFieldLocked(seasonFolder, 'title'))) {
      seasonFolder.title = seasonDetails.name
    }
    if (!seasonFolder.overview && (!options.respectLocks || !repositoryService.isFieldLocked(seasonFolder, 'overview'))) {
      seasonFolder.overview = seasonDetails.overview
    }
    if (!seasonFolder.posterPath && seasonDetails.poster_path) {
      const posterUrl = `https://image.tmdb.org/t/p/w500${seasonDetails.poster_path}`
      const imagesDir = getImagesPath(libraryDataPath)
      const posterFileName = `${seasonFolder.id}.jpg`
      const posterDestPath = path.join(imagesDir, posterFileName)
      try {
        await downloadImage(posterUrl, posterDestPath)
        seasonFolder.posterPath = posterFileName
      } catch {
        /* ignore download error */
      }
    }

    const tmdbEpisodesApi = seasonDetails.episodes

    if (!tmdbEpisodesApi || tmdbEpisodesApi.length === 0) {
      console.log(`[TMDB] No episode data found for season ${seasonNumber}. Caching empty array.`)
      seasonFolder.tmdbEpisodes = []
    } else {
      // --- Cache Curated Episode Data ---
      const tmdbEpisodes = tmdbEpisodesApi.map(
        (e: any): TmdbEpisode => ({
          episode_number: e.episode_number,
          name: e.name,
          overview: e.overview,
          still_path: e.still_path
        })
      )
      seasonFolder.tmdbEpisodes = tmdbEpisodes

      // --- Apply Cached Data to Local Files ---
      const children = seasonFolder.children || repositoryService.getChildren(seasonFolder.id)
      const localEpisodes = children.filter(
        (c) => c.type === 'file'
      ) as MediaFile[]
      console.log(`[TMDB] Local episodes count for season ${seasonFolder.name}: ${localEpisodes.length}`)

      for (const localEpisode of localEpisodes) {
        if (typeof localEpisode.episodeNumber === 'undefined') continue

        const tmdbEpisode = tmdbEpisodes.find(
          (e) => e.episode_number === localEpisode.episodeNumber
        )

        if (tmdbEpisode) {
          if (!options.respectLocks || !repositoryService.isFieldLocked(localEpisode, 'title')) {
            localEpisode.title = tmdbEpisode.name
          }
          if (!options.respectLocks || !repositoryService.isFieldLocked(localEpisode, 'overview')) {
            localEpisode.overview = tmdbEpisode.overview
          }
          localEpisode.mediaType = 'episode'
          // Only download if poster is missing.
          if (!localEpisode.posterPath && tmdbEpisode.still_path) {
            const posterUrl = `https://image.tmdb.org/t/p/w500${tmdbEpisode.still_path}`
            const imagesDir = getImagesPath(libraryDataPath)
            const posterFileName = `${localEpisode.id}.jpg`
            const posterDestPath = path.join(imagesDir, posterFileName)
            try {
              await downloadImage(posterUrl, posterDestPath)
              localEpisode.posterPath = posterFileName
            } catch {
              /* ignore download error */
            }
          }
        } else {
          // If no matching TMDB episode, clear any old metadata, but respect locks during regular scans.
          if (!options.respectLocks || !repositoryService.isFieldLocked(localEpisode, 'title')) {
            localEpisode.title = undefined
          }
          if (!options.respectLocks || !repositoryService.isFieldLocked(localEpisode, 'overview')) {
            localEpisode.overview = undefined
          }
          if (!options.respectLocks || !repositoryService.isFieldLocked(localEpisode, 'posterPath')) {
            localEpisode.posterPath = undefined
          }
        }
        modifiedEpisodes.push(localEpisode)
      }
    }
  } catch (error) {
    console.error(`Error fetching episode data for season ${seasonNumber}:`, error)
  }
  return modifiedEpisodes
}

export async function manualSearch(
  query: string,
  type: 'movie' | 'tv' | 'season',
  tmdbApiKey: string,
  year?: string,
  tmdbId?: string
): Promise<any[]> {
  // --- ID Search Logic ---
  if (tmdbId?.trim()) {
    console.log(`[TMDB] [ID Search] Searching for type "${type}" with ID "${tmdbId}"`)
    const searchTypeForId = type === 'season' ? 'tv' : type
    const detailUrl = `https://api.themoviedb.org/3/${searchTypeForId}/${tmdbId}?api_key=${tmdbApiKey}`

    try {
      const response = await fetch(detailUrl)
      if (!response.ok) throw new Error(await response.text())
      const details = await response.json()

      if (type === 'season') {
        if (!details.seasons || details.seasons.length === 0) {
          console.log(`[TMDB] [ID Search] Show ID "${tmdbId}" has no season information.`)
          return []
        }
        // Return seasons array formatted as search results
        return details.seasons.map((s: any) => ({
          id: s.id,
          title: s.name,
          name: s.name,
          year: s.air_date ? new Date(s.air_date).getFullYear() : null,
          poster_path: s.poster_path,
          overview: s.overview,
          season_number: s.season_number,
          episode_count: s.episode_count // Add episode count
        }))
      } else {
        // Return single movie/tv result, formatted as an array of one
        return [
          {
            id: details.id,
            title: details.title || details.name,
            year: details.release_date
              ? new Date(details.release_date).getFullYear()
              : details.first_air_date
                ? new Date(details.first_air_date).getFullYear()
                : null,
            poster_path: details.poster_path,
            overview: details.overview
          }
        ]
      }
    } catch (error) {
      console.error(`Error during ID search for "${tmdbId}":`, error)
      return []
    }
  }

  // --- Text Search Logic ---
  if (!query.trim()) return []

  if (type === 'season') {
    // 1. Search for the TV show first
    const tvSearchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${tmdbApiKey}&query=${encodeURIComponent(
      query
    )}`
    console.log(`[TMDB] [Season Search] Step 1: Fetching TV show from: ${tvSearchUrl}`)
    try {
      const tvSearchResponse = await fetch(tvSearchUrl)
      if (!tvSearchResponse.ok) throw new Error(await tvSearchResponse.text())
      const tvSearchResults = await tvSearchResponse.json()
      const show = tvSearchResults.results?.[0]

      if (!show) {
        console.log(`[TMDB] [Season Search] No TV show found for query "${query}"`)
        return []
      }

      // 2. Fetch details for that specific show to get its seasons array
      const showDetailsUrl = `https://api.themoviedb.org/3/tv/${show.id}?api_key=${tmdbApiKey}`
      console.log(`[TMDB] [Season Search] Step 2: Fetching show details from: ${showDetailsUrl}`)
      const showDetailsResponse = await fetch(showDetailsUrl)
      if (!showDetailsResponse.ok) throw new Error(await showDetailsResponse.text())
      const showDetails = await showDetailsResponse.json()

      if (!showDetails.seasons || showDetails.seasons.length === 0) {
        console.log(`[TMDB] [Season Search] Show "${show.name}" has no season information.`)
        return []
      }

      // 3. Return a list of seasons, formatted like other search results
      return showDetails.seasons.map((s) => ({
        id: s.id, // The season's unique ID
        title: s.name, // For consistency in the search result object
        name: s.name,
        year: s.air_date ? new Date(s.air_date).getFullYear() : null,
        poster_path: s.poster_path,
        overview: s.overview,
        season_number: s.season_number,
        episode_count: s.episode_count // Add episode count
      }))
    } catch (error) {
      console.error(`Error during season search for "${query}":`, error)
      return []
    }
  }

  // --- Movie/TV Search Logic (existing) ---
  const searchType = type as 'movie' | 'tv'
  const yearParam = year ? `&year=${year.trim()}` : ''
  const searchUrl = `https://api.themoviedb.org/3/search/${searchType}?api_key=${tmdbApiKey}&query=${encodeURIComponent(
    query
  )}${yearParam}`
  console.log(`[TMDB] Fetching from: ${searchUrl}`)

  try {
    const searchResponse = await fetch(searchUrl)
    if (!searchResponse.ok) {
      console.error(`TMDB manual search failed for "${query}": ${searchResponse.statusText}`)
      return []
    }
    const searchResults = await searchResponse.json()
    // Return a curated list of results
    return searchResults.results.map((r) => ({
      id: r.id,
      title: r.title || r.name,
      year: r.release_date
        ? new Date(r.release_date).getFullYear()
        : r.first_air_date
          ? new Date(r.first_air_date).getFullYear()
          : null,
      poster_path: r.poster_path,
      overview: r.overview
    }))
  } catch (error) {
    console.error(`Error during manual search for "${query}":`, error)
    return []
  }
}

export async function getTmdbImages(
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  tmdbApiKey: string,
  language: string
): Promise<{ posters: any[]; backdrops: any[]; logos: any[] }> {
  if (!tmdbId) return { posters: [], backdrops: [], logos: [] }
  const langParam =
    language && language !== 'none'
      ? `&language=${language}&include_image_language=${language},null,en` // Also include English as a fallback
      : ''
  const imagesUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/images?api_key=${tmdbApiKey}${langParam}`
  console.log(`[TMDB] Fetching from: ${imagesUrl}`)

  try {
    const response = await fetch(imagesUrl)
    if (!response.ok) {
      console.error(`TMDB image fetch failed for "${tmdbId}": ${response.statusText}`)
      return { posters: [], backdrops: [], logos: [] }
    }
    const images = await response.json()
    // Helper to remove duplicates by file_path, as the TMDB API can sometimes
    // return the same image for different language fallbacks.
    const deduplicateByFilePath = (arr: any[]): any[] => {
      if (!Array.isArray(arr)) {
        return []
      }
      return Array.from(new Map(arr.map((item) => [item.file_path, item])).values())
    }

    return {
      posters: deduplicateByFilePath(images.posters),
      backdrops: deduplicateByFilePath(images.backdrops),
      logos: deduplicateByFilePath(images.logos)
    }
  } catch (error) {
    console.error(`Error fetching images for "${tmdbId}":`, error)
    return { posters: [], backdrops: [], logos: [] }
  }
}
