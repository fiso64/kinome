import path from 'path'
import fs from 'fs/promises'
import type { LibraryItem } from '../shared/types'

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

// Basic filename parser to get a searchable title.
// e.g., "The.Movie.(2023).1080p.mkv" -> "The Movie"
function parseTitle(name: string): string {
  // 1. Only remove known video extensions. This is the key fix to avoid stripping ". 2" from folder names.
  let cleaned = name.replace(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i, '')

  // 2. Replace dots and underscores with spaces
  cleaned = cleaned.replace(/[._]/g, ' ')

  // 3. Remove common technical tags
  cleaned = cleaned.replace(
    /\b(1080p|720p|4k|uhd|bluray|dvd|x264|x265|aac|hevc|web-dl|webrip|brrip)\b/gi,
    ' '
  )

  // 4. Trim whitespace so the "end of string" anchor `$` works correctly for the year.
  cleaned = cleaned.trim()

  // 5. Remove year if it is at the end of the string and enclosed in () or []
  cleaned = cleaned.replace(/\s*[\[(](19|20)\d{2}[)\]]\s*$/, '')

  // 6. Final cleanup of any remaining multiple spaces and trim.
  return cleaned.replace(/\s+/g, ' ').trim()
}

export async function downloadImage(url: string, destinationPath: string): Promise<void> {
  try {
    // Ensure the destination directory exists before writing the file.
    const dir = path.dirname(destinationPath)
    await fs.mkdir(dir, { recursive: true })

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageBuffer = Buffer.from(await (response as any).arrayBuffer())
    await fs.writeFile(destinationPath, imageBuffer)
  } catch (error) {
    console.error(`Error during image download or save from ${url}:`, error)
    // Re-throw the error so the calling function knows the operation failed.
    throw error
  }
}

export async function fetchAndApplyMetadata(
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
      const videoFiles = item.children.filter((c) => c.type === 'file')
      const significantSubfolders = item.children.filter(
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
      item.tmdbId = result.id
      item.mediaType = result.media_type ?? endpoint // Fallback to our guessed endpoint type
      item.title = result.title || result.name // 'title' for movie, 'name' for tv
      item.overview = result.overview
      if (item.type === 'file') {
        item.opensAsFolder = true
      }

      const date = result.release_date || result.first_air_date
      if (date) {
        item.year = new Date(date).getFullYear()
      }

      if (result.genre_ids && Array.isArray(result.genre_ids) && genreCache.size > 0) {
        item.genres = result.genre_ids
          .map((id: number) => genreCache.get(id))
          .filter((name): name is string => !!name)
      }

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
          // Do not set item.posterPath if download fails
        }
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

import type { Settings } from './settings'

export async function fetchItemDetails(
  item: LibraryItem,
  settings: Pick<Settings, 'tmdbApiKey' | 'useLogos'>,
  libraryDataPath: string
): Promise<void> {
  if (!item.tmdbId || !item.mediaType) {
    console.log(`Skipping details fetch for "${item.name}", no tmdbId or mediaType.`)
    return
  }

  const imagesDir = getImagesPath(libraryDataPath)
  const detailUrl = `https://api.themoviedb.org/3/${item.mediaType}/${item.tmdbId}?api_key=${settings.tmdbApiKey}&append_to_response=images`

  console.log(`[TMDB] Fetching details for "${item.title ?? item.name}" from ${detailUrl}`)

  try {
    const response = await fetch(detailUrl)
    if (!response.ok) {
      throw new Error(`TMDB detail fetch failed: ${response.statusText}`)
    }
    const details = await response.json()

    // --- Poster ---
    // Explicitly check if undefined (null means user has permanently removed the image).
    if (typeof item.posterPath === 'undefined') {
      if (details.poster_path) {
        const posterUrl = `https://image.tmdb.org/t/p/w500${details.poster_path}`
        const posterFileName = `${item.id}.jpg`
        const posterDestPath = path.join(imagesDir, posterFileName)
        try {
          await downloadImage(posterUrl, posterDestPath)
          item.posterPath = posterFileName
          console.log(`[TMDB] Downloaded poster for "${item.title ?? item.name}"`)
        } catch {
          item.posterPath = null // Mark as failed to prevent retries
        }
      } else {
        item.posterPath = null // No poster provided by API
      }
    }

    // --- Backdrop ---
    if (typeof item.backdropPath === 'undefined') {
      if (details.backdrop_path) {
        const backdropUrl = `https://image.tmdb.org/t/p/original${details.backdrop_path}`
        const backdropFileName = `${item.id}-backdrop.jpg`
        const backdropDestPath = path.join(imagesDir, backdropFileName)
        try {
          await downloadImage(backdropUrl, backdropDestPath)
          item.backdropPath = backdropFileName
          console.log(`[TMDB] Downloaded backdrop for "${item.title ?? item.name}"`)
        } catch {
          item.backdropPath = null
        }
      } else {
        item.backdropPath = null
      }
    }

    // --- Logo ---
    if (settings.useLogos) {
      if (typeof item.logoPath === 'undefined') {
        const logos = details.images?.logos
        const bestLogo =
          logos?.find((l) => l.iso_639_1 === 'en') ||
          logos?.find((l) => l.iso_639_1 === null) ||
          logos?.[0]

        if (bestLogo) {
          const logoUrl = `https://image.tmdb.org/t/p/w500${bestLogo.file_path}`
          const extension = path.extname(bestLogo.file_path)
          const logoFileName = `${item.id}-logo${extension}`
          const logoDestPath = path.join(imagesDir, logoFileName)
          try {
            await downloadImage(logoUrl, logoDestPath)
            item.logoPath = logoFileName
            console.log(`[TMDB] Downloaded logo for "${item.title ?? item.name}"`)
          } catch {
            item.logoPath = null
          }
        } else {
          item.logoPath = null
        }
      }
    } else {
      // If setting is disabled, ensure logo path is null
      item.logoPath = null
    }

    // Update other metadata fields
    if (details.overview) {
      item.overview = details.overview
    }
    const date = details.release_date || details.first_air_date
    if (date) {
      item.year = new Date(date).getFullYear()
    }
    if (details.genres && Array.isArray(details.genres)) {
      item.genres = details.genres.map((g: { name: string }) => g.name)
    }

    // Mark details as fetched to prevent future redundant calls.
    // This is the last step in a successful fetch.
    item.tmdbDetailsFetched = true

    // --- TV Show Specific Logic ---
    if (
      item.type === 'folder' &&
      item.mediaType === 'tv' &&
      (item as MediaFolder).process_tv_children !== false &&
      details.seasons
    ) {
      console.log(`[TMDB] Found ${details.seasons.length} seasons for "${item.name}".`)
      item.tmdbSeasons = details.seasons // Cache the full season data

      const seasonFolders = item.children.filter(
        (c) => c.type === 'folder' && c.mediaType === 'season'
      ) as MediaFolder[]

      if (seasonFolders.length > 0) {
        // Scenario A: Map TMDB season data to local season folders
        for (const seasonFolder of seasonFolders) {
          const tmdbSeason = details.seasons.find(
            (s) => s.season_number === seasonFolder.seasonNumber
          )
          if (tmdbSeason) {
            seasonFolder.title = tmdbSeason.name
            seasonFolder.overview = tmdbSeason.overview
            if (tmdbSeason.poster_path) {
              const posterUrl = `https://image.tmdb.org/t/p/w500${tmdbSeason.poster_path}`
              const posterFileName = `${seasonFolder.id}.jpg`
              const posterDestPath = path.join(imagesDir, posterFileName)
              try {
                await downloadImage(posterUrl, posterDestPath)
                seasonFolder.posterPath = posterFileName
              } catch {
                // Ignore download error
              }
            }
          }
        }
      } else {
        // Scenario B: "File Mode". Find all seasons present in loose files and fetch data for each.
        const filesWithSeason = item.children.filter(
          (c) => c.type === 'file' && typeof (c as MediaFile).seasonNumber !== 'undefined'
        ) as MediaFile[]

        if (filesWithSeason.length > 0) {
          // Group files by season number to handle multiple seasons in one folder
          const seasonsToFetch = new Set(filesWithSeason.map((f) => f.seasonNumber!))

          for (const seasonNum of seasonsToFetch) {
            // We create a temporary "fake" season folder object to pass to the fetch function.
            // It contains the children only for the current season number being processed.
            const fakeSeasonFolder: MediaFolder = {
              ...(item as MediaFolder), // Copy properties from the show's root folder
              seasonNumber: seasonNum,
              children: filesWithSeason.filter((f) => f.seasonNumber === seasonNum)
            }

            console.log(
              `[TMDB] TV show is in "File Mode". Fetching episodes for Season ${seasonNum}.`
            )
            await fetchAndApplyEpisodeData(
              fakeSeasonFolder,
              item.tmdbId!,
              settings.tmdbApiKey!,
              libraryDataPath
            )
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error fetching full details for "${item.name}":`, error)
  }
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
  libraryDataPath: string
): Promise<void> {
  // If the folder passed doesn't have a season number, it's the TV show root
  // in "File Mode", and we are fetching details for season 1. For actual season
  // folders, `seasonFolder.seasonNumber` will be defined from the earlier
  // local file analysis step.
  const seasonNumber = seasonFolder.seasonNumber ?? 1

  const episodeApiUrl = `https://api.themoviedb.org/3/tv/${showTmdbId}/season/${seasonNumber}?api_key=${tmdbApiKey}`
  console.log(
    `[TMDB] Fetching episodes for "${seasonFolder.name}" (S${seasonNumber}) from ${episodeApiUrl}`
  )

  try {
    const response = await fetch(episodeApiUrl)
    if (!response.ok) {
      throw new Error(`TMDB episode fetch failed: ${response.statusText}`)
    }
    const seasonDetails = await response.json()
    const tmdbEpisodes = seasonDetails.episodes

    if (!tmdbEpisodes || tmdbEpisodes.length === 0) {
      console.log(`[TMDB] No episode data found for season ${seasonNumber}.`)
      return
    }

    const localEpisodes = seasonFolder.children.filter((c) => c.type === 'file') as MediaFile[]

    for (const localEpisode of localEpisodes) {
      if (typeof localEpisode.episodeNumber === 'undefined') continue

      const tmdbEpisode = tmdbEpisodes.find((e) => e.episode_number === localEpisode.episodeNumber)

      if (tmdbEpisode) {
        localEpisode.title = tmdbEpisode.name
        localEpisode.overview = tmdbEpisode.overview
        localEpisode.mediaType = 'episode'
        if (tmdbEpisode.still_path) {
          const posterUrl = `https://image.tmdb.org/t/p/w500${tmdbEpisode.still_path}`
          const imagesDir = getImagesPath(libraryDataPath)
          const posterFileName = `${localEpisode.id}.jpg`
          const posterDestPath = path.join(imagesDir, posterFileName)
          try {
            await downloadImage(posterUrl, posterDestPath)
            localEpisode.posterPath = posterFileName
            // Bust the cache for the new image. This is the critical fix.
            localEpisode._v = Date.now()
          } catch {
            // ignore download error
          }
        }
      }
    }

    // Mark details as fetched to prevent future redundant API calls for this season.
    seasonFolder.tmdbDetailsFetched = true
  } catch (error) {
    console.error(`Error fetching episode data for season ${seasonNumber}:`, error)
  }
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
          season_number: s.season_number
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
        season_number: s.season_number
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
    return {
      posters: images.posters || [],
      backdrops: images.backdrops || [],
      logos: images.logos || []
    }
  } catch (error) {
    console.error(`Error fetching images for "${tmdbId}":`, error)
    return { posters: [], backdrops: [], logos: [] }
  }
}
