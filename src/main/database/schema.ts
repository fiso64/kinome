// Keep this as the canonical schema for new databases.
// Existing databases are upgraded by versioned migrations in migrations/.
import { MEDIA_ITEMS_READ_MODEL_SQL } from './media-read-model.sql'

export const SCHEMA_SQL = `
-- Durable logical library items.
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

-- Physical filesystem occurrences for a logical media item.
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

${MEDIA_ITEMS_READ_MODEL_SQL};

-- Logical Content Entity (Movie, TV Show, Season, Episode)
CREATE TABLE IF NOT EXISTS media_entities (
    id TEXT PRIMARY KEY,
    
    -- Identifiers & Core Info
    tmdb_id INTEGER,
    media_type TEXT, -- 'movie', 'tv', 'season', 'episode'
    title TEXT,
    original_title TEXT,
    overview TEXT,
    
    -- Dates & Numbers
    release_date TEXT,
    year INTEGER,
    tmdb_runtime INTEGER,
    
    -- TV Specifics
    season_number INTEGER,
    episode_number INTEGER,

    -- Hierarchy
    parent_entity_id TEXT,

    -- Images (stored as individual columns for direct access)
    poster_path TEXT,
    backdrop_path TEXT,
    logo_path TEXT,

    -- Metadata control
    locked_fields_json TEXT, -- Array of locked field names
    last_refreshed_at INTEGER, -- Timestamp of last successful atomic metadata fetch
    version INTEGER DEFAULT 0,

    FOREIGN KEY(parent_entity_id) REFERENCES media_entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_media_entities_tmdb_id ON media_entities(tmdb_id);

CREATE TRIGGER IF NOT EXISTS media_items_entities_media_kind_ai AFTER INSERT ON media_entities
BEGIN
  UPDATE media_items SET media_kind = new.media_type WHERE entity_id = new.id;
END;

CREATE TRIGGER IF NOT EXISTS media_items_entities_media_kind_au AFTER UPDATE OF media_type ON media_entities
BEGIN
  UPDATE media_items SET media_kind = new.media_type WHERE entity_id = new.id;
END;


-- Normalized Relational Metadata

CREATE TABLE IF NOT EXISTS genres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_genres (
    entity_id TEXT NOT NULL,
    genre_id INTEGER NOT NULL,
    PRIMARY KEY (entity_id, genre_id),
    FOREIGN KEY (entity_id) REFERENCES media_entities(id) ON DELETE CASCADE,
    FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY,   -- TMDB person ID
    name TEXT NOT NULL,
    profile_path TEXT
);

CREATE TABLE IF NOT EXISTS credits (
    entity_id TEXT NOT NULL,
    person_id INTEGER NOT NULL,
    credit_type TEXT NOT NULL,   -- 'cast' or 'crew'
    character TEXT,              -- for cast
    job TEXT,                    -- for crew
    display_order INTEGER,
    PRIMARY KEY (entity_id, person_id, credit_type),
    FOREIGN KEY (entity_id) REFERENCES media_entities(id) ON DELETE CASCADE,
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entity_tags (
    entity_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (entity_id, key),
    FOREIGN KEY (entity_id) REFERENCES media_entities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entity_virtual_tags (
    entity_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (entity_id, key),
    FOREIGN KEY (entity_id) REFERENCES media_entities(id) ON DELETE CASCADE
);

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

CREATE INDEX IF NOT EXISTS idx_entity_genres_entity_id ON entity_genres(entity_id);
CREATE INDEX IF NOT EXISTS idx_credits_entity_id ON credits(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_tags_entity_id ON entity_tags(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_virtual_tags_entity_id ON entity_virtual_tags(entity_id);
CREATE INDEX IF NOT EXISTS idx_item_tags_item_id ON item_tags(item_id);
CREATE INDEX IF NOT EXISTS idx_item_virtual_tags_item_id ON item_virtual_tags(item_id);

-- Orphan cleanup triggers
CREATE TRIGGER IF NOT EXISTS cleanup_orphan_genres AFTER DELETE ON entity_genres
BEGIN
    DELETE FROM genres WHERE id = OLD.genre_id
    AND NOT EXISTS (SELECT 1 FROM entity_genres WHERE genre_id = OLD.genre_id);
END;

CREATE TRIGGER IF NOT EXISTS cleanup_orphan_people AFTER DELETE ON credits
BEGIN
    DELETE FROM people WHERE id = OLD.person_id
    AND NOT EXISTS (SELECT 1 FROM credits WHERE person_id = OLD.person_id);
END;


-- Accounts
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'normal' CHECK(role IN ('admin', 'normal')),
    created_at INTEGER NOT NULL
);

-- Account-level library filter rules (one row per restricted account)
CREATE TABLE IF NOT EXISTS account_filter_rules (
    account_id  TEXT PRIMARY KEY,
    mode        TEXT NOT NULL CHECK(mode IN ('allow', 'deny')),
    filter_json TEXT NOT NULL,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Pre-materialized per-account visible item set.
-- Only populated for accounts that have a filter rule.
-- Accounts with no rule see everything.
CREATE TABLE IF NOT EXISTS account_visible_items (
    account_id TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    PRIMARY KEY (account_id, item_id),
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY(item_id)    REFERENCES media_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_visible_items_account
    ON account_visible_items(account_id);


-- User State (Watched status, etc.)
CREATE TABLE IF NOT EXISTS user_state (
    item_id TEXT,
    user_id TEXT DEFAULT 'default',
    
    watched INTEGER DEFAULT 0, -- Boolean
    last_watched_at INTEGER,
    continue_watching_dismissed INTEGER DEFAULT 0, -- Boolean
    next_up_dismissed INTEGER DEFAULT 0, -- Boolean
    next_up_episode_id TEXT, -- UUID of the next episode to watch (for shows)
    
    PRIMARY KEY (item_id, user_id),
    FOREIGN KEY(item_id) REFERENCES media_items(id) ON DELETE CASCADE ON UPDATE CASCADE
);


-- Folder View Settings & Configuration
CREATE TABLE IF NOT EXISTS folder_settings (
    item_id TEXT PRIMARY KEY,
    
    -- JSON blob matching StoredViewSettings interface
    view_settings_json TEXT,

    -- Active grouping key (e.g. 'genre', 'year', 'seasonNumber'). Stored as a real column
    -- rather than inside view_settings_json so getFoldersWithActiveGrouping can use an index.
    applied_grouping TEXT,

    -- Scraper behavior flags
    retrieve_children_metadata INTEGER NOT NULL DEFAULT 0,
    children_type_hint TEXT,
    process_tv_children INTEGER NOT NULL DEFAULT 1,

    FOREIGN KEY(item_id) REFERENCES media_items(id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- FTS5 index keyed by durable media_items.id.
CREATE VIRTUAL TABLE IF NOT EXISTS media_items_fts USING fts5(
    id UNINDEXED,
    title,
    original_title,
    name,
    overview,
    tokenize = 'trigram'
);

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
`
