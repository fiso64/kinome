import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { createTmdbProvider } from './metadata-provider'
import * as tmdb from './retriever.service'

const film = (id: number, year: number, title = 'The Thing') =>
  ({ id, title, release_date: `${year}-06-25`, media_type: 'movie' })
let search: ReturnType<typeof spyOn<typeof tmdb, 'search'>>

afterEach(() => search?.mockRestore())

describe('automatic TMDB matching', () => {
  it('prefers the exact year over a more popular remake and a one-year difference', async () => {
    search = spyOn(tmdb, 'search').mockResolvedValue([film(1, 2011), film(2, 1983), film(3, 1982)])
    const provider = createTmdbProvider('test')
    expect(await provider.match('The Thing', 'movie', 1982)).toEqual({ id: 3, type: 'movie' })
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('The Thing', 'movie', 'test', { year: '1982' })
  })

  it('checks the unfiltered results before accepting a nearby date', async () => {
    search = spyOn(tmdb, 'search').mockResolvedValueOnce([film(2, 1983)])
      .mockResolvedValueOnce([film(2, 1983), film(3, 1982)])
    expect(await createTmdbProvider('test').match('The Thing', 'movie', 1982)).toEqual({ id: 3, type: 'movie' })
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('accepts a unique exact title one year away even when the year filter returns nothing', async () => {
    search = spyOn(tmdb, 'search').mockResolvedValueOnce([])
      .mockResolvedValueOnce([film(1, 2011), film(2, 1983), film(3, 1982, 'The Other Thing')])
    expect(await createTmdbProvider('test').match('The Thing', 'movie', 1982)).toEqual({ id: 2, type: 'movie' })
    expect(search).toHaveBeenCalledTimes(2)
  })

  it.each([
    [film(1, 2011)],
    [film(1, 1981), film(2, 1983)],
    [film(1, 1982), film(2, 1982)],
    [film(1, 1982, 'The Other Thing')]
  ].map((results) => [results] as const))('leaves a mismatched or ambiguous result unresolved (%j)', async (results) => {
    search = spyOn(tmdb, 'search').mockResolvedValue(results)
    expect(await createTmdbProvider('test').match('The Thing', 'movie', 1982)).toBeNull()
    expect(search.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('ranks mixed results by type, original title, and year in a single response', async () => {
    search = spyOn(tmdb, 'search').mockResolvedValue([
      film(1, 2011),
      { id: 2, title: 'The Thing', media_type: 'person' },
      { id: 3, name: 'Translated', original_name: 'Thé Thing', first_air_date: '1982-05-30', media_type: 'tv' }
    ])
    expect(await createTmdbProvider('test').match('The Thing', 'multi', 1982)).toEqual({ id: 3, type: 'tv' })
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('tries an intact numerical title first and spends at most one request on its alternate', async () => {
    search = spyOn(tmdb, 'search').mockResolvedValueOnce([film(1, 2017, 'Blade Runner 2049')])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([film(2, 1995, 'Heat')])
    const provider = createTmdbProvider('test')
    expect(await provider.match('Blade Runner 2049', 'movie', undefined, { title: 'Blade Runner', year: 2049 }))
      .toEqual({ id: 1, type: 'movie' })
    expect(await provider.match('Heat 1995', 'movie', undefined, { title: 'Heat', year: 1995 }))
      .toEqual({ id: 2, type: 'movie' })
    expect(search.mock.calls.map(([query]) => query)).toEqual(['Blade Runner 2049', 'Heat 1995', 'Heat'])
  })

  it('uses the typed year for a show and coalesces identical in-flight requests', async () => {
    search = spyOn(tmdb, 'search').mockResolvedValue([
      { id: 1, name: 'Dark', first_air_date: '2017-12-01' }
    ])
    const provider = createTmdbProvider('test')
    const match = { id: 1, type: 'tv' } as const
    expect(await Promise.all([provider.match('Dark', 'tv', 2017), provider.match('Dark', 'tv', 2017)]))
      .toEqual([match, match])
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('Dark', 'tv', 'test', { year: '2017' })
  })
})
