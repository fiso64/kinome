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

    -- State Flags (stored as 0 or 1)
    is_hidden INTEGER DEFAULT 0,
    is_missing INTEGER DEFAULT 0,
    is_user_edited INTEGER DEFAULT 0,
    
    -- Timestamp
    added_at INTEGER DEFAULT (cast(strftime('%s','now') as int) * 1000),

    FOREIGN KEY(parent_id) REFERENCES items(id) ON DELETE CASCADE
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
    seasons_json TEXT, -- Cached TMDB seasons array
    episodes_json TEXT, -- Cached TMDB episodes array

    -- Versioning for cache-busting
    version INTEGER,

    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
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
    
    PRIMARY KEY (item_id, user_id),
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
);


-- Folder View Settings & Configuration
CREATE TABLE IF NOT EXISTS folder_settings (
    item_id TEXT PRIMARY KEY,
    
    -- JSON blob matching StoredViewSettings interface
    view_settings_json TEXT, 
    
    -- JSON blob for scraper behavior (retrieve_children_metadata, etc.)
    scraper_settings_json TEXT, 

    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
);

-- FTS5 Virtual Table for Search using Trigram Tokenizer
-- Columns are separated to allow weighted ranking (Title > Filename)
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    id UNINDEXED,
    title,          -- High weight (Metadata title)
    original_title, -- Medium weight
    name,           -- Low weight (Filename/Foldername)
    overview,       -- Lowest weight
    people,         -- Indexed for searching by actor/director
    tags,           -- Indexed for tag search
    tokenize = 'trigram'
);

-- Triggers to keep items_fts in sync with items
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (id, name, title, original_title, overview, people, tags) 
  VALUES (new.id, new.name, NULL, NULL, NULL, NULL, NULL);
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  UPDATE items_fts SET name = new.name WHERE id = new.id;
END;

-- Triggers to keep items_fts in sync with metadata
CREATE TRIGGER IF NOT EXISTS metadata_ai AFTER INSERT ON metadata BEGIN
  UPDATE items_fts SET 
    title = new.title,
    original_title = new.original_title,
    overview = new.overview, 
    people = new.people_json,
    tags = coalesce(new.tags_json, '') || ' ' || coalesce(new.virtual_tags_json, '')
  WHERE id = new.item_id;
END;

CREATE TRIGGER IF NOT EXISTS metadata_au AFTER UPDATE ON metadata BEGIN
  UPDATE items_fts SET 
    title = new.title,
    original_title = new.original_title,
    overview = new.overview, 
    people = new.people_json,
    tags = coalesce(new.tags_json, '') || ' ' || coalesce(new.virtual_tags_json, '')
  WHERE id = new.item_id;
END;

CREATE TRIGGER IF NOT EXISTS metadata_ad AFTER DELETE ON metadata BEGIN
  UPDATE items_fts SET title = NULL, original_title = NULL, overview = NULL, people = NULL, tags = NULL WHERE id = old.item_id;
END;
`
