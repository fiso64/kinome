import type { Migration } from './types'

export const migration: Migration = {
  version: 6,
  name: 'drop legacy items_fts search index',
  up: (db) => {
    db.exec(`
      DROP TRIGGER IF EXISTS items_ai;
      DROP TRIGGER IF EXISTS items_ad;
      DROP TRIGGER IF EXISTS items_au;
      DROP TRIGGER IF EXISTS media_entities_ai;
      DROP TRIGGER IF EXISTS media_entities_au;
      DROP TRIGGER IF EXISTS media_entities_ad;
      DROP TABLE IF EXISTS items_fts;
    `)
  }
}
