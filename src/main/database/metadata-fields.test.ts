import { describe, expect, it } from 'bun:test'
import {
  BUILTIN_METADATA_FIELDS, ENTITY_SCALAR_METADATA_FIELDS, ENTITY_SCALAR_METADATA_KEYS,
  getMetadataSearchField, getMetadataValueField, metadataFieldKey, metadataSuggestionLookup,
  METADATA_RULE_FIELDS, METADATA_SEARCH_KEYS, type BuiltinMetadataField
} from '@shared/metadata-fields'
import { METADATA_KEYS } from '@shared/types'
import { SCHEMA_SQL } from './schema'
import { REPOSITORY_SCHEMA } from './repo-definitions'
import { compileConditionToSql } from './query-builder'
import { createServiceTestContext } from './test-helpers'
import { getAutocompleteValues, invalidateCache } from '../services/autocomplete.service'
import { saveProviderMatch, upsertMetadata } from './repositories/metadata.repo'

describe('metadata field registry', () => {
  it('keeps scalar metadata fields aligned with the repository schema and DB schema', () => {
    for (const field of ENTITY_SCALAR_METADATA_FIELDS) {
      expect(REPOSITORY_SCHEMA[field.key]).toBeDefined()
      expect(REPOSITORY_SCHEMA[field.key]?.sql).toContain(field.column)
      expect(SCHEMA_SQL).toContain(`${field.column} `)
    }
  })

  it('covers all scalar metadata keys exposed as user-editable metadata', () => {
    const scalarKeys = new Set(ENTITY_SCALAR_METADATA_KEYS)
    const nonScalarMetadataKeys = new Set([
      'genres',
      'tags',
      'opensAsFolder'
    ])

    for (const key of METADATA_KEYS) {
      expect(scalarKeys.has(key) || nonScalarMetadataKeys.has(key)).toBe(true)
    }
  })
  it('connects exposed fields to their rules, search keys, and suggestion lookups', async () => {
    const ctx = createServiceTestContext()
    invalidateCache()
    try {
      const fields = Object.keys(BUILTIN_METADATA_FIELDS) as BuiltinMetadataField[]
      expect(METADATA_SEARCH_KEYS).toHaveLength(fields.filter((key) => BUILTIN_METADATA_FIELDS[key].search).length)
      expect(METADATA_RULE_FIELDS).toHaveLength(fields.filter((key) => BUILTIN_METADATA_FIELDS[key].rule).length)

      for (const field of fields) {
        const definition = BUILTIN_METADATA_FIELDS[field]
        const key = metadataFieldKey(field)
        expect(getMetadataSearchField(key)).toBe(definition.search ? field : undefined)
        if (definition.rule) expect(compileConditionToSql(field, 'isNotEmpty').sql).not.toBe('1=1')
        if (metadataSuggestionLookup(field)) {
          expect(getMetadataValueField(key)).toBe(field)
          expect(await getAutocompleteValues(key)).toEqual([])
        }
      }

      ctx.seedItems([{ id: 'film', name: 'Fixture.mkv' }])
      saveProviderMatch('film', 'tmdb', { id: 1, type: 'movie' }, {
        title: 'Fixture', originalTitle: null, overview: null, releaseDate: null, year: 2024,
        runtime: null, genres: ['Drama'], artwork: {},
        metadata: { studios: ['Fixture Studio'], imdbId: 'tt123' }
      })
      upsertMetadata('film', { year: 2024, genres: ['Drama'], tags: { collection: 'Fixture Collection' } })
      ctx.db.exec(`
        INSERT INTO local_media (location_id, failures) VALUES ('location:film', 0);
        INSERT INTO local_media_tracks
          (location_id, stream_index, kind, language, is_default, forced, hearing_impaired)
        VALUES ('location:film', 1, 'audio', 'jpn', 1, 0, 0);
      `)
      expect(await getAutocompleteValues('genre', 'dr')).toEqual(['Drama'])
      expect(await getAutocompleteValues('year', '202')).toEqual(['2024'])
      expect(await getAutocompleteValues('tmdb.studios', 'studio')).toEqual(['Fixture Studio'])
      expect(await getAutocompleteValues('file.audioLanguage', '')).toEqual(['jpn'])
      expect(await getAutocompleteValues('tmdb.imdbId', 'tt')).toEqual([])
      expect(await getAutocompleteValues('collection', 'fixture')).toEqual(['Fixture Collection'])
    } finally {
      invalidateCache()
      ctx.cleanup()
    }
  })

})
