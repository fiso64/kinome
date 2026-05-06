import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../test-helpers'
import { getItemById } from '../../services/repository.service'
import { upsertMetadata } from './metadata.repo'

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
})
