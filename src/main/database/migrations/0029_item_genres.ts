import { ITEM_GENRES_SQL } from '../item-metadata.sql'
import { tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 29,
  name: 'mirror item genre overrides into a relational table',
  up(db) {
    if (!tableExists(db, 'media_item_metadata')) return
    db.exec(ITEM_GENRES_SQL)
    db.exec(`
      INSERT OR IGNORE INTO item_genres (item_id, name)
      SELECT m.item_id, entry.value FROM media_item_metadata m, json_each(m.genres_json) entry
      WHERE m.genres_json IS NOT NULL AND entry.value IS NOT NULL
    `)
  }
}
