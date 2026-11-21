import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../test-helpers'
import { find as findItems, getItemById } from '../../services/repository.service'
import { compileFilter } from '../query-builder'
import { findByFtsQuery, findByTagsOnly } from './search.repo'
import {
  replaceVirtualTags, saveProviderMatch, upsertMetadata
} from './metadata.repo'
import { getDistinctGenreNames, getDistinctMetadataValues, suggestStoredMetadataValues } from './metadata-suggestions.repo'

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

  it('returns TMDB suggestions as spelled on visible items', () => {
    ctx.seedEntities([{ id: 'a' }, { id: 'b' }])
    ctx.seedItems([{ id: 'unlisted', entityId: 'a' }, { id: 'listed', entityId: 'b' }])
    ctx.db.exec(`
      INSERT INTO tmdb_entity_values (entity_id, field, value) VALUES
        ('a', 'studios', 'STUDIO'), ('a', 'studios', 'Studio Extra'), ('b', 'studios', 'Studio');
      UPDATE media_entities SET tmdb_original_language = CASE id WHEN 'a' THEN 'en' ELSE 'ja' END;
      INSERT INTO accounts (id, username, password_hash, created_at)
      VALUES ('viewer', 'viewer', 'hash', 1000);
      INSERT INTO account_filter_rules (account_id, mode, filter_json)
      VALUES ('viewer', 'allow', '{}');
      INSERT INTO account_visible_items (account_id, item_id) VALUES ('viewer', 'listed');
    `)

    expect(suggestStoredMetadataValues('studios', 'stu', 20, 'viewer')).toEqual(['Studio'])
    expect(suggestStoredMetadataValues('originalLanguage', '', 20, 'viewer')).toEqual(['ja'])
  })

  it('rebuilds virtual tags in case order and writes only changed results', () => {
    ctx.seedItems([{ id: 'root', type: 'folder' }, { id: 'film', parentId: 'root' }])
    const tags = [{
      id: 'source', name: 'source',
      cases: [{ filter: { conditions: [] }, result: 'Fresh' }],
      defaultResult: 'Fallback'
    }, {
      id: 'derived', name: 'derived',
      cases: [
        { filter: { conditions: [{ field: 'vt.future', op: 'isNotNull' as const }] }, result: 'Stale' },
        { filter: { conditions: [{ field: 'vt.source', op: 'eq' as const, value: 'Fresh' }] }, result: 'Correct' }
      ]
    }]
    ctx.db.exec(`INSERT INTO item_virtual_tags VALUES ('film', 'future', 'Stale'), ('film', 'source', 'Old')`)

    expect(replaceVirtualTags(tags)).toBe(3)
    expect(ctx.db.query('SELECT key, value FROM item_virtual_tags ORDER BY key').all()).toEqual([
      { key: 'derived', value: 'Correct' },
      { key: 'source', value: 'Fresh' }
    ])
    expect(replaceVirtualTags(tags)).toBe(0)
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
    expect(replaceVirtualTags(rules)).toBe(2)
    expect(suggestStoredMetadataValues('studios', 'star', 20)).toEqual(['North Star Pictures'])
    expect(findByTagsOnly([{ key: 'tmdb.studios', value: 'north star pictures' }], 20)).toHaveLength(2)
    expect(findByFtsQuery('{title original_title name} : "Orbit"', [{ key: 'tmdb.contentRating', value: 'pg-13' }], 20)).toHaveLength(2)

    saveProviderMatch('first', 'tmdb', match, { ...details, metadata: { status: 'Released', tmdbRating: 7, studios: ['Other'] } })
    expect(matchingIds()).toEqual([])
    expect(replaceVirtualTags(rules)).toBe(2)
    expect(suggestStoredMetadataValues('studios', 'star', 20)).toEqual([])
    expect(findByTagsOnly([{ key: 'tmdb.contentRating', value: 'PG-13' }], 20)).toEqual([])
    upsertMetadata('extra', { tags: { studios: 'North Star Pictures' } })
    expect(findByTagsOnly([{ key: 'studios', value: 'north star pictures' }], 20).map(({ id }) => id))
      .toEqual(['extra'])
  })

})
