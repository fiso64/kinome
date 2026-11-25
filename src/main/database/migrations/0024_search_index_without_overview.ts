import {
  FTS_TABLE, ITEM_METADATA_TRIGGER_SQL, REBUILD_SEARCH_INDEX_SQL, SEARCH_INDEX_SQL
} from '../item-metadata.sql'
import { tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 24,
  name: 'drop overview from the full-text index',
  up(db) {
    if (!tableExists(db, 'media_items') || !tableExists(db, FTS_TABLE)) return
    db.exec(`
      DROP TRIGGER IF EXISTS media_items_fts_ai;
      DROP TRIGGER IF EXISTS media_items_fts_ad;
      DROP TRIGGER IF EXISTS media_items_fts_au;
      DROP TRIGGER IF EXISTS media_items_fts_entities_ai;
      DROP TRIGGER IF EXISTS media_items_fts_entities_au;
      DROP TRIGGER IF EXISTS media_items_fts_entities_ad;
      DROP TRIGGER IF EXISTS media_item_metadata_ai;
      DROP TRIGGER IF EXISTS media_item_metadata_au;
      DROP TABLE ${FTS_TABLE};
    `)
    db.exec(SEARCH_INDEX_SQL)
    db.exec(ITEM_METADATA_TRIGGER_SQL)
    db.exec(REBUILD_SEARCH_INDEX_SQL)
  }
}
