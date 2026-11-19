import type { LibraryItem, Person, TmdbEpisode, TmdbSeason } from '@shared/types'
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
  artwork: Partial<Record<'poster' | 'backdrop' | 'logo', string>>
  seasons?: TmdbSeason[]
}

export interface MetadataProvider {
  name: string
  match(query: string, type: ProviderMediaType | 'multi', year?: number): Promise<ProviderMatch | null>
  details(match: ProviderMatch): Promise<ProviderDetails | null>
  credits(match: ProviderMatch): Promise<NonNullable<LibraryItem['tmdbCredits']> | null>
  episodes(showId: number, season: number): Promise<TmdbEpisode[] | null>
}

function artworkUrl(filePath: string | undefined, size: 'w500' | 'original'): string | undefined {
  return filePath ? `https://image.tmdb.org/t/p/${size}${filePath}` : undefined
}

export function createTmdbProvider(apiKey: string): MetadataProvider {
  return {
    name: 'tmdb',
    async match(query, type, year) {
      const [result] = await tmdb.search(query, type, apiKey, { year: year?.toString() })
      if (!result) return null
      return { id: result.id, type: result.media_type || (type === 'multi' ? 'movie' : type) }
    },
    async details({ id, type }) {
      const details = await tmdb.getDetails(id, type, apiKey)
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
