import type { Migration } from './types'

export const migration: Migration = {
  version: 7,
  name: 'drop legacy items table and mirror triggers',
  up: (db) => {
    db.exec(`
      DROP TRIGGER IF EXISTS media_items_legacy_items_ai;
      DROP TRIGGER IF EXISTS media_items_legacy_items_au;
      DROP TRIGGER IF EXISTS media_items_legacy_items_ad;
      DROP TRIGGER IF EXISTS media_items_legacy_entities_ai;
      DROP TRIGGER IF EXISTS media_items_legacy_entities_au;

      CREATE TRIGGER IF NOT EXISTS media_items_entities_media_kind_ai AFTER INSERT ON media_entities
      BEGIN
        UPDATE media_items SET media_kind = new.media_type WHERE entity_id = new.id;
      END;

      CREATE TRIGGER IF NOT EXISTS media_items_entities_media_kind_au AFTER UPDATE OF media_type ON media_entities
      BEGIN
        UPDATE media_items SET media_kind = new.media_type WHERE entity_id = new.id;
      END;

      DROP TABLE IF EXISTS items;
    `)
  }
}
