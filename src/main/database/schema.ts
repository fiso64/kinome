// REMINDER: Absolutely no migrations.

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

    -- State Flags (stored as 0 or 1)
    is_hidden INTEGER DEFAULT 0,
    is_ignored INTEGER DEFAULT 0,
    is_missing INTEGER DEFAULT 0,
    
    -- Timestamp
    added_at INTEGER DEFAULT (cast(strftime('%s','now') as int) * 1000),

    FOREIGN KEY(parent_id) REFERENCES items(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_parent_id ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);


-- Content Metadata (TMDB, Scraped Info)
CREATE TABLE IF NOT EXISTS metadata (
    item_id TEXT PRIMARY KEY,
    
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
    
    -- Images (Stored as JSON: { poster, backdrop, logo })
    images_json TEXT,
    
    -- Rich Data (Stored as JSON arrays/objects)
    genres_json TEXT, -- ["Action", "Sci-Fi"]
    tags_json TEXT,   -- {"resolution": "4k"}
    people_json TEXT, -- { cast: [...], crew: [...] }
    virtual_tags_json TEXT, -- Calculated virtual tags
    
    -- TV Cached Data
      seasons_json TEXT, -- For TV Shows: Cache of all seasons from TMDB
      episodes_json TEXT, -- For Seasons: Cache of all episodes from TMDB
      locked_fields_json TEXT, -- Array of locked field names
      last_refreshed_at INTEGER, -- Timestamp of last successful atomic metadata fetch
      version INTEGER DEFAULT 0,
      FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE ON UPDATE CASCADE
    );

CREATE INDEX IF NOT EXISTS idx_metadata_tmdb_id ON metadata(tmdb_id);


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
CREATE TRIGGER IF NOT EXISTS metadata_ai AFTER INSERT ON metadata BEGIN
  UPDATE items_fts SET 
    title = new.title,
    original_title = new.original_title,
    overview = new.overview
  WHERE id = new.item_id;
END;

CREATE TRIGGER IF NOT EXISTS metadata_au AFTER UPDATE OF title, original_title, overview ON metadata
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
  WHERE id = new.item_id;
END;

CREATE TRIGGER IF NOT EXISTS metadata_ad AFTER DELETE ON metadata BEGIN
  UPDATE items_fts SET title = NULL, original_title = NULL, overview = NULL WHERE id = old.item_id;
END;
`
