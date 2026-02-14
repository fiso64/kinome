# Database Refactoring Analysis & Detailed Plan

## 1. Current State & Technical Debt Analysis

The current database structure in Kinome follows a **"Filesystem-First"** approach. This is its core identity: the app is a lens over your disk, not a detached metadata database. However, the internal implementation has drifted into patterns that hinder this goal:

### A. Identification vs. Location (The "Fragile Path" Problem)
- **The Issue**: Every item's identity (`id`) is currently a hash of its `path`. 
- **The Impact**: While the scanner has a "Rename Rescue" mechanism (using Inodes), it's a fallback. The *primary* identity is the path. If a folder rename isn't captured perfectly, the system "forgets" everything about those files: watched status, custom metadata, and locks.
- **Drive Moves**: Relying solely on Inodes (which change when moving cross-drive) is just as fragile.

### B. Relational Data Trapped in JSON (The "Opaque" Data problem)
- **Redundancy**: `people_json`, `genres_json`, `seasons_json`, and `episodes_json` store structured data as local blobs.
- **Scaling/Query Problem**: TMDB IDs for actors and genres are duplicated across thousands of rows. You cannot ask a simple SQL question like "Find all movies with Action + Tom Cruise" without expensive full-text scans.

### C. The Folder Settings Paradox
- **Scraper & View Settings**: These are per-folder and inherently hierarchical (inheritance). Unlike cast/crew, which is global metadata, these are **local document-style configurations**.
- **Refactoring Decision**: Refactoring these into a fully normalized schema (e.g., a `settings_overrides` table with key-value pairs) would likely degrade performance and make the recursive inheritance logic much harder to maintain. **These should remain as JSON blobs.**

---

## 2. Refactored "Filesystem-First" Architecture

We will move to a **Three-Layer Model** that balances filesystem accuracy with metadata stability.

### A. The Schema Layers
1.  **Filesystem Layer (`library_items`)**: Tracks path, mtime, and stats. Its primary job is representing the disk.
2.  **Entity Layer (`media_entities`)**: Tracks logical identity (TMDB ID, Media Type). This is where "watched status" and "locked titles" actually live.
3.  **Metadata Layer (Relational)**: Normalized tables for `people`, `credits`, and `genres`.

### B. Stable Identity (The "Triple Match" Strategy)
To ensure "Filesystem-First" doesn't mean "Fragile", we resolve identity using this priority:
1.  **Path Hash (Exact match)**: "I found a file where I expected one."
2.  **Inode/DeviceID (Rescue match)**: "The path changed, but the disk says it's the same physical file on the same drive."
3.  **Entity Link (Content/Fuzzy match)**: "Path and Inode changed (cross-drive move), but I've already identified this file as TMDB:123. I will re-link this new path to the existing entity."

---

## 3. Detailed Implementation Plan

### Phase 1: The Schema Foundation
1.  **New Tables**: Create `media_entities`, `people`, `credits`, `genres`, and `entity_genres`.
2.  **User State Decoupling**: Move `watched` and `last_watched_at` to `user_state` table, pointing to `entity_id` rather than `item_id`.
3.  **Refactor `library_items`**: Add `entity_id` and change the primary ID to a persistent UUID that is generated on first discovery and "sticks" to the Inode/Path.

### Phase 2: Refactoring Services
1.  **Repository Service**: Rewrite `find` to use JOINs on the new relational tables. Update `updateItem` to handle normalized writes.
2.  **Scanner Phase 1**: Update `filesystem.service.ts` to implement the "Triple Match" logic. Ensure that when a file is moved to a new drive, it can find its old `media_entity` if it was previously identified.
3.  **Metadata Service**: Update `enrichDatabase` to populate the normalized tables. 
    - *Note*: `seasons_json` will be replaced by a proper recursive link in `media_entities` (child entities for episodes).

### Phase 3: Virtual Filesystem Enhancement
1.  **Grouping Service**: Refactor `grouping.service.ts` to use SQL for grouping.
    - *Example*: Grouping by "Cast" becomes `SELECT * FROM people INNER JOIN credits ...`.
    - This will make "Tabs" and "Sections" layouts significantly faster.

---

## 4. Proposed SQL Schema (Finalized Draft)

```sql
-- 1. Represents the Disk
CREATE TABLE library_items (
    id TEXT PRIMARY KEY,       -- Stable UUID
    parent_id TEXT,
    path TEXT NOT NULL UNIQUE, -- Filesystem anchor
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('file', 'folder')),
    size INTEGER,
    mtime INTEGER,
    inode INTEGER,
    device_id INTEGER,
    entity_id TEXT,            -- Link to the "Brain"
    added_at INTEGER,
    FOREIGN KEY(entity_id) REFERENCES media_entities(id) ON DELETE SET NULL
);

-- 2. Represents the "Thing" (Movie/Show)
CREATE TABLE media_entities (
    id TEXT PRIMARY KEY,
    tmdb_id INTEGER,
    media_type TEXT NOT NULL, -- movie, tv, season, episode
    title TEXT,
    overview TEXT,
    year INTEGER,
    runtime INTEGER,
    parent_entity_id TEXT,    -- For Season/Episode hierarchy
    
    -- Images stay as simple paths/URLs
    poster_path TEXT,
    backdrop_path TEXT,
    logo_path TEXT,
    
    locked_fields_json TEXT,  -- Lock logic preserved
    last_refreshed_at INTEGER,
    FOREIGN KEY(parent_entity_id) REFERENCES media_entities(id) ON DELETE CASCADE
);

-- 3. Folder-Specific Document Data (JSON is appropriate here)
CREATE TABLE folder_settings (
    item_id TEXT PRIMARY KEY,
    view_settings_json TEXT,    -- Click actions, layouts
    scraper_settings_json TEXT, -- Control flags
    FOREIGN KEY(item_id) REFERENCES library_items(id) ON DELETE CASCADE
);

-- 4. Global Normalized Metadata
CREATE TABLE people (
    id INTEGER PRIMARY KEY, -- TMDB ID
    name TEXT,
    profile_path TEXT
);

CREATE TABLE credits (
    entity_id TEXT,
    person_id INTEGER,
    role TEXT,
    job TEXT,
    character_name TEXT,
    order_index INTEGER,
    PRIMARY KEY (entity_id, person_id, role, job, character_name),
    FOREIGN KEY(entity_id) REFERENCES media_entities(id) ON DELETE CASCADE,
    FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
);

CREATE TABLE genres (
    id INTEGER PRIMARY KEY, -- TMDB ID
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE entity_genres (
    entity_id TEXT NOT NULL,
    genre_id INTEGER NOT NULL,
    PRIMARY KEY (entity_id, genre_id),
    FOREIGN KEY(entity_id) REFERENCES media_entities(id) ON DELETE CASCADE,
    FOREIGN KEY(genre_id) REFERENCES genres(id) ON DELETE CASCADE
);

CREATE TABLE entity_tags (
    entity_id TEXT NOT NULL,
    tag_key TEXT NOT NULL,
    tag_value TEXT NOT NULL,
    tag_type TEXT NOT NULL CHECK(tag_type IN ('custom', 'virtual')),
    PRIMARY KEY (entity_id, tag_key, tag_type),
    FOREIGN KEY(entity_id) REFERENCES media_entities(id) ON DELETE CASCADE
);

-- 5. User History
CREATE TABLE user_state (
    entity_id TEXT,         -- Stable across file moves!
    user_id TEXT DEFAULT 'default',
    watched INTEGER DEFAULT 0,
    last_watched_at INTEGER,
    progress_seconds INTEGER,
    PRIMARY KEY (entity_id, user_id),
    FOREIGN KEY(entity_id) REFERENCES media_entities(id) ON DELETE CASCADE
);
```

