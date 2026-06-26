import { columnExists, tableExists } from './sqlite-helpers'
import type { Migration } from './types'
import { MEDIA_ITEMS_READ_MODEL_SQL } from '../media-read-model.sql'

function createMediaItemsTable(db: import('bun:sqlite').Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      parent_item_id TEXT REFERENCES media_items(id) ON DELETE CASCADE,
      physical_kind TEXT NOT NULL CHECK(physical_kind IN ('file', 'folder', 'virtual')),
      media_kind TEXT,
      name TEXT NOT NULL,
      entity_id TEXT,

      is_virtual INTEGER NOT NULL DEFAULT 0,
      virtual_type TEXT CHECK(virtual_type IN ('user', 'grouping', 'season', 'home')),
      filter_json TEXT,
      owner_id TEXT,

      is_hidden INTEGER NOT NULL DEFAULT 0,
      logical_missing INTEGER NOT NULL DEFAULT 0,
      preferred_location_id TEXT,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,

      FOREIGN KEY(parent_item_id) REFERENCES media_items(id) ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY(entity_id) REFERENCES media_entities(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_items_parent_item_id ON media_items(parent_item_id);
    CREATE INDEX IF NOT EXISTS idx_media_items_entity_id ON media_items(entity_id);
    CREATE INDEX IF NOT EXISTS idx_media_items_is_virtual ON media_items(is_virtual);
    CREATE INDEX IF NOT EXISTS idx_media_items_virtual_type ON media_items(virtual_type);
    CREATE INDEX IF NOT EXISTS idx_media_items_physical_kind ON media_items(physical_kind);
    CREATE INDEX IF NOT EXISTS idx_media_items_media_kind ON media_items(media_kind);
  `)
}

function createMediaLocationsTable(db: import('bun:sqlite').Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_locations (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('file', 'folder')),

      size INTEGER,
      mtime INTEGER,
      birthtime INTEGER,
      inode INTEGER,
      device_id INTEGER,
      location_fingerprint TEXT,

      is_present INTEGER NOT NULL DEFAULT 1,
      is_ignored INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      is_shadowed INTEGER NOT NULL DEFAULT 0,
      shadowed_by_location_id TEXT REFERENCES media_locations(id) ON DELETE SET NULL,

      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      missing_since INTEGER,

      UNIQUE(source_id, relative_path),
      FOREIGN KEY(item_id) REFERENCES media_items(id) ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_locations_item_id ON media_locations(item_id);
    CREATE INDEX IF NOT EXISTS idx_media_locations_source_path ON media_locations(source_id, relative_path);
    CREATE INDEX IF NOT EXISTS idx_media_locations_presence ON media_locations(is_present);
    CREATE INDEX IF NOT EXISTS idx_media_locations_shadowed ON media_locations(is_shadowed);
  `)
}

function createCompatibilityTriggers(db: import('bun:sqlite').Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS media_items_legacy_items_ai AFTER INSERT ON items
    BEGIN
      INSERT INTO media_items (
        id, parent_item_id, physical_kind, media_kind, name, entity_id,
        is_virtual, virtual_type, filter_json, owner_id,
        is_hidden, logical_missing, preferred_location_id, created_at, updated_at
      )
      VALUES (
        new.id,
        new.parent_id,
        CASE WHEN COALESCE(new.is_virtual, 0) = 1 THEN 'virtual' ELSE new.type END,
        (SELECT media_type FROM media_entities WHERE id = new.entity_id),
        new.name,
        new.entity_id,
        COALESCE(new.is_virtual, 0),
        new.virtual_type,
        new.filter_json,
        new.owner_id,
        COALESCE(new.is_hidden, 0),
        COALESCE(new.is_missing, 0),
        NULL,
        COALESCE(new.added_at, cast(strftime('%s','now') as int) * 1000),
        cast(strftime('%s','now') as int) * 1000
      )
      ON CONFLICT(id) DO UPDATE SET
        parent_item_id = excluded.parent_item_id,
        physical_kind = excluded.physical_kind,
        media_kind = excluded.media_kind,
        name = excluded.name,
        entity_id = excluded.entity_id,
        is_virtual = excluded.is_virtual,
        virtual_type = excluded.virtual_type,
        filter_json = excluded.filter_json,
        owner_id = excluded.owner_id,
        is_hidden = excluded.is_hidden,
        logical_missing = excluded.logical_missing,
        updated_at = excluded.updated_at;

      INSERT INTO media_locations (
        id, item_id, source_id, relative_path, name, type,
        size, mtime, birthtime, inode, device_id, location_fingerprint,
        is_present, is_ignored, is_hidden, is_shadowed, shadowed_by_location_id,
        first_seen_at, last_seen_at, missing_since
      )
      SELECT
        'location:' || new.id,
        new.id,
        new.source_id,
        new.path,
        new.name,
        new.type,
        new.size,
        new.mtime,
        new.birthtime,
        new.inode,
        new.device_id,
        NULL,
        CASE WHEN COALESCE(new.is_missing, 0) = 1 THEN 0 ELSE 1 END,
        COALESCE(new.is_ignored, 0),
        COALESCE(new.is_hidden, 0),
        0,
        NULL,
        COALESCE(new.added_at, cast(strftime('%s','now') as int) * 1000),
        cast(strftime('%s','now') as int) * 1000,
        CASE WHEN COALESCE(new.is_missing, 0) = 1 THEN cast(strftime('%s','now') as int) * 1000 ELSE NULL END
      WHERE COALESCE(new.is_virtual, 0) = 0
        AND new.source_id IS NOT NULL
      ON CONFLICT(source_id, relative_path) DO UPDATE SET
        item_id = excluded.item_id,
        name = excluded.name,
        type = excluded.type,
        size = excluded.size,
        mtime = excluded.mtime,
        birthtime = excluded.birthtime,
        inode = excluded.inode,
        device_id = excluded.device_id,
        is_present = excluded.is_present,
        is_ignored = excluded.is_ignored,
        is_hidden = excluded.is_hidden,
        last_seen_at = excluded.last_seen_at,
        missing_since = excluded.missing_since;
    END;

    CREATE TRIGGER IF NOT EXISTS media_items_legacy_items_au AFTER UPDATE ON items
    BEGIN
      UPDATE media_items
      SET id = new.id,
          parent_item_id = new.parent_id,
          physical_kind = CASE WHEN COALESCE(new.is_virtual, 0) = 1 THEN 'virtual' ELSE new.type END,
          media_kind = (SELECT media_type FROM media_entities WHERE id = new.entity_id),
          name = new.name,
          entity_id = new.entity_id,
          is_virtual = COALESCE(new.is_virtual, 0),
          virtual_type = new.virtual_type,
          filter_json = new.filter_json,
          owner_id = new.owner_id,
          is_hidden = COALESCE(new.is_hidden, 0),
          logical_missing = COALESCE(new.is_missing, 0),
          created_at = COALESCE(new.added_at, created_at),
          updated_at = cast(strftime('%s','now') as int) * 1000
      WHERE id = old.id;

      DELETE FROM media_locations
      WHERE item_id IN (old.id, new.id)
         OR (
           COALESCE(new.is_virtual, 0) = 0
           AND new.source_id IS NOT NULL
           AND source_id = new.source_id
           AND relative_path = new.path
         );

      INSERT INTO media_locations (
        id, item_id, source_id, relative_path, name, type,
        size, mtime, birthtime, inode, device_id, location_fingerprint,
        is_present, is_ignored, is_hidden, is_shadowed, shadowed_by_location_id,
        first_seen_at, last_seen_at, missing_since
      )
      SELECT
        'location:' || new.id,
        new.id,
        new.source_id,
        new.path,
        new.name,
        new.type,
        new.size,
        new.mtime,
        new.birthtime,
        new.inode,
        new.device_id,
        NULL,
        CASE WHEN COALESCE(new.is_missing, 0) = 1 THEN 0 ELSE 1 END,
        COALESCE(new.is_ignored, 0),
        COALESCE(new.is_hidden, 0),
        0,
        NULL,
        COALESCE(new.added_at, cast(strftime('%s','now') as int) * 1000),
        cast(strftime('%s','now') as int) * 1000,
        CASE WHEN COALESCE(new.is_missing, 0) = 1 THEN cast(strftime('%s','now') as int) * 1000 ELSE NULL END
      WHERE COALESCE(new.is_virtual, 0) = 0
        AND new.source_id IS NOT NULL;
    END;

    CREATE TRIGGER IF NOT EXISTS media_items_legacy_items_ad AFTER DELETE ON items
    BEGIN
      DELETE FROM media_items WHERE id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS media_items_legacy_entities_ai AFTER INSERT ON media_entities
    BEGIN
      UPDATE media_items SET media_kind = new.media_type WHERE entity_id = new.id;
    END;

    CREATE TRIGGER IF NOT EXISTS media_items_legacy_entities_au AFTER UPDATE OF media_type ON media_entities
    BEGIN
      UPDATE media_items SET media_kind = new.media_type WHERE entity_id = new.id;
    END;
  `)
}

function createMediaItemsReadModel(db: import('bun:sqlite').Database): void {
  db.exec(`
    DROP VIEW IF EXISTS media_items_read;
    ${MEDIA_ITEMS_READ_MODEL_SQL};
  `)
}

export const migration: Migration = {
  version: 2,
  name: 'add media_items, media_locations, and media-backed read model',
  up: (db) => {
    createMediaItemsTable(db)
    createMediaLocationsTable(db)
    createMediaItemsReadModel(db)

    if (!tableExists(db, 'items')) return

    const now = Date.now()
    const ownerColumn = columnExists(db, 'items', 'owner_id') ? 'i.owner_id' : 'NULL'
    const mediaKindJoin = tableExists(db, 'media_entities')
      ? 'LEFT JOIN media_entities e ON i.entity_id = e.id'
      : ''
    const mediaKindColumn = tableExists(db, 'media_entities') ? 'e.media_type' : 'NULL'

    db.prepare(`
      INSERT OR IGNORE INTO media_items (
        id,
        parent_item_id,
        physical_kind,
        media_kind,
        name,
        entity_id,
        is_virtual,
        virtual_type,
        filter_json,
        owner_id,
        is_hidden,
        logical_missing,
        preferred_location_id,
        created_at,
        updated_at
      )
      SELECT
        i.id,
        i.parent_id,
        CASE WHEN COALESCE(i.is_virtual, 0) = 1 THEN 'virtual' ELSE i.type END,
        ${mediaKindColumn},
        i.name,
        i.entity_id,
        COALESCE(i.is_virtual, 0),
        i.virtual_type,
        i.filter_json,
        ${ownerColumn},
        COALESCE(i.is_hidden, 0),
        COALESCE(i.is_missing, 0),
        NULL,
        COALESCE(i.added_at, ?),
        ?
      FROM items i
      ${mediaKindJoin}
    `).run(now, now)

    db.prepare(`
      INSERT OR IGNORE INTO media_locations (
        id,
        item_id,
        source_id,
        relative_path,
        name,
        type,
        size,
        mtime,
        birthtime,
        inode,
        device_id,
        location_fingerprint,
        is_present,
        is_ignored,
        is_hidden,
        is_shadowed,
        shadowed_by_location_id,
        first_seen_at,
        last_seen_at,
        missing_since
      )
      SELECT
        'location:' || i.id,
        i.id,
        i.source_id,
        i.path,
        i.name,
        i.type,
        i.size,
        i.mtime,
        i.birthtime,
        i.inode,
        i.device_id,
        NULL,
        CASE WHEN COALESCE(i.is_missing, 0) = 1 THEN 0 ELSE 1 END,
        COALESCE(i.is_ignored, 0),
        COALESCE(i.is_hidden, 0),
        0,
        NULL,
        COALESCE(i.added_at, ?),
        ?,
        CASE WHEN COALESCE(i.is_missing, 0) = 1 THEN ? ELSE NULL END
      FROM items i
      WHERE COALESCE(i.is_virtual, 0) = 0
        AND i.source_id IS NOT NULL
    `).run(now, now, now)

    createCompatibilityTriggers(db)
  }
}
