import { parseTitle } from '../utils/title-parser'

const genreCache = new Map<number, string>()

/**
 * Lightweight TMDB API Client.
 * Invariant: No database logic. No item-update broadcasts. No image processing.
 * Just fetches and returns structured JSON.
 */

const getUrl = (path: string, apiKey: string, params: Record<string, string> = {}) => {
  const url = new URL(`https://api.themoviedb.org/3/${path}`)
  url.searchParams.set('api_key', apiKey)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return url.toString()
}

/**
 * Populate the genre cache for mapping IDs to names.
 */
export async function cacheGenreLists(tmdbApiKey: string): Promise<void> {
  if (genreCache.size > 0) return

  try {
    const endpoints = ['movie', 'tv']
    const results = await Promise.all(
      endpoints.map(async (type) => {
        const res = await fetch(getUrl(`genre/${type}/list`, tmdbApiKey))
        if (!res.ok) throw new Error(`Failed to fetch ${type} genres.`)
        return res.json() as Promise<any>
      })
    )

    for (const data of results) {
      for (const genre of data.genres) {
        genreCache.set(genre.id, genre.name)
      }
    }
  } catch (error) {
    console.error('[TMDB] Failed to cache genre lists:', error)
  }
}

export function getGenreName(id: number): string | undefined {
  return genreCache.get(id)
}

/**
 * Generic Search
 */
export async function search(
  query: string,
  type: 'movie' | 'tv' | 'multi',
  apiKey: string,
  options: { year?: string } = {}
): Promise<any[]> {
  const params: Record<string, string> = { query }
  if (options.year) {
    if (type === 'movie') params.primary_release_year = options.year
    if (type === 'tv') params.first_air_date_year = options.year
  }

  console.log(`[TMDB] search/${type}: "${query}"`)
  const res = await fetch(getUrl(`search/${type}`, apiKey, params))
  if (!res.ok) return []
  const data = (await res.json()) as any

  // For multi, filter to relevant media
  let results = data.results || []
  if (type === 'multi') {
    results = results.filter((r: any) => r.media_type === 'movie' || r.media_type === 'tv')
  }

  return results
}

/**
 * Fetch Full Details
 */
export async function getDetails(
  id: number,
  type: 'movie' | 'tv' | 'season',
  apiKey: string,
  extras = 'images'
): Promise<any | null> {
  // Seasons need showId in path
  console.log(`[TMDB] getDetails for ${type} ${id}`)
  const res = await fetch(getUrl(`${type}/${id}`, apiKey, { append_to_response: extras }))
  if (!res.ok) return null
  return res.json()
}

export async function getSeasonDetails(
  showId: number,
  seasonNumber: number,
  apiKey: string
): Promise<any | null> {
  console.log(`[TMDB] getSeasonDetails for show ${showId} S${seasonNumber}`)
  const res = await fetch(getUrl(`tv/${showId}/season/${seasonNumber}`, apiKey))
  if (!res.ok) return null
  return res.json()
}

/**
 * Fetch Credits (Aggregated for TV)
 */
export async function getCredits(
  id: number,
  type: 'movie' | 'tv',
  apiKey: string
): Promise<any | null> {
  console.log(`[TMDB] getCredits for ${type} ${id}`)
  const endpoint = type === 'tv' ? 'aggregate_credits' : 'credits'
  const res = await fetch(getUrl(`${type}/${id}/${endpoint}`, apiKey))
  if (!res.ok) return null
  return res.json()
}

/**
 * Fetch Images (Explicitly)
 */
export async function getImages(
  id: number,
  type: 'movie' | 'tv',
  apiKey: string,
  language?: string
): Promise<any | null> {
  const params: Record<string, string> = {}

  // TMDB /images is not paginated; it returns all matches in one go.
  // To ensure we get both the requested language AND high-quality textless (null) images,
  // we must use include_image_language.
  if (language && language !== 'none') {
    params.include_image_language = `${language},null`
  }

  console.log(`[TMDB] getImages for ${type} ${id} (lang: ${language ?? 'default'})`)
  const res = await fetch(getUrl(`${type}/${id}/images`, apiKey, params))
  if (!res.ok) return null
  return res.json()
}

/**
 * Manual Search (Used by UI)
 */
export async function manualSearch(
  query: string,
  type: 'movie' | 'tv' | 'season',
  apiKey: string,
  options: { year?: string; tmdbId?: string } = {}
): Promise<any[]> {
  // 1. ID Search
  console.log(`[TMDB] manualSearch for ${type} ${options.tmdbId}`)
  if (options.tmdbId?.trim()) {
    const searchType = type === 'season' ? 'tv' : type
    const details = await getDetails(Number(options.tmdbId), searchType, apiKey)
    if (!details) return []

    if (type === 'season') {
      return (details.seasons || []).map((s: any) => ({
        id: s.id,
        title: s.name,
        name: s.name,
        first_air_date: s.air_date,
        poster_path: s.poster_path,
        overview: s.overview,
        season_number: s.season_number,
        episode_count: s.episode_count
      }))
    }

    return [
      {
        id: details.id,
        title: details.title || details.name,
        name: details.name,
        release_date: details.release_date,
        first_air_date: details.first_air_date,
        poster_path: details.poster_path,
        overview: details.overview
      }
    ]
  }

  // 2. Text Search
  if (!query.trim()) return []

  if (type === 'season') {
    const shows = await search(query, 'tv', apiKey)
    const show = shows[0]
    if (!show) return []

    const details = await getDetails(show.id, 'tv', apiKey)
    if (!details || !details.seasons) return []

    return details.seasons.map((s: any) => ({
      id: s.id,
      title: s.name,
      name: s.name,
      first_air_date: s.air_date,
      poster_path: s.poster_path,
      overview: s.overview,
      season_number: s.season_number,
      episode_count: s.episode_count
    }))
  }

  const results = await search(query, type as any, apiKey, { year: options.year })
  return results.map((r: any) => ({
    id: r.id,
    title: r.title || r.name,
    name: r.name,
    release_date: r.release_date,
    first_air_date: r.first_air_date,
    poster_path: r.poster_path,
    overview: r.overview
  }))
}
