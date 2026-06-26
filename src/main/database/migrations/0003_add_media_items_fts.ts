import { columnExists, tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 3,
  name: 'add media_items_fts search index',
  up: (db) => {
    if (tableExists(db, 'media_entities')) {
      if (!columnExists(db, 'media_entities', 'original_title')) {
        db.exec('ALTER TABLE media_entities ADD COLUMN original_title TEXT')
      }
      if (!columnExists(db, 'media_entities', 'overview')) {
        db.exec('ALTER TABLE media_entities ADD COLUMN overview TEXT')
      }
    }

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS media_items_fts USING fts5(
        id UNINDEXED,
        title,
        original_title,
        name,
        overview,
        tokenize = 'trigram'
      );

      DELETE FROM media_items_fts;

      INSERT INTO media_items_fts (id, name, title, original_title, overview)
      SELECT
        mi.id,
        mi.name,
        e.title,
        e.original_title,
        e.overview
      FROM media_items mi
      LEFT JOIN media_entities e ON mi.entity_id = e.id;

      CREATE TRIGGER IF NOT EXISTS media_items_fts_ai AFTER INSERT ON media_items BEGIN
        INSERT INTO media_items_fts (id, name, title, original_title, overview)
        VALUES (
          new.id,
          new.name,
          (SELECT title FROM media_entities WHERE id = new.entity_id),
          (SELECT original_title FROM media_entities WHERE id = new.entity_id),
          (SELECT overview FROM media_entities WHERE id = new.entity_id)
        );
      END;

      CREATE TRIGGER IF NOT EXISTS media_items_fts_ad AFTER DELETE ON media_items BEGIN
        DELETE FROM media_items_fts WHERE id = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS media_items_fts_au AFTER UPDATE OF name, entity_id ON media_items
      FOR EACH ROW
      WHEN (OLD.name IS NOT NEW.name OR OLD.entity_id IS NOT NEW.entity_id)
      BEGIN
        UPDATE media_items_fts SET
          name = new.name,
          title = (SELECT title FROM media_entities WHERE id = new.entity_id),
          original_title = (SELECT original_title FROM media_entities WHERE id = new.entity_id),
          overview = (SELECT overview FROM media_entities WHERE id = new.entity_id)
        WHERE id = new.id;
      END;

      CREATE TRIGGER IF NOT EXISTS media_items_fts_entities_ai AFTER INSERT ON media_entities BEGIN
        UPDATE media_items_fts SET
          title = new.title,
          original_title = new.original_title,
          overview = new.overview
        WHERE id IN (SELECT id FROM media_items WHERE entity_id = new.id);
      END;

      CREATE TRIGGER IF NOT EXISTS media_items_fts_entities_au AFTER UPDATE OF title, original_title, overview ON media_entities
      FOR EACH ROW
      WHEN (
        OLD.title IS NOT NEW.title OR
        OLD.original_title IS NOT NEW.original_title OR
        OLD.overview IS NOT NEW.overview
      )
      BEGIN
        UPDATE media_items_fts SET
          title = new.title,
          original_title = new.original_title,
          overview = new.overview
        WHERE id IN (SELECT id FROM media_items WHERE entity_id = new.id);
      END;

      CREATE TRIGGER IF NOT EXISTS media_items_fts_entities_ad AFTER DELETE ON media_entities BEGIN
        UPDATE media_items_fts SET title = NULL, original_title = NULL, overview = NULL
        WHERE id IN (SELECT id FROM media_items WHERE entity_id = old.id);
      END;
    `)
  }
}
