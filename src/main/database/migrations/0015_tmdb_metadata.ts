import { EFFECTIVE_METADATA, EFFECTIVE_METADATA_VIEW_SQL, TMDB_COLUMNS, TMDB_RELATIONS_SQL } from '../item-metadata.sql'
import { columnExists, tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 15,
  name: 'store supplemental TMDB metadata with provider entities',
  up(db) {
    if (!tableExists(db, 'media_entities')) return
    for (const [column, type] of TMDB_COLUMNS) {
      if (!columnExists(db, 'media_entities', column)) {
        db.exec(`ALTER TABLE media_entities ADD COLUMN ${column} ${type}`)
      }
    }
    if (tableExists(db, 'media_item_metadata') && !columnExists(db, 'media_item_metadata', 'file_change_revision')) {
      db.exec('ALTER TABLE media_item_metadata ADD COLUMN file_change_revision TEXT')
    }
    db.exec(TMDB_RELATIONS_SQL)
    for (const column of ['tmdb_imdb_id', 'tmdb_rating', 'tmdb_status', 'tmdb_content_rating', 'tmdb_original_language']) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_${column} ON media_entities(${column}) WHERE ${column} IS NOT NULL`)
    }
    db.exec(`DROP VIEW IF EXISTS ${EFFECTIVE_METADATA}`)
    db.exec(EFFECTIVE_METADATA_VIEW_SQL(true))
  }
}
