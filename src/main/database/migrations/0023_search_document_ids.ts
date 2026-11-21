import {
  EFFECTIVE_SUGGESTION_COLUMNS, effectiveSuggestionIndexSql, FTS_TABLE, ITEM_METADATA_TRIGGER_SQL,
  REBUILD_SEARCH_INDEX_SQL, SEARCH_DOCUMENT_INDEX_SQL
} from '../item-metadata.sql'
import { MEDIA_ITEMS_READ_MODEL_SQL } from '../media-read-model.sql'
import { columnExists, tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 23,
  name: 'index full-text document IDs and metadata suggestions',
  up(db) {
    if (!tableExists(db, 'media_items') || !tableExists(db, FTS_TABLE)) return
    if (!columnExists(db, 'media_items', 'search_document_id')) {
      db.exec('ALTER TABLE media_items ADD COLUMN search_document_id INTEGER')
    }
    db.exec(SEARCH_DOCUMENT_INDEX_SQL)
    for (const column of EFFECTIVE_SUGGESTION_COLUMNS) {
      if (columnExists(db, 'media_entities', column)) db.exec(effectiveSuggestionIndexSql(column))
    }
    db.exec('DROP VIEW IF EXISTS media_items_read')
    db.exec(MEDIA_ITEMS_READ_MODEL_SQL)
    db.exec(`
      DROP TRIGGER IF EXISTS media_items_fts_ai;
      DROP TRIGGER IF EXISTS media_items_fts_ad;
      DROP TRIGGER IF EXISTS media_items_fts_au;
      DROP TRIGGER IF EXISTS media_items_fts_entities_ai;
      DROP TRIGGER IF EXISTS media_items_fts_entities_au;
      DROP TRIGGER IF EXISTS media_items_fts_entities_ad;
      DROP TRIGGER IF EXISTS media_item_metadata_ai;
      DROP TRIGGER IF EXISTS media_item_metadata_au;
    `)
    db.exec(ITEM_METADATA_TRIGGER_SQL)
    db.exec(REBUILD_SEARCH_INDEX_SQL)
  }
}
