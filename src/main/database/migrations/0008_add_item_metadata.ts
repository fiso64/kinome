import { ENTITY_SCALAR_METADATA_FIELDS } from '@shared/metadata-fields'
import { EFFECTIVE_METADATA_VIEW_SQL, ITEM_METADATA_TABLE_SQL, ITEM_METADATA_TRIGGER_SQL } from '../item-metadata.sql'
import { columnExists, tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 8,
  name: 'move effective metadata to library items',
  up(db) {
    db.exec(ITEM_METADATA_TABLE_SQL)
    if (!tableExists(db, 'media_entities')) return

    const columns = ENTITY_SCALAR_METADATA_FIELDS
      .map(({ column }) => column)
      .filter((column) => columnExists(db, 'media_entities', column))
    db.exec(`
      INSERT OR IGNORE INTO media_item_metadata (item_id, ${columns.join(', ')})
      SELECT i.id, ${columns.map((column) => `e.${column}`).join(', ')}
      FROM media_items i JOIN media_entities e ON e.id = i.entity_id;
    `)
    db.exec(`
      DROP TRIGGER IF EXISTS media_items_entities_media_kind_ai;
      DROP TRIGGER IF EXISTS media_items_entities_media_kind_au;
      DROP TRIGGER IF EXISTS media_items_fts_ai;
      DROP TRIGGER IF EXISTS media_items_fts_au;
      DROP TRIGGER IF EXISTS media_items_fts_entities_ai;
      DROP TRIGGER IF EXISTS media_items_fts_entities_au;
      DROP TRIGGER IF EXISTS media_items_fts_entities_ad;
    `)
    db.exec(EFFECTIVE_METADATA_VIEW_SQL)
    db.exec(ITEM_METADATA_TRIGGER_SQL)
  }
}
