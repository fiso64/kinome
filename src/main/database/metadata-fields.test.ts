import { describe, expect, it } from 'bun:test'
import { ENTITY_SCALAR_METADATA_FIELDS, ENTITY_SCALAR_METADATA_KEYS } from '@shared/metadata-fields'
import { METADATA_KEYS } from '@shared/types'
import { SCHEMA_SQL } from './schema'
import { REPOSITORY_SCHEMA } from './repo-definitions'

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
})
