import { columnExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 26,
  name: 'lock the type of manually matched items',
  up(db) {
    // A manual match used to lock only the TMDB ID. Its type is part of the same choice.
    for (const table of ['media_entities', 'media_item_metadata']) {
      if (!columnExists(db, table, 'locked_fields_json')) continue
      db.exec(`
        UPDATE ${table}
        SET locked_fields_json = json_insert(locked_fields_json, '$[#]', 'mediaType')
        WHERE media_type IS NOT NULL AND tmdb_id IS NOT NULL AND json_valid(locked_fields_json)
          AND EXISTS (SELECT 1 FROM json_each(locked_fields_json) WHERE value = 'tmdbId')
          AND NOT EXISTS (SELECT 1 FROM json_each(locked_fields_json) WHERE value = 'mediaType')
      `)
    }
  }
}
