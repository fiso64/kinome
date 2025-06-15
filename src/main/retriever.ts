import path from 'path'
import fs from 'fs/promises'
import type { LibraryItem } from './types'

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
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageBuffer = Buffer.from(await (response as any).arrayBuffer())
    await fs.writeFile(destinationPath, imageBuffer)
  } catch (error) {
    console.error(`Error downloading image from ${url}:`, error)
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
      item.mediaType = result.media_type ?? endpoint // Fallback to our guessed endpoint type
      item.title = result.title || result.name // 'title' for movie, 'name' for tv
      item.overview = result.overview

      if (result.poster_path) {
        const posterUrl = `https://image.tmdb.org/t/p/w500${result.poster_path}`
        const imagesDir = getImagesPath(libraryDataPath)
        await fs.mkdir(imagesDir, { recursive: true })
        const posterFileName = `${item.id}.jpg`
        const posterDestPath = path.join(imagesDir, posterFileName)
        await downloadImage(posterUrl, posterDestPath)
        item.posterPath = posterFileName
      }
    } else {
      console.log(`No TMDB result found for "${query}" with endpoint "${endpoint}"`)
    }
  } catch (error) {
    console.error(`Error fetching metadata for "${item.name}":`, error)
  }
}
