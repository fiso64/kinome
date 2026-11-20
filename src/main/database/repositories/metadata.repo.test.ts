import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../test-helpers'
import { getItemById } from '../../services/repository.service'
import { getDistinctGenreNames, getDistinctMetadataValues, upsertMetadata } from './metadata.repo'

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
})
