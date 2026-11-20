import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../test-helpers'
import { find as findItems, getItemById } from '../../services/repository.service'
import { compileFilter } from '../query-builder'
import { findByFtsQuery, findByTagsOnly } from './search.repo'
import {
  clearVirtualTags, evaluateAndInsertVirtualTags, getDistinctGenreNames, getDistinctMetadataValues,
  saveProviderMatch, suggestTmdbValues, upsertMetadata
} from './metadata.repo'

describe('metadata repository', () => {
  let ctx: ServiceTestContext

  beforeEach(() => {
    ctx = createServiceTestContext()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  it('persists TMDB runtime through the scalar metadata registry', () => {
    ctx.seedItems([{ id: 'movie-1', name: 'Movie.mkv', type: 'file' }])

    upsertMetadata('movie-1', {
      mediaType: 'movie',
      title: 'Registry Movie',
      tmdbRuntime: 82,
      releaseDate: '1998-02-28'
    })

    const item = getItemById('movie-1')

    expect(item?.tmdbRuntime).toBe(82)
    expect(item?.releaseDate).toBe('1998-02-28')
  })

  it('suggests effective values from item overrides and provider fallbacks', () => {
    ctx.seedEntities([
      { id: 'shared', mediaType: 'movie', year: 1998 },
      { id: 'overridden', mediaType: 'tv', year: 2002 },
    ])
    ctx.seedItems([
      { id: 'original', entityId: 'shared' },
      { id: 'edition', entityId: 'shared' },
      { id: 'cleared', entityId: 'overridden' },
    ])
    ctx.seedGenres('shared', ['Drama'])
    ctx.seedGenres('overridden', ['Crime'])
    upsertMetadata('edition', { year: 1999, genres: ['Comedy'] })
    upsertMetadata('cleared', { mediaType: null, year: null, genres: [] })

    expect(getDistinctMetadataValues('media_type')).toEqual(['movie'])
    expect(getDistinctMetadataValues('year')).toEqual(['1998', '1999'])
    expect(getDistinctGenreNames()).toEqual(['Comedy', 'Drama'])
  })
  it('shares typed TMDB facts across copies and uses them in rules and search', () => {
    ctx.seedItems([
      { id: 'root', type: 'folder' },
      { id: 'first', parentId: 'root', name: 'Orbit One.mkv' },
      { id: 'second', parentId: 'root', name: 'Orbit Two.mkv' },
      { id: 'extra', parentId: 'first', name: 'Extras.mkv' }
    ])
    const match = { id: 19, type: 'movie' } as const
    const details = {
      title: 'Orbit', originalTitle: null, overview: null, releaseDate: null,
      year: null, runtime: null, genres: [], artwork: {},
      metadata: {
        status: 'Released', contentRating: 'PG-13', tmdbRating: 8.2, tmdbVoteCount: 105,
        studios: ['North Star Pictures'], productionCountries: ['US'],
        imdbId: 'tt123', homepage: 'https://example.com/'
      }
    }
    const saved = saveProviderMatch('first', 'tmdb', match, details)
    expect(saved.metadataChanged).toBe(true)
    expect(saveProviderMatch('first', 'tmdb', match, details).metadataChanged).toBe(false)
    expect(saveProviderMatch('second', 'tmdb', match).entityId).toBe(saved.entityId)
    expect(findItems({ where: { id: 'second' }, fields: ['tmdbMetadata'] })[0].tmdbMetadata)
      .toMatchObject(details.metadata)

    const filter = { conditionGroups: [[
      { field: 'tmdbRating', op: 'gte' as const, value: '8.0' },
      { field: 'studios', op: 'contains' as const, value: 'Star' }
    ]] }
    const matchingIds = () => findItems({ ...compileFilter(filter), fields: ['id'] })
      .map(({ id }) => id).sort()
    expect(matchingIds()).toEqual(['first', 'second'])
    expect(findItems({
      ...compileFilter({ conditionGroups: [[
        { field: 'parent.contentRating', op: 'eq', value: 'pg-13' }
      ]] }),
      fields: ['id']
    }).map(({ id }) => id)).toEqual(['extra'])

    const rules = [{ id: 'staff', name: 'Staff pick', cases: [{ filter, result: 'Yes' }] }]
    expect(evaluateAndInsertVirtualTags(rules)).toBe(2)
    expect(suggestTmdbValues('studios', 'star', 20)).toEqual(['North Star Pictures'])
    expect(findByTagsOnly([{ key: 'tmdb.studios', value: 'north star pictures' }], 20)).toHaveLength(2)
    expect(findByFtsQuery('{title original_title name} : "Orbit"', [{ key: 'tmdb.contentRating', value: 'pg-13' }], 20)).toHaveLength(2)

    saveProviderMatch('first', 'tmdb', match, { ...details, metadata: { status: 'Released', tmdbRating: 7, studios: ['Other'] } })
    expect(matchingIds()).toEqual([])
    clearVirtualTags()
    expect(evaluateAndInsertVirtualTags(rules)).toBe(0)
    expect(suggestTmdbValues('studios', 'star', 20)).toEqual([])
    expect(findByTagsOnly([{ key: 'tmdb.contentRating', value: 'PG-13' }], 20)).toEqual([])
    upsertMetadata('extra', { tags: { studios: 'North Star Pictures' } })
    expect(findByTagsOnly([{ key: 'studios', value: 'north star pictures' }], 20).map(({ id }) => id))
      .toEqual(['extra'])
  })

})
