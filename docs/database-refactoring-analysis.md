
# Database Refactoring Analysis & Detailed Plan

## Implementation Status

### ✅ Phase 1A Complete: Schema Foundation & Repository Layer Migration
**Date**: 2026-02-24

All changes verified: `bun typecheck` ✅, `bun test` ✅ — 146/146 passing. Manually tested via dev server ✅.

1. **Schema (`schema.ts`)**: 
   - Renamed `metadata` table → `media_entities`
   - Added `entity_id TEXT` column to `items` with `FOREIGN KEY → media_entities(id) ON DELETE SET NULL`
   - Added `parent_entity_id` to `media_entities` for Season/Episode hierarchies
   - Images moved from `images_json` blob to direct columns: `poster_path`, `backdrop_path`, `logo_path`
   - FTS triggers updated to resolve through `entity_id` link
   - Added index on `items(entity_id)`

2. **Repository Layer**:
   - `repo-definitions.ts`: Table alias `m` → `e` (media_entities), image fields use direct columns
   - `query-builder.ts`: JOINs changed from `metadata m ON i.id = m.item_id` → `media_entities e ON i.entity_id = e.id`
   - `filesystem.repo.ts`: All queries use `entity_id` link. Introduced `ENTITY_COLUMNS_SQL` — shared explicit column list that prevents `e.id` shadowing
   - `metadata.repo.ts`: Full rewrite — entities are independent rows, `ensureEntityForItem()` creates+links on demand
   - `search.repo.ts`: All search queries updated to `entity_id` join pattern
   - `mappers.ts`: Metadata presence detected via `_entity_id` column alias

3. **Service Layer**:
   - `repository.service.ts`: Updated TV show and discovery queries, image handling simplified
   - `virtualTags.service.ts`: SQL references updated from `metadata.*` → `media_entities.*`
   - `filesystem.service.ts`: `verifyImagePaths` uses direct columns instead of JSON blob
   - `search.service.ts`: `mapRowToEntry()` updated to read `poster_path` directly (was still using dead `images_json` blob)
   - `search-store.svelte.ts` (frontend): Removed dead `images_json` parsing from live-update handler

4. **Tests**: 
   - `query-builder.test.ts`, `scan-phase1.test.ts`, `scanner-discovery.test.ts`, `search.repo.test.ts`, `settings.repo.test.ts` — updated for new schema
   - `root-retrieval.test.ts` — **NEW**, regression guard for the column shadowing bug + end-to-end item retrieval flow

#### Gotchas & Lessons Learned

- **`bun:sqlite` column shadowing**: When `SELECT i.*, e.*` is used and both tables have an `id` column, the result JS object only keeps the **last** `id` (from `e.id`). When the entity is NULL (no metadata), this makes `item.id` silently become `null`, breaking all downstream code. **Fix**: Never use `e.*`. Use the exported `ENTITY_COLUMNS_SQL` fragment which explicitly lists all entity columns except `id`, selecting it only as `_entity_id`.
- **Stale mapping code**: When schema changes remove a column (`images_json`), all code that reads that column must be updated — including private mapping functions like `search.service.ts:mapRowToEntry()` that don't show up in type checks because they use `any` types.

### ❌ Phase 1B Deferred: UUID Identity & Triple Match
*Decision: 2026-02-24 — Deferred indefinitely.*

The original plan proposed replacing path-hash IDs with random UUIDs and implementing "Triple Match" identity resolution. After review, this was deemed **high-cost, low-reward**:
- **Path-as-identity is correct for "filesystem first"** — the path IS the canonical identity. This isn't a bug, it's the design.
- **Rename rescue already works** — `handleItemRenamed` + inode-based rescue handles the common cases. The only gap (cross-drive moves) is too niche to justify the blast radius.
- **Deterministic IDs are valuable** — `SHA-256(path)` is debuggable, reproducible, and simple. UUID matching heuristics would add complexity and subtle bugs.
- **Phase 1A already achieved the key architectural win** — decoupling metadata (`media_entities`) from items via `entity_id` means metadata survives item deletion and can be shared/relinked. This was the real value of the refactoring.

### ✅ Phase 2 Complete: Normalized Relational Metadata
**Date**: 2026-02-25

All changes verified: `bun typecheck` ✅, `bun test` ✅ — 146/146 passing.

#### Goal
Eliminate JSON blobs for relational data (`genres_json`, `people_json`, `tags_json`, `virtual_tags_json`) in favor of proper normalized tables. Drop `seasons_json`/`episodes_json` in favor of in-memory caching during enrichment.

#### New Tables

```sql
-- Deduplicated genres (TMDB genre names)
CREATE TABLE genres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
);

-- Junction: which entity has which genres  
CREATE TABLE entity_genres (
    entity_id TEXT NOT NULL,
    genre_id INTEGER NOT NULL,
    PRIMARY KEY (entity_id, genre_id),
    FOREIGN KEY (entity_id) REFERENCES media_entities(id) ON DELETE CASCADE,
    FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE
);

-- Deduplicated people (keyed by TMDB person ID)
CREATE TABLE people (
    id INTEGER PRIMARY KEY,   -- TMDB person ID
    name TEXT NOT NULL,
    profile_path TEXT
);

-- Junction: which entity has which person in which role
CREATE TABLE credits (
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

-- User-defined key-value tags (e.g. {"resolution": "4k", "source": "bluray"})
CREATE TABLE entity_tags (
    entity_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (entity_id, key),
    FOREIGN KEY (entity_id) REFERENCES media_entities(id) ON DELETE CASCADE
);

-- Computed virtual tags (same shape, separate table for isolation)
-- Wiped and regenerated in bulk during maintenance pass.
CREATE TABLE entity_virtual_tags (
    entity_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (entity_id, key),
    FOREIGN KEY (entity_id) REFERENCES media_entities(id) ON DELETE CASCADE
);
```

#### Orphan Cleanup (Triggers)
```sql
-- Auto-delete genres with no remaining references
CREATE TRIGGER cleanup_orphan_genres AFTER DELETE ON entity_genres
BEGIN
    DELETE FROM genres WHERE id = OLD.genre_id
    AND NOT EXISTS (SELECT 1 FROM entity_genres WHERE genre_id = OLD.genre_id);
END;

-- Auto-delete people with no remaining references
CREATE TRIGGER cleanup_orphan_people AFTER DELETE ON credits
BEGIN
    DELETE FROM people WHERE id = OLD.person_id
    AND NOT EXISTS (SELECT 1 FROM credits WHERE person_id = OLD.person_id);
END;
```

#### Columns Removed from `media_entities`
- `genres_json` → replaced by `entity_genres` JOIN
- `people_json` → replaced by `credits` + `people` JOIN
- `tags_json` → replaced by `entity_tags`
- `virtual_tags_json` → replaced by `entity_virtual_tags`
- `seasons_json` → **dropped entirely**, passed in-memory during `process_show()` enrichment
- `episodes_json` → **dropped entirely**, same as above

#### Read Path (API Compatibility)
Queries that need genres/credits use `json_group_array()` subqueries:
```sql
-- Genres as JSON array
(SELECT json_group_array(g.name) FROM entity_genres eg
 JOIN genres g ON eg.genre_id = g.id
 WHERE eg.entity_id = e.id) AS genres_json

-- Tags as JSON object  
(SELECT json_group_object(t.key, t.value) FROM entity_tags t
 WHERE t.entity_id = e.id) AS tags_json
```

#### Write Path
`upsertMetadata()` handles junction inserts:
1. **Genres**: `INSERT OR IGNORE INTO genres (name)` for each, then `DELETE FROM entity_genres WHERE entity_id = ?` + re-insert
2. **Credits**: `INSERT OR REPLACE INTO people (id, name, profile_path)` for each, then `DELETE FROM credits WHERE entity_id = ?` + re-insert
3. **Tags**: `DELETE FROM entity_tags WHERE entity_id = ?` + re-insert

#### Design Decisions
- **Separate tables for tags vs virtual tags**: Virtual tags are bulk-wiped during maintenance. Isolating them prevents accidental user tag deletion and simplifies the re-evaluation pass.
- **`seasons_json`/`episodes_json` dropped, not normalized**: These are ephemeral TMDB API caches used only during `process_show()`. Passing data in-memory as function arguments is simpler and eliminates stale cache risk. See `spec/backend/scan_architecture.md` lines 261-296.
- **Virtual tags still persisted (not computed on-the-fly)**: The query builder filters by virtual tags in WHERE clauses. Computing them at query time would require evaluating JS rule logic inside SQL, which isn't possible.

---

## Original Analysis (Context)

*The sections below are retained as historical context for the refactoring decisions. Some proposals were deferred or revised — see the Implementation Status above for the authoritative state.*

### Technical Debt Identified

**A. Relational Data Trapped in JSON (The "Opaque" Data problem)**
- **Redundancy**: `people_json`, `genres_json` store structured data as local blobs.
- **Scaling/Query Problem**: TMDB IDs for actors and genres are duplicated across thousands of rows. You cannot ask a simple SQL question like "Find all movies with Action + Tom Cruise" without expensive full-text scans or parsing JSON during queries.
- **Resolution**: Phase 2 normalizes these into proper relational tables.

**B. The Folder Settings Paradox**
- **Scraper & View Settings**: These are per-folder and inherently hierarchical (inheritance). Unlike cast/crew, which is global metadata, these are **local document-style configurations**.
- **Decision**: `folder_settings` remains as JSON blobs. This is the correct choice for document-style config with recursive inheritance.

**C. Identification vs. Location** *(Deferred — see Phase 1B)*
- The original analysis proposed replacing path-hash IDs with UUIDs and implementing "Triple Match" identity resolution.
- After review, this was deferred: path-as-identity is correct for "filesystem first", rename rescue already works, and the Phase 1A `entity_id` decoupling achieved the key architectural win.

### Architecture: Three-Layer Model

The implemented architecture follows a layered model:
1. **Filesystem Layer (`items`)**: Tracks path, mtime, stats, and physical parent/child relationships. ID = `SHA-256(path)`.
2. **Entity Layer (`media_entities`)**: Tracks logical identity (TMDB ID, Media Type). Linked from items via `entity_id`.
3. **User State Layer (`user_state`)**: Tracks watched status, progress. Keyed by `item_id` (not `entity_id` — Phase 1B deferral).
4. **Relational Metadata Layer** *(Phase 2)*: Normalized tables for `people`, `credits`, `genres`, `entity_tags`, `entity_virtual_tags`.

### Consumer Impact

- **Grouping Logic** (`spec/grouping_and_layouts.md`): Fully preserved. Consumers receive JSON-deserialized `genres` and `tags` via `json_group_array()` structural reconstitution in the query builders.
- **TV Specs** (`spec/backend/tv_parsing.md`): The Phase 1 TV analyzer operates on paths/regexes and writes `seasonNumber` and `episodeNumber` to `media_entities`.
- **Scan Architecture** (`spec/backend/scan_architecture.md`): Phase 1 filesystem sync unchanged. Phase 2 enrichment passes TMDB season/episode data in-memory instead of caching in the DB.
