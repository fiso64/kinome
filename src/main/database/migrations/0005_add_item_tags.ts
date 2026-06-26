import type { Migration } from './types'
import { tableExists } from './sqlite-helpers'

function createItemTagTables(db: import('bun:sqlite').Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS item_tags (
      item_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (item_id, key),
      FOREIGN KEY (item_id) REFERENCES media_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS item_virtual_tags (
      item_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (item_id, key),
      FOREIGN KEY (item_id) REFERENCES media_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_item_tags_item_id ON item_tags(item_id);
    CREATE INDEX IF NOT EXISTS idx_item_virtual_tags_item_id ON item_virtual_tags(item_id);
  `)
}

function backfillItemTags(db: import('bun:sqlite').Database): void {
  if (tableExists(db, 'entity_tags')) {
    db.exec(`
      INSERT OR REPLACE INTO item_tags (item_id, key, value)
      SELECT i.id, t.key, t.value
      FROM media_items i
      JOIN entity_tags t ON t.entity_id = i.entity_id;
    `)
  }

  if (tableExists(db, 'entity_virtual_tags')) {
    db.exec(`
      INSERT OR REPLACE INTO item_virtual_tags (item_id, key, value)
      SELECT i.id, vt.key, vt.value
      FROM media_items i
      JOIN entity_virtual_tags vt ON vt.entity_id = i.entity_id;
    `)
  }
}

export const migration: Migration = {
  version: 5,
  name: 'add item-bound tags and virtual tags',
  up: (db) => {
    createItemTagTables(db)
    backfillItemTags(db)
  }
}
