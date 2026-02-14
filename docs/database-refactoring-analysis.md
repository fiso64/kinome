
# Database Refactoring Analysis & Detailed Plan

## 1. Current State & Technical Debt Analysis

The current database structure in Kinome follows a **"Filesystem-First"** approach. This is its core identity: the app is a lens over your disk, not a detached metadata database. However, the internal implementation has drifted into patterns that hinder this goal:

### A. Identification vs. Location (The "Fragile Path" Problem)
- **The Issue**: Every item's identity (`id`) is currently a hash of its `path`. 
- **The Impact**: While the scanner has a "Rename Rescue" mechanism (using Inodes), it's a fallback. The *primary* identity is the path. If a folder rename isn't captured perfectly, the system "forgets" everything about those files: watched status, custom metadata, and locks.
- **Drive Moves**: Relying solely on Inodes (which change when moving cross-drive) is just as fragile.
- **Rename Costs**: Renaming a folder currently requires a "destructive cascade" (DELETE old IDs, INSERT new IDs, UPDATE all child foreign keys).
- **The UUID Solution**: By using random, persistent UUIDs for `library_items`:
    - Renames become cheap metadata updates (`UPDATE items SET path = ...`) instead of destructive operations.
    - Identity is totally decoupled from location.
    - **Trade-off**: IDs are no longer deterministic based on path. However, state is preserved via the `media_entities` layer (Content Matching), making this acceptable and even advantageous.

### B. Relational Data Trapped in JSON (The "Opaque" Data problem)
- **Redundancy**: `people_json`, `genres_json`, `seasons_json`, and `episodes_json` store structured data as local blobs in `metadata`.
- **Scaling/Query Problem**: TMDB IDs for actors and genres are duplicated across thousands of rows. You cannot ask a simple SQL question like "Find all movies with Action + Tom Cruise" without expensive full-text scans or parsing JSON during queries. In complex UI layouts like Sections querying via Virtual Tags, this degrades performance.

### C. The Folder Settings Paradox
- **Scraper & View Settings**: These are per-folder and inherently hierarchical (inheritance). Unlike cast/crew, which is global metadata, these are **local document-style configurations**.
- **Refactoring Decision**: Refactoring `folder_settings` into a fully normalized schema (e.g., a `settings_overrides` table with key-value pairs) would likely degrade performance and make the recursive inheritance logic much harder to maintain. **These should remain as JSON blobs.**

---

## 2. Refactored "Filesystem-First" Architecture

We will move to a **Three-Layer Model** that balances filesystem accuracy with metadata stability:

### A. The Schema Layers
1.  **Filesystem Layer (`library_items`)**: Tracks path, mtime, stats (`inode`, `device_id`), and physical parent/child relationships. Its primary job is representing the files and folders on disk. The primary key (`id`) is a persistent UUID.
2.  **Entity Layer (`media_entities`)**: Tracks logical identity (TMDB ID, Media Type, Season/Episode structure). This is a purely logical layer representing movies, shows, seasons, and episodes.
3.  **User State Layer (`user_state`)**: Tracks "watched status", playback timestamps, and progress. Crucially, this attaches to `entity_id` rather than `item_id`.
4.  **Metadata Layer (Relational)**: Normalized junction tables for `people`, `credits`, `genres`, and `tags`.

### B. Stable Identity (The "Triple Match" Strategy)
During scanning and Phase 1 (`syncDiskToDatabase`), we resolve identity using this priority to maintain resilience:
1.  **Path Hash / Exact Match**: Look up if we know the physical path. Since IDs are UUIDs, we must query by `path`.
2.  **Inode/DeviceID (Rescue match)**: "The path changed, but the disk says it's the same physical file on the same drive." O(1) map-based lookup during Phase 1 sync.
3.  **Entity Link (Content/Fuzzy match)**: "Path and Inode changed (e.g., cross-drive move or file replacement), but the filename and size exactly matches an existing item, or we re-identified this fast." We link this new `library_item` to the existing `media_entity`.

---

## 3. Detailed Implementation Plan & Migration Strategy

### Phase 1: The Schema Foundation (Breaking Changes Allowed)

Per the established `migration.service.ts` policy, Kinome does **not** support traditional database migrations or zero-data-loss transformations for major architectural shifts. This avoids technical debt and keeps the backend lean.

1.  **Fresh Database Setup**: The user handles schema changes by deleting their previous `library.db`.
2.  **Schema Creation**: On startup, completely new tables and virtual tables are initialized: `media_entities`, `people`, `credits`, `genres`, `entity_genres`, `entity_tags`, `library_items` (replacing `items`), and the new `user_state` mapping.
3.  **Authoritative Rescan**: The scanner relies entirely on Phase 1 (Filesystem Sync) to rebuild the `library_items` tree using persistent UUIDs and Phase 2 (Metadata Enrichment) to reconstitute the `media_entities` and relationships (e.g., Season and Episode entities) via TMDB data. 
    - Note: Because watched history currently lives in the local DB, wiping the schema *will* clear user state (`watched` statuses, custom tags). This is accepted per the current "Breaking Changes are OK" migration policy.

### Phase 2: Refactoring Core Architectural Components

Refactoring the repository and query builders is the highest-risk step.

#### A. Repository Service & Query Builder (`repository.service.ts` & `query-builder.ts`)
- **Query Builder (`buildFindQuery`)**: Must be completely overhauled to support JOINs.
  - Base query: `SELECT li.*, me.* FROM library_items li LEFT JOIN media_entities me ON li.entity_id = me.id`.
  - Relation loading: If `options.fields` includes `genres`, we must apply a `GROUP_CONCAT` or a lateral join to select array data efficiently, OR we execute separate fetching logic in the Mapper. *Decision*: To maintain SQLite performance, `query-builder.ts` will use `json_group_array()` to pack relational data (`genres`, `tags`) back into JSON strings during the `find` operation, allowing `mappers.ts` to deserialize them into lists inside the `LibraryItem` interface.
- **The Single Source of Truth Principle**: `repository.service.ts` continues to orchestrate across repositories. `_updateItem` will now branch: `title` -> `media_entities`, `is_hidden` -> `library_items`, `watched` -> `user_state`.
- **Parameter Prefix Rule (`@`)**: Ensure all batch inserts and updates (especially for the relational metadata) strictly use the `@` prefix for bun:sqlite binding variables.

#### B. Scanner Phase 1: Filesystem Sync (`scan_architecture.md`)
- Updates to `syncDiskToDatabase` inside `filesystem.service.ts`.
- The `FingerprintBuffer` logic changes: Missing items detection now relies on `library_items`, and updates to `mtime`/`size` happen natively.
- Renames / Rename Rescue: When a file is moved, the ID (UUID) is simply retained. We issue `UPDATE library_items SET path = @path, parent_id = @parent_id WHERE id = @id`. This avoids cascade deletes entirely.

#### C. Phase 2 Enrichment & TV Parsing (`metadata.service.ts` & `tv_parsing.md`)
- **Metadata Mapping**: `applyMetadataToItem` and `applyTvShowData` will no longer serialize `seasons_json` directly into the database. Instead:
  - When TMDB data is fetched, the service verifies the `media_entities` hierarchy.
  - If TMDB reports 5 seasons, it UPSERTs 5 Season `media_entities` linking to the Show `media_entity`.
  - When parsing local directories via `syncTvShowStructure` (`tv_parsing.md`), the regex identifies `seasonNumber = 1`. The `library_item` for `/S01/` is updated, and its `entity_id` is linked directly to the Season `media_entity` for Season 1.
  - This guarantees perfect adherence to the "Decoupled Architecture Rule"; locks are maintained on the `media_entities` row.
- **Episodes**: The TV parsing module assigns `episodeNumber` to files. The Phase 2 orchestrator will link these `library_items` to the Episode `media_entities` populated by the TMDB sync.

#### D. The Grouping Service (`grouping.service.ts` & `spec/grouping_and_layouts.md`)
- **Constraint Checklist**: We must preserve the layout-driven logical grouping.
- Currently, `getGroupsOnly` and `groupItemsRecursive` extract values from memory using `getValuesForKey(item, 'genres')`.
- Because `repository.service.ts` + `query-builder.ts` will automatically reconstitute the hierarchical fields (via `json_group_array`), the `LibraryItem` interface remains identical to the application code.
- **Performance Fixes**: Instead of fetching all items into memory and sorting/grouping in JS, the new schema enables SQL-native group counts if needed. However, since Kinome operates on specific subsets of folders (`parentId = ...`), reading JSON-hydrated objects from SQLite remains extremely fast.
- `Virtual IDs`: The system generating `virtual--{parentUUID}--{tokenPath}` remains completely functional because it operates on `LibraryItem` objects post-hydration.

### Phase 3: Edge Cases and Refinement

1.  **User State Decoupling (`user_state`)**: User state currently points to `item_id`. By pointing to `media_entity.id`, if a user replaces an `x264` file with an `HEVC` file, and the path changes but the TMDB match succeeds, their watched status natively transfers over without extra scripts.
2.  **API Fallbacks (`server.ts`)**: `server.ts` uses fallback `options.fields`. We must ensure the `CORE_FIELDS` constant exactly matches the properties that the new joined queries naturally provide, preventing `undefined` field errors in the frontend.
3.  **Search (FTS)**: We use triggers on `media_entities` to populate the FTS tables. The FTS index ignores `library_items` paths entirely and focuses strictly on logical entity names, summaries, and now dynamically grouped cast names from the `people` bridge.

---

## 4. Proposed SQL Schema (Finalized Draft)

```sql
-- 1. Represents the Disk (Filesystem Layer)
CREATE TABLE library_items (
    id TEXT PRIMARY KEY,       -- Stable UUID
    parent_id TEXT,            -- Recursive linkage within library_items
    path TEXT NOT NULL UNIQUE, -- Filesystem anchor
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('file', 'folder')),
    size INTEGER,
    birthtime INTEGER,
    mtime INTEGER,
    inode INTEGER,
    device_id INTEGER,
    entity_id TEXT,            -- Link to the "Brain"
    added_at INTEGER,
    is_hidden INTEGER DEFAULT 0,
    is_ignored INTEGER DEFAULT 0,
    is_missing INTEGER DEFAULT 0,
    FOREIGN KEY(parent_id) REFERENCES library_items(id) ON DELETE CASCADE,
    FOREIGN KEY(entity_id) REFERENCES media_entities(id) ON DELETE SET NULL
);

-- 2. Represents the "Thing" (Movie/Show) (Entity Layer)
CREATE TABLE media_entities (
    id TEXT PRIMARY KEY,      -- Generic UUID
    tmdb_id INTEGER,
    media_type TEXT NOT NULL, -- movie, tv, season, episode
    title TEXT,
    original_title TEXT,
    overview TEXT,
    release_date TEXT,
    year INTEGER,
    runtime INTEGER,
    parent_entity_id TEXT,    -- For Season/Episode hierarchy
    season_number INTEGER,
    episode_number INTEGER,
    
    -- Images stay as simple paths/URLs
    poster_path TEXT,
    backdrop_path TEXT,
    logo_path TEXT,
    
    locked_fields_json TEXT,  -- Lock logic preserved
    last_refreshed_at INTEGER,
    version INTEGER DEFAULT 0,
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
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    tmdb_id INTEGER UNIQUE,
    name TEXT,
    profile_path TEXT
);

CREATE TABLE credits (
    entity_id TEXT,
    person_id INTEGER,
    role TEXT, -- 'cast', 'crew'
    job TEXT,
    character_name TEXT,
    order_index INTEGER,
    PRIMARY KEY (entity_id, person_id, role, job, character_name),
    FOREIGN KEY(entity_id) REFERENCES media_entities(id) ON DELETE CASCADE,
    FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
);

CREATE TABLE genres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    entity_id TEXT,         -- Stable across file moves AND cross-drive swaps!
    user_id TEXT DEFAULT 'default',
    watched INTEGER DEFAULT 0,
    last_watched_at INTEGER,
    continue_watching_dismissed INTEGER DEFAULT 0,
    next_up_dismissed INTEGER DEFAULT 0,
    next_up_episode_id TEXT,    -- Link to child media_entity
    PRIMARY KEY (entity_id, user_id),
    FOREIGN KEY(entity_id) REFERENCES media_entities(id) ON DELETE CASCADE
);

-- 6. Search Index (FTS)
CREATE VIRTUAL TABLE media_entities_fts USING fts5(
    id UNINDEXED,         -- media_entity.id
    title,
    original_title,
    overview,
    tokenize = 'trigram'
);
```

### 5. Summary of Impacts & Resolutions

- **Consumer Grouping Logic (`spec/grouping_and_layouts.md`)**: Fully preserved. Consumers will continue to receive JSON-deserialized `genres` and `tags` strings due to structural reconstitution via SQLite `json_group_array()` within the Service Query Builders. The abstraction cleanly protects downstream layout generators and recursive virtualization functions.
- **TV Specs (`spec/backend/tv_parsing.md`)**: The Phase 1 TV analyzer operates on paths/regexes and writes `seasonNumber` and `episodeNumber` properties to `media_entities`. Since multiple files can map to a single Entity, duplicate resolutions naturally merge into a single entity record.
- **Scan Architecture (`spec/backend/scan_architecture.md`)**: Phase 1 avoids database deadlocks and simplifies tree pruning. If `folder_A` is renamed to `folder_B`, Phase 1 identifies the inode and merely updates the `library_items` path string recursively, without severing user-watched history which now permanently clings to `media_entities`.

This refactoring acts as an irreversible paradigm shift towards enterprise robustness, trading single-table query simplicity for resilient, multi-layered identity management.

