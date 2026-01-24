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
    
    -- TV Cached Data
    seasons_json TEXT, -- Cached TMDB seasons array
    episodes_json TEXT, -- Cached TMDB episodes array

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
`