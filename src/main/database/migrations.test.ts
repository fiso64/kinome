import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createPreMigrationBackup } from './backup'
import { DATABASE_MIGRATIONS, LATEST_SCHEMA_VERSION, runMigrations } from './migrations'
import { SCHEMA_SQL } from './schema'

function getColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name)
}

function getViewNames(db: Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all() as { name: string }[]).map(
    (row) => row.name
  )
}

function getTableNames(db: Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
    (row) => row.name
  )
}

function getUserVersion(db: Database): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function getForeignKeyTargets(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string }[]).map((row) => row.table)
}

function getForeignKeyViolations(db: Database): any[] {
  return db.prepare('PRAGMA foreign_key_check').all()
}

describe('database migrations', () => {
  it('keeps migrations uniquely versioned and ordered', () => {
    const versions = DATABASE_MIGRATIONS.map((migration) => migration.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('renames existing runtime column to tmdb_runtime and preserves data', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE media_entities (
        id TEXT PRIMARY KEY,
        title TEXT,
        runtime INTEGER
      );
      INSERT INTO media_entities (id, title, runtime) VALUES ('movie-1', 'Perfect Blue', 82);
    `)

    runMigrations(db)

    const columns = getColumns(db, 'media_entities')
    expect(columns).not.toContain('runtime')
    expect(columns).toContain('tmdb_runtime')

    const row = db
      .prepare('SELECT tmdb_runtime FROM media_entities WHERE id = ?')
      .get('movie-1') as { tmdb_runtime: number }
    expect(row.tmdb_runtime).toBe(82)
    expect(getUserVersion(db)).toBe(LATEST_SCHEMA_VERSION)

    db.close()
  })

  it('marks a freshly-created canonical schema as current', () => {
    const db = new Database(':memory:')
    db.exec(SCHEMA_SQL)

    runMigrations(db)

    const columns = getColumns(db, 'media_entities')
    expect(columns).toContain('tmdb_runtime')
    expect(columns).not.toContain('runtime')
    expect(getColumns(db, 'media_items')).toContain('physical_kind')
    expect(getColumns(db, 'media_locations')).toContain('relative_path')
    expect(getTableNames(db)).toContain('media_items_fts')
    expect(getTableNames(db)).not.toContain('items_fts')
    expect(getViewNames(db)).toContain('media_items_read')
    expect(getForeignKeyTargets(db, 'user_state')).toContain('media_items')
    expect(getForeignKeyTargets(db, 'folder_settings')).toContain('media_items')
    expect(getForeignKeyTargets(db, 'account_visible_items')).toContain('media_items')
    expect(getUserVersion(db)).toBe(LATEST_SCHEMA_VERSION)

    db.close()
  })

  it('migrates legacy items into media_items and media_locations', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    db.exec(`
      CREATE TABLE media_entities (
        id TEXT PRIMARY KEY,
        tmdb_id INTEGER,
        media_type TEXT,
        title TEXT,
        tmdb_runtime INTEGER
      );

      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('file', 'folder')),
        source_id TEXT,
        size INTEGER,
        mtime INTEGER,
        birthtime INTEGER,
        inode INTEGER,
        device_id INTEGER,
        entity_id TEXT,
        is_hidden INTEGER DEFAULT 0,
        is_ignored INTEGER DEFAULT 0,
        is_missing INTEGER DEFAULT 0,
        is_virtual INTEGER DEFAULT 0,
        virtual_type TEXT,
        filter_json TEXT,
        owner_id TEXT,
        added_at INTEGER
      );

      INSERT INTO media_entities (id, tmdb_id, media_type, title)
      VALUES ('entity-show', 1396, 'tv', 'Breaking Bad');

      INSERT INTO items (id, parent_id, path, name, type, source_id, entity_id, is_virtual, virtual_type, added_at)
      VALUES ('root', NULL, 'virtual://root', 'Library', 'folder', NULL, NULL, 1, 'home', 1000);

      INSERT INTO items (id, parent_id, path, name, type, source_id, added_at)
      VALUES ('source-root', 'root', '.', 'Shows', 'folder', 'source-a', 1100);

      INSERT INTO items (id, parent_id, path, name, type, source_id, entity_id, size, mtime, birthtime, inode, device_id, is_hidden, is_ignored, is_missing, added_at)
      VALUES ('show-item', 'source-root', 'Breaking Bad', 'Breaking Bad', 'folder', 'source-a', 'entity-show', 4096, 1200, 900, 7, 3, 1, 0, 0, 1200);

      INSERT INTO items (id, parent_id, path, name, type, source_id, size, mtime, birthtime, inode, device_id, is_hidden, is_ignored, is_missing, added_at)
      VALUES ('missing-file', 'show-item', 'Breaking Bad/S01E01.mkv', 'S01E01.mkv', 'file', 'source-a', 123, 1300, 950, 8, 3, 0, 1, 1, 1300);

      INSERT INTO items (id, parent_id, path, name, type, source_id, is_virtual, virtual_type, filter_json, owner_id, added_at)
      VALUES ('virtual-season', 'show-item', 'virtual://season-1', 'Season 1', 'folder', NULL, 1, 'season', '{"scope":{"parentId":"show-item"}}', 'account-1', 1400);
    `)

    runMigrations(db)

    const showItem = db.prepare('SELECT * FROM media_items WHERE id = ?').get('show-item') as any
    expect(showItem.parent_item_id).toBe('source-root')
    expect(showItem.physical_kind).toBe('folder')
    expect(showItem.media_kind).toBe('tv')
    expect(showItem.entity_id).toBe('entity-show')
    expect(showItem.is_hidden).toBe(1)
    expect(showItem.logical_missing).toBe(0)
    expect(showItem.created_at).toBe(1200)

    const virtualSeason = db.prepare('SELECT * FROM media_items WHERE id = ?').get('virtual-season') as any
    expect(virtualSeason.physical_kind).toBe('virtual')
    expect(virtualSeason.virtual_type).toBe('season')
    expect(virtualSeason.filter_json).toContain('show-item')
    expect(virtualSeason.owner_id).toBe('account-1')

    const showLocation = db.prepare('SELECT * FROM media_locations WHERE item_id = ?').get('show-item') as any
    expect(showLocation.id).toBe('location:show-item')
    expect(showLocation.source_id).toBe('source-a')
    expect(showLocation.relative_path).toBe('Breaking Bad')
    expect(showLocation.is_present).toBe(1)
    expect(showLocation.is_hidden).toBe(1)

    const missingLocation = db.prepare('SELECT * FROM media_locations WHERE item_id = ?').get('missing-file') as any
    expect(missingLocation.is_present).toBe(0)
    expect(missingLocation.is_ignored).toBe(1)
    expect(missingLocation.missing_since).not.toBeNull()

    const virtualLocation = db
      .prepare('SELECT * FROM media_locations WHERE item_id = ?')
      .get('virtual-season')
    expect(virtualLocation).toBeNull()

    const showRead = db.prepare('SELECT * FROM media_items_read WHERE id = ?').get('show-item') as any
    expect(showRead.parent_id).toBe('source-root')
    expect(showRead.path).toBe('Breaking Bad')
    expect(showRead.source_id).toBe('source-a')
    expect(showRead.type).toBe('folder')
    expect(showRead.entity_id).toBe('entity-show')
    expect(showRead.is_hidden).toBe(1)
    expect(showRead.is_missing).toBe(0)
    expect(showRead.selected_location_id).toBe('location:show-item')

    const missingRead = db.prepare('SELECT * FROM media_items_read WHERE id = ?').get('missing-file') as any
    expect(missingRead.is_missing).toBe(1)
    expect(missingRead.is_ignored).toBe(1)
    expect(missingRead.location_is_present).toBe(0)

    const virtualRead = db.prepare('SELECT * FROM media_items_read WHERE id = ?').get('virtual-season') as any
    expect(virtualRead.path).toBe('virtual://virtual-season')
    expect(virtualRead.type).toBe('folder')
    expect(virtualRead.source_id).toBeNull()

    const ftsRow = db.prepare('SELECT id, name, title FROM media_items_fts WHERE id = ?').get('show-item') as any
    expect(ftsRow.name).toBe('Breaking Bad')
    expect(ftsRow.title).toBe('Breaking Bad')
    expect(getTableNames(db)).not.toContain('items')
    expect(getTableNames(db)).not.toContain('items_fts')
    expect(getUserVersion(db)).toBe(LATEST_SCHEMA_VERSION)

    db.close()
  })

  it('drops the legacy items table after migrating its data', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    db.exec(`
      CREATE TABLE media_entities (
        id TEXT PRIMARY KEY,
        tmdb_id INTEGER,
        media_type TEXT,
        title TEXT,
        tmdb_runtime INTEGER
      );

      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('file', 'folder')),
        source_id TEXT,
        size INTEGER,
        mtime INTEGER,
        birthtime INTEGER,
        inode INTEGER,
        device_id INTEGER,
        entity_id TEXT,
        is_hidden INTEGER DEFAULT 0,
        is_ignored INTEGER DEFAULT 0,
        is_missing INTEGER DEFAULT 0,
        is_virtual INTEGER DEFAULT 0,
        virtual_type TEXT,
        filter_json TEXT,
        owner_id TEXT,
        added_at INTEGER
      );

      INSERT INTO media_entities (id, tmdb_id, media_type, title)
      VALUES ('entity-1', 603, 'movie', 'The Matrix');

      INSERT INTO items (id, parent_id, path, name, type, source_id, entity_id, size, mtime, birthtime, inode, device_id, added_at)
      VALUES ('movie-file', NULL, 'Movies/The Matrix.mkv', 'The Matrix.mkv', 'file', 'source-a', 'entity-1', 100, 200, 50, 9, 4, 1000);
    `)

    runMigrations(db)

    expect(getTableNames(db)).not.toContain('items')

    const item = db.prepare('SELECT * FROM media_items WHERE id = ?').get('movie-file') as any
    expect(item.name).toBe('The Matrix.mkv')
    expect(item.media_kind).toBe('movie')
    expect(item.physical_kind).toBe('file')

    const location = db.prepare('SELECT * FROM media_locations WHERE item_id = ?').get('movie-file') as any
    expect(location.relative_path).toBe('Movies/The Matrix.mkv')
    expect(location.is_present).toBe(1)

    const read = db.prepare('SELECT * FROM media_items_read WHERE id = ?').get('movie-file') as any
    expect(read.path).toBe('Movies/The Matrix.mkv')
    expect(read.is_missing).toBe(0)
    expect(read.is_ignored).toBe(0)

    db.prepare('UPDATE media_entities SET media_type = ? WHERE id = ?').run('tv', 'entity-1')
    const updatedKind = db.prepare('SELECT media_kind FROM media_items WHERE id = ?').get('movie-file') as any
    expect(updatedKind.media_kind).toBe('tv')

    db.close()
  })

  it('preserves dependent item state through the full legacy migration chain', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'normal',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE media_entities (
        id TEXT PRIMARY KEY,
        tmdb_id INTEGER,
        media_type TEXT,
        title TEXT,
        runtime INTEGER,
        poster_path TEXT,
        backdrop_path TEXT,
        logo_path TEXT,
        locked_fields_json TEXT,
        last_refreshed_at INTEGER,
        version INTEGER DEFAULT 0
      );

      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('file', 'folder')),
        source_id TEXT,
        size INTEGER,
        mtime INTEGER,
        birthtime INTEGER,
        inode INTEGER,
        device_id INTEGER,
        entity_id TEXT REFERENCES media_entities(id) ON DELETE SET NULL,
        is_hidden INTEGER DEFAULT 0,
        is_ignored INTEGER DEFAULT 0,
        is_missing INTEGER DEFAULT 0,
        is_virtual INTEGER DEFAULT 0,
        virtual_type TEXT,
        filter_json TEXT,
        owner_id TEXT,
        added_at INTEGER
      );

      CREATE TABLE user_state (
        item_id TEXT,
        user_id TEXT DEFAULT 'default',
        watched INTEGER DEFAULT 0,
        last_watched_at INTEGER,
        continue_watching_dismissed INTEGER DEFAULT 0,
        next_up_dismissed INTEGER DEFAULT 0,
        next_up_episode_id TEXT,
        PRIMARY KEY (item_id, user_id),
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE TABLE folder_settings (
        item_id TEXT PRIMARY KEY,
        view_settings_json TEXT,
        applied_grouping TEXT,
        retrieve_children_metadata INTEGER NOT NULL DEFAULT 0,
        children_type_hint TEXT,
        process_tv_children INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE TABLE account_visible_items (
        account_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        PRIMARY KEY (account_id, item_id),
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
      );

      CREATE TABLE entity_tags (
        entity_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (entity_id, key),
        FOREIGN KEY(entity_id) REFERENCES media_entities(id) ON DELETE CASCADE
      );

      CREATE TABLE entity_virtual_tags (
        entity_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (entity_id, key),
        FOREIGN KEY(entity_id) REFERENCES media_entities(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE items_fts USING fts5(
        id UNINDEXED,
        title,
        name,
        tokenize = 'trigram'
      );

      INSERT INTO accounts (id, username, password_hash, role, created_at)
      VALUES ('account-1', 'casey', 'hash', 'normal', 900);

      INSERT INTO media_entities (
        id, tmdb_id, media_type, title, runtime,
        poster_path, backdrop_path, logo_path,
        locked_fields_json, last_refreshed_at, version
      )
      VALUES (
        'entity-movie', 603, 'movie', 'The Matrix', 136,
        'poster.jpg', 'backdrop.jpg', 'logo.svg',
        '["title","poster_path"]', 7777, 2
      );

      INSERT INTO items (
        id, parent_id, path, name, type, source_id,
        entity_id, size, mtime, birthtime, inode, device_id, added_at
      )
      VALUES (
        'movie-folder', NULL, 'Movies/The Matrix', 'The Matrix', 'folder', 'source-a',
        NULL, 4096, 100, 50, 1, 7, 1000
      );

      INSERT INTO items (
        id, parent_id, path, name, type, source_id,
        entity_id, size, mtime, birthtime, inode, device_id, added_at
      )
      VALUES (
        'movie-file', 'movie-folder', 'Movies/The Matrix/The Matrix.mkv', 'The Matrix.mkv', 'file', 'source-a',
        'entity-movie', 123456, 110, 55, 2, 7, 1100
      );

      INSERT INTO items (
        id, parent_id, path, name, type, source_id,
        is_virtual, virtual_type, filter_json, owner_id, added_at
      )
      VALUES (
        'virtual-folder', NULL, 'virtual://favorites', 'Favorites', 'folder', NULL,
        1, 'user', '{"rules":[{"field":"tag","value":"favorite"}]}', 'account-1', 1200
      );

      INSERT INTO user_state (
        item_id, user_id, watched, last_watched_at,
        continue_watching_dismissed, next_up_dismissed, next_up_episode_id
      )
      VALUES ('movie-file', 'account-1', 1, 2222, 1, 0, 'next-episode');

      INSERT INTO folder_settings (
        item_id, view_settings_json, applied_grouping,
        retrieve_children_metadata, children_type_hint, process_tv_children
      )
      VALUES (
        'movie-folder',
        '{"sortBy":"title","layout":"grid"}',
        'genre',
        1,
        'movie',
        0
      );

      INSERT INTO account_visible_items (account_id, item_id)
      VALUES ('account-1', 'movie-folder'), ('account-1', 'movie-file'), ('account-1', 'virtual-folder');

      INSERT INTO entity_tags (entity_id, key, value)
      VALUES ('entity-movie', 'manual', 'favorite');

      INSERT INTO entity_virtual_tags (entity_id, key, value)
      VALUES ('entity-movie', 'collection', 'wachowskis');

      INSERT INTO items_fts (id, title, name)
      VALUES ('movie-file', 'stale old index title', 'stale old index name');
    `)

    runMigrations(db)

    expect(getUserVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    expect(getTableNames(db)).not.toContain('items')
    expect(getTableNames(db)).not.toContain('items_fts')
    expect(getForeignKeyViolations(db)).toHaveLength(0)
    expect(getForeignKeyTargets(db, 'user_state')).toContain('media_items')
    expect(getForeignKeyTargets(db, 'folder_settings')).toContain('media_items')
    expect(getForeignKeyTargets(db, 'account_visible_items')).toContain('media_items')

    const entity = db.prepare('SELECT * FROM media_entities WHERE id = ?').get('entity-movie') as any
    expect(entity.tmdb_runtime).toBe(136)
    expect(entity.poster_path).toBe('poster.jpg')
    expect(entity.backdrop_path).toBe('backdrop.jpg')
    expect(entity.logo_path).toBe('logo.svg')
    expect(entity.locked_fields_json).toBe('["title","poster_path"]')
    expect(entity.last_refreshed_at).toBe(7777)
    expect(entity.version).toBe(2)

    const fileItem = db.prepare('SELECT * FROM media_items WHERE id = ?').get('movie-file') as any
    expect(fileItem.parent_item_id).toBe('movie-folder')
    expect(fileItem.physical_kind).toBe('file')
    expect(fileItem.media_kind).toBe('movie')
    expect(fileItem.entity_id).toBe('entity-movie')

    const virtualItem = db.prepare('SELECT * FROM media_items WHERE id = ?').get('virtual-folder') as any
    expect(virtualItem.physical_kind).toBe('virtual')
    expect(virtualItem.virtual_type).toBe('user')
    expect(virtualItem.filter_json).toContain('favorite')
    expect(virtualItem.owner_id).toBe('account-1')

    const fileLocation = db.prepare('SELECT * FROM media_locations WHERE item_id = ?').get('movie-file') as any
    expect(fileLocation.id).toBe('location:movie-file')
    expect(fileLocation.source_id).toBe('source-a')
    expect(fileLocation.relative_path).toBe('Movies/The Matrix/The Matrix.mkv')
    expect(fileLocation.size).toBe(123456)
    expect(fileLocation.inode).toBe(2)
    expect(fileLocation.device_id).toBe(7)
    expect(fileLocation.is_present).toBe(1)

    const userState = db
      .prepare('SELECT * FROM user_state WHERE item_id = ? AND user_id = ?')
      .get('movie-file', 'account-1') as any
    expect(userState.watched).toBe(1)
    expect(userState.last_watched_at).toBe(2222)
    expect(userState.continue_watching_dismissed).toBe(1)
    expect(userState.next_up_dismissed).toBe(0)
    expect(userState.next_up_episode_id).toBe('next-episode')

    const folderSettings = db.prepare('SELECT * FROM folder_settings WHERE item_id = ?').get('movie-folder') as any
    expect(folderSettings.view_settings_json).toBe('{"sortBy":"title","layout":"grid"}')
    expect(folderSettings.applied_grouping).toBe('genre')
    expect(folderSettings.retrieve_children_metadata).toBe(1)
    expect(folderSettings.children_type_hint).toBe('movie')
    expect(folderSettings.process_tv_children).toBe(0)

    const visibleItems = db
      .prepare('SELECT item_id FROM account_visible_items WHERE account_id = ? ORDER BY item_id')
      .all('account-1') as { item_id: string }[]
    expect(visibleItems.map((row) => row.item_id)).toEqual(['movie-file', 'movie-folder', 'virtual-folder'])

    const manualTag = db.prepare('SELECT value FROM item_tags WHERE item_id = ? AND key = ?').get('movie-file', 'manual') as any
    expect(manualTag.value).toBe('favorite')

    const virtualTag = db
      .prepare('SELECT value FROM item_virtual_tags WHERE item_id = ? AND key = ?')
      .get('movie-file', 'collection') as any
    expect(virtualTag.value).toBe('wachowskis')

    const ftsRow = db.prepare('SELECT name, title FROM media_items_fts WHERE id = ?').get('movie-file') as any
    expect(ftsRow.name).toBe('The Matrix.mkv')
    expect(ftsRow.title).toBe('The Matrix')

    db.prepare('DELETE FROM media_items WHERE id = ?').run('movie-file')
    expect(db.prepare('SELECT 1 FROM user_state WHERE item_id = ?').get('movie-file')).toBeNull()
    expect(db.prepare('SELECT 1 FROM account_visible_items WHERE item_id = ?').get('movie-file')).toBeNull()
    expect(db.prepare('SELECT 1 FROM item_tags WHERE item_id = ?').get('movie-file')).toBeNull()
    expect(db.prepare('SELECT 1 FROM item_virtual_tags WHERE item_id = ?').get('movie-file')).toBeNull()
    expect(db.prepare('SELECT 1 FROM media_locations WHERE item_id = ?').get('movie-file')).toBeNull()

    db.prepare('DELETE FROM media_items WHERE id = ?').run('movie-folder')
    expect(db.prepare('SELECT 1 FROM folder_settings WHERE item_id = ?').get('movie-folder')).toBeNull()

    db.close()
  })

  it('uses the preferred media location in the read model when one is set', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    db.exec(SCHEMA_SQL)

    db.exec(`
      INSERT INTO media_items (id, parent_item_id, physical_kind, media_kind, name, created_at, updated_at)
      VALUES ('movie-item', NULL, 'file', 'movie', 'Movie.mkv', 1000, 1000);

      INSERT INTO media_locations (
        id, item_id, source_id, relative_path, name, type,
        is_present, is_ignored, is_hidden, is_shadowed, first_seen_at, last_seen_at
      )
      VALUES
        ('loc-a', 'movie-item', 'source-a', 'Movies/Movie.mkv', 'Movie.mkv', 'file', 1, 0, 0, 0, 1000, 1000),
        ('loc-b', 'movie-item', 'source-b', 'Films/Movie.mkv', 'Movie.mkv', 'file', 1, 0, 0, 0, 1000, 900);

      UPDATE media_items SET preferred_location_id = 'loc-b' WHERE id = 'movie-item';
    `)

    const row = db.prepare('SELECT path, source_id, selected_location_id FROM media_items_read WHERE id = ?').get('movie-item') as any
    expect(row.path).toBe('Films/Movie.mkv')
    expect(row.source_id).toBe('source-b')
    expect(row.selected_location_id).toBe('loc-b')

    db.close()
  })

  it('creates a consistent pre-migration backup for an on-disk database', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinome-db-backup-'))
    const dbPath = path.join(tempDir, 'library.db')
    const db = new Database(dbPath, { create: true })
    db.exec(`
      CREATE TABLE marker (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO marker (id, value) VALUES ('before', 'migration');
    `)

    const backupPath = createPreMigrationBackup(
      db,
      dbPath,
      1,
      2,
      new Date('2026-06-25T12:00:00.000Z')
    )
    db.close()

    expect(backupPath).toBe(path.join(tempDir, 'backups', 'library.before-v1-to-v2.2026-06-25T12-00-00-000Z.db'))
    expect(fs.existsSync(backupPath)).toBe(true)

    const backup = new Database(backupPath, { readonly: true })
    const row = backup.prepare('SELECT value FROM marker WHERE id = ?').get('before') as any
    expect(row.value).toBe('migration')
    backup.close()

    fs.rmSync(tempDir, { recursive: true, force: true })
  })
})
