// REMINDER: Absolutely no migrations.
// Breaking Changes are OK — user deletes library.db and re-scans.

export const SCHEMA_SQL = `
-- The physical filesystem structure
CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('file', 'folder')),
    
    -- File Stats
    size INTEGER,
    mtime INTEGER,
    birthtime INTEGER,
    inode INTEGER,
    device_id INTEGER,

    -- Link to logical content entity
    entity_id TEXT,

    -- State Flags (stored as 0 or 1)
    is_hidden INTEGER DEFAULT 0,
    is_ignored INTEGER DEFAULT 0,
    is_missing INTEGER DEFAULT 0,

    -- Virtual Folder
    is_virtual      INTEGER DEFAULT 0,
    virtual_type    TEXT CHECK(virtual_type IN ('user', 'grouping', 'season')),
    filter_json TEXT,

    -- Timestamp
    added_at INTEGER DEFAULT (cast(strftime('%s','now') as int) * 1000),

    FOREIGN KEY(parent_id) REFERENCES items(id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY(entity_id) REFERENCES media_entities(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_items_parent_id ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
CREATE INDEX IF NOT EXISTS idx_items_entity_id ON items(entity_id);
CREATE INDEX IF NOT EXISTS idx_items_is_virtual ON items(is_virtual);
CREATE INDEX IF NOT EXISTS idx_items_virtual_type ON items(virtual_type);


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
    runtime INTEGER,
    
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

CREATE INDEX IF NOT EXISTS idx_entity_genres_entity_id ON entity_genres(entity_id);
CREATE INDEX IF NOT EXISTS idx_credits_entity_id ON credits(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_tags_entity_id ON entity_tags(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_virtual_tags_entity_id ON entity_virtual_tags(entity_id);

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
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE ON UPDATE CASCADE
);


-- Folder View Settings & Configuration
CREATE TABLE IF NOT EXISTS folder_settings (
    item_id TEXT PRIMARY KEY,
    
    -- JSON blob matching StoredViewSettings interface
    view_settings_json TEXT, 
    
    -- JSON blob for scraper behavior (retrieve_children_metadata, etc.)
    scraper_settings_json TEXT, 

    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- FTS5 Virtual Table for Search using Trigram Tokenizer
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    id UNINDEXED,
    title,          
    original_title, 
    name,           
    overview,       
    tokenize = 'trigram'
);

-- Triggers: Gated and Content-Aware for Performance
-- Phase 1 Fix: Only re-index if the 'name' column actually changes.
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (id, name, title, original_title, overview) 
  VALUES (new.id, new.name, NULL, NULL, NULL);
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE OF name ON items 
FOR EACH ROW
WHEN (OLD.name IS NOT NEW.name)
BEGIN
  UPDATE items_fts SET name = new.name WHERE id = new.id;
END;

-- Phase 2 Fix: Only re-index metadata if searchable content drifts.
CREATE TRIGGER IF NOT EXISTS media_entities_ai AFTER INSERT ON media_entities BEGIN
  -- Update the FTS row that was already created by the items trigger
  UPDATE items_fts SET 
    title = new.title,
    original_title = new.original_title,
    overview = new.overview
  WHERE id = (SELECT id FROM items WHERE entity_id = new.id LIMIT 1);
END;

CREATE TRIGGER IF NOT EXISTS media_entities_au AFTER UPDATE OF title, original_title, overview ON media_entities
FOR EACH ROW
WHEN (
    OLD.title IS NOT NEW.title OR 
    OLD.original_title IS NOT NEW.original_title OR 
    OLD.overview IS NOT NEW.overview
)
BEGIN
  UPDATE items_fts SET 
    title = new.title,
    original_title = new.original_title,
    overview = new.overview
  WHERE id = (SELECT id FROM items WHERE entity_id = new.id LIMIT 1);
END;

CREATE TRIGGER IF NOT EXISTS media_entities_ad AFTER DELETE ON media_entities BEGIN
  UPDATE items_fts SET title = NULL, original_title = NULL, overview = NULL
  WHERE id = (SELECT id FROM items WHERE entity_id = old.id LIMIT 1);
END;
`
