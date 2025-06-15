import path from 'path'
import fs from 'fs/promises'
import type { LibraryItem } from './types'

const genreCache = new Map<number, string>()

export async function cacheGenreLists(tmdbApiKey: string): Promise<void> {
  // Don't re-fetch if the cache is already populated.
  if (genreCache.size > 0) {
    return
  }
  console.log('[TMDB] Caching genre lists...')

  const endpoints = ['movie', 'tv']
  try {
    const promises = endpoints.map((type) =>
      fetch(`https://api.themoviedb.org/3/genre/${type}/list?api_key=${tmdbApiKey}`)
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to fetch ${type} genres.`)
          return res.json()
        })
        .then((data) => {
          for (const genre of data.genres) {
            genreCache.set(genre.id, genre.name)
          }
        })
    )
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

async function downloadImage(url: string, destinationPath: string): Promise<void> {
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
  libraryDataPath: string
): Promise<void> {
  let endpoint: 'movie' | 'tv' | 'multi' = 'multi'

  // Apply heuristics to determine the best search endpoint
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

  const query = parseTitle(item.name)
  if (!query) return

  const searchUrl = `https://api.themoviedb.org/3/search/${endpoint}?api_key=${tmdbApiKey}&query=${encodeURIComponent(query)}`

  try {
    const searchResponse = await fetch(searchUrl)
    if (!searchResponse.ok) {
      console.error(`TMDB search failed for "${query}": ${searchResponse.statusText}`)
      return
    }

    const searchResults = await searchResponse.json()
    const firstResultTitle = searchResults.results?.[0]?.title ?? searchResults.results?.[0]?.name ?? 'None'
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
    console.log(`Skipping poster refetch for "${item.name}", no tmdbId or mediaType.`);
    return
  }

  const detailUrl = `https://api.themoviedb.org/3/${item.mediaType}/${item.tmdbId}?api_key=${tmdbApiKey}`

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

export async function fetchItemDetails(
  item: LibraryItem,
  tmdbApiKey: string,
  libraryDataPath: string
): Promise<void> {
  if (!item.tmdbId || !item.mediaType) {
    console.log(`Skipping details fetch for "${item.name}", no tmdbId or mediaType.`)
    return
  }

  const detailUrl = `https://api.themoviedb.org/3/${item.mediaType}/${item.tmdbId}?api_key=${tmdbApiKey}`
  console.log(`[TMDB] Fetching details for "${item.title ?? item.name}" from ${detailUrl}`)

  try {
    const response = await fetch(detailUrl)
    if (!response.ok) {
      throw new Error(`TMDB detail fetch failed: ${response.statusText}`)
    }
    const details = await response.json()

    if (details.backdrop_path) {
      const backdropUrl = `https://image.tmdb.org/t/p/original${details.backdrop_path}`
      const imagesDir = getImagesPath(libraryDataPath)
      const backdropFileName = `${item.id}-backdrop.jpg`
      const backdropDestPath = path.join(imagesDir, backdropFileName)
      try {
        await downloadImage(backdropUrl, backdropDestPath)
        item.backdropPath = backdropFileName
        console.log(`[TMDB] Downloaded backdrop for "${item.title ?? item.name}"`)
      } catch {
        console.error(`Failed to download or save backdrop for item: ${item.name}`)
        // Do not set item.backdropPath if download fails
      }
    }

    // We can also update other fields here if they are more detailed than the search result
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
  } catch (error) {
    console.error(`Error fetching full details for "${item.name}":`, error)
  }
}
