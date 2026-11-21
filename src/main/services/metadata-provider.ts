import type { LibraryItem, Person, TmdbEpisode, TmdbSeason } from '@shared/types'
import type { TmdbMetadata } from '@shared/metadata-fields'
import { comparableTitle, type TitleQuery } from '../utils/title-parser'
import * as tmdb from './retriever.service'

export type ProviderMediaType = 'movie' | 'tv'
export type ProviderMatch = { id: number; type: ProviderMediaType }

export interface ProviderDetails {
  title: string | null
  originalTitle: string | null
  overview: string | null
  releaseDate: string | null
  year: number | null
  runtime: number | null
  genres: string[]
  metadata?: TmdbMetadata
  artwork: Partial<Record<'poster' | 'backdrop' | 'logo', string>>
  seasons?: TmdbSeason[]
}

export interface MetadataProvider {
  name: string
  match(query: string, type: ProviderMediaType | 'multi', year?: number, alternate?: TitleQuery): Promise<ProviderMatch | null>
  details(match: ProviderMatch, options?: { includeArtwork?: boolean }): Promise<ProviderDetails | null>
  credits(match: ProviderMatch): Promise<NonNullable<LibraryItem['tmdbCredits']> | null>
  episodes(showId: number, season: number): Promise<TmdbEpisode[] | null>
}

function artworkUrl(filePath: string | undefined, size: 'w500' | 'original'): string | undefined {
  return filePath ? `https://image.tmdb.org/t/p/${size}${filePath}` : undefined
}

interface SearchResult {
  id: number
  media_type?: ProviderMediaType
  title?: string
  original_title?: string
  name?: string
  original_name?: string
  release_date?: string
  first_air_date?: string
}

function exactTitleMatches(results: SearchResult[], query: string, type: ProviderMediaType | 'multi') {
  const title = comparableTitle(query)
  const matches = new Map<string, ProviderMatch & { year: number }>()
  for (const result of results) {
    const resultType = type === 'multi' ? result.media_type : type
    if (resultType !== 'movie' && resultType !== 'tv') continue
    if (![result.title, result.original_title, result.name, result.original_name]
      .some((name) => name && comparableTitle(name) === title)) continue
    const year = Number((resultType === 'movie' ? result.release_date : result.first_air_date)?.slice(0, 4))
    matches.set(`${resultType}:${result.id}`, { id: result.id, type: resultType, year })
  }
  return [...matches.values()]
}

function uniqueMatch(matches: ProviderMatch[]): ProviderMatch | null {
  return matches.length === 1 ? { id: matches[0].id, type: matches[0].type } : null
}

export function createTmdbProvider(apiKey: string): MetadataProvider {
  const pendingDetails = new Map<string, ReturnType<typeof tmdb.getDetails>>()
  function getDetails({ id, type }: ProviderMatch, append: string) {
    const key = `${type}:${id}:${append}`
    const pending = pendingDetails.get(key)
    if (pending) return pending
    const request = tmdb.getDetails(id, type, apiKey, append).finally(() => pendingDetails.delete(key))
    pendingDetails.set(key, request)
    return request
  }

  const pendingMatches = new Map<string, Promise<ProviderMatch | null>>()

  async function matchTitle(query: string, type: ProviderMediaType | 'multi', year?: number, alternate?: TitleQuery) {
    const initial = await tmdb.search(query, type, apiKey, { year: year?.toString() })
    const candidates = exactTitleMatches(initial, query, type)
    if (year === undefined) {
      if (candidates.length || !alternate) return uniqueMatch(candidates)
      const results = await tmdb.search(alternate.title, type, apiKey)
      const alternatives = exactTitleMatches(results, alternate.title, type)
      const exact = alternatives.filter((candidate) => candidate.year === alternate.year)
      return uniqueMatch(exact.length ? exact : alternatives.filter((candidate) =>
        alternate.year !== undefined && Math.abs(candidate.year - alternate.year) === 1))
    }
    const exact = candidates.filter((candidate) => candidate.year === year)
    if (exact.length) return uniqueMatch(exact)
    const expanded = type === 'multi' ? candidates
      : exactTitleMatches([...initial, ...await tmdb.search(query, type, apiKey)], query, type)
    const expandedExact = expanded.filter((candidate) => candidate.year === year)
    return uniqueMatch(expandedExact.length ? expandedExact : expanded.filter((candidate) => Math.abs(candidate.year - year) === 1))
  }

  return {
    name: 'tmdb',
    match(query, type, year, alternate) {
      const key = `${type}:${year ?? ''}:${query}\0${alternate?.title ?? ''}\0${alternate?.year ?? ''}`
      const pending = pendingMatches.get(key)
      if (pending) return pending
      const request = matchTitle(query, type, year, alternate).finally(() => pendingMatches.delete(key))
      pendingMatches.set(key, request)
      return request
    },
    async details({ id, type }, { includeArtwork = true } = {}) {
      const ratingsEndpoint = type === 'tv' ? 'content_ratings' : 'release_dates'
      const append = includeArtwork ? `images,external_ids,${ratingsEndpoint}` : `external_ids,${ratingsEndpoint}`
      const details = await getDetails({ id, type }, append)
      if (!details) return null
      const releaseDate = details.release_date || details.first_air_date || null
      const year = releaseDate ? Number(releaseDate.slice(0, 4)) : null
      const logos = details.images?.logos ?? []
      const logo = logos.find((candidate: { iso_639_1: string | null }) => candidate.iso_639_1 === 'en')
        ?? logos.find((candidate: { iso_639_1: string | null }) => candidate.iso_639_1 === null)
        ?? logos[0]
      return {
        title: details.title || details.name || null,
        originalTitle: details.original_title || details.original_name || null,
        overview: details.overview || null,
        releaseDate,
        year: year && Number.isFinite(year) ? year : null,
        runtime: type === 'movie' && typeof details.runtime === 'number' ? details.runtime : null,
        genres: (details.genres ?? []).map(({ name }: { name: string }) => name),
        metadata: normalizeMetadata(type, details),
        artwork: {
          poster: artworkUrl(details.poster_path, 'w500'),
          backdrop: artworkUrl(details.backdrop_path, 'original'),
          logo: artworkUrl(logo?.file_path, 'w500'),
        },
        seasons: details.seasons,
      }
    },
    async credits({ id, type }) {
      const credits = await tmdb.getCredits(id, type, apiKey)
      return credits ? normalizeCredits(type, credits) : null
    },
    async episodes(showId, season) {
      const details = await tmdb.getSeasonDetails(showId, season, apiKey)
      return details ? (details.episodes ?? []).map(
        ({ episode_number, name, overview, still_path }: TmdbEpisode) => ({
          episode_number, name, overview, still_path,
        })
      ) : null
    },
  }
}

interface TmdbDetailsFields {
  status?: string
  in_production?: boolean
  vote_average?: number
  vote_count?: number
  imdb_id?: string
  external_ids?: { imdb_id?: string }
  homepage?: string
  tagline?: string
  production_companies?: { name: string }[]
  networks?: { name: string }[]
  production_countries?: { iso_3166_1: string }[]
  original_language?: string
  last_air_date?: string
  next_episode_to_air?: { air_date?: string }
  number_of_seasons?: number
  number_of_episodes?: number
  budget?: number
  revenue?: number
  content_ratings?: { results?: { iso_3166_1: string; rating: string }[] }
  release_dates?: {
    results?: {
      iso_3166_1: string
      release_dates: { type: number; certification: string }[]
    }[]
  }
}

function normalizeMetadata(type: ProviderMediaType, details: TmdbDetailsFields): TmdbMetadata {
  const inUs = (entry: { iso_3166_1: string }) => entry.iso_3166_1 === 'US'
  const movieReleases = details.release_dates?.results?.find(inUs)?.release_dates
  const movieRating = movieReleases?.find((entry) => entry.type === 3 && entry.certification)
    ?? movieReleases?.find((entry) => entry.certification)
  const imdbId = details.external_ids?.imdb_id || details.imdb_id
  const unique = (values?: string[]) => values?.length ? [...new Set(values.filter(Boolean))] : undefined

  return {
    status: details.status || undefined,
    inProduction: details.in_production ?? undefined,
    contentRating: (type === 'tv'
      ? details.content_ratings?.results?.find(inUs)?.rating
      : movieRating?.certification) || undefined,
    tmdbRating: details.vote_count ? details.vote_average ?? undefined : undefined,
    tmdbVoteCount: details.vote_count ?? undefined,
    imdbId: imdbId && /^tt\d+$/.test(imdbId) ? imdbId : undefined,
    homepage: /^https?:\/\//i.test(details.homepage ?? '') ? details.homepage : undefined,
    tagline: details.tagline || undefined,
    studios: unique(details.production_companies?.map(({ name }) => name)),
    networks: unique(details.networks?.map(({ name }) => name)),
    productionCountries: unique(details.production_countries?.map(({ iso_3166_1 }) => iso_3166_1)),
    originalLanguage: details.original_language || undefined,
    lastAirDate: details.last_air_date || undefined,
    nextAirDate: details.next_episode_to_air?.air_date || undefined,
    seasonCount: details.number_of_seasons ?? undefined,
    episodeCount: details.number_of_episodes ?? undefined,
    budget: details.budget || undefined,
    revenue: details.revenue || undefined
  }
}

/**
 * Normalizes both regular and aggregated TMDB credits.
 */
function normalizeCredits(type: ProviderMediaType, creditsData: any): NonNullable<LibraryItem['tmdbCredits']> {
  const isTv = type === 'tv'
  const isAggregated = isTv && creditsData.cast?.[0]?.roles

  if (!isAggregated) {
    return {
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

    ; (creditsData.cast ?? []).forEach((castMember: any) => {
      const p = ensurePerson(castMember.id, castMember)
      p.actingScore = Math.min(p.actingScore, castMember.order)
      p.characters.push(...(castMember.roles ?? []).map((r: any) => r.character))
      p.personData = { ...p.personData, ...castMember }
    })

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
  return { cast: finalCast, crew: finalCrew }
}
