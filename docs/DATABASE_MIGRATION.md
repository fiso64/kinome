# Database Migration Plan (JSON to SQLite)

This document outlines the transition from the in-memory `database.json` tree structure to a relational `SQLite` database.

## 1. Objectives

1.  **Scalability**: Support libraries with 100,000+ items without significant memory overhead during scanning/writing.
2.  **Reliability**: Use atomic transactions to prevent data corruption.
3.  **Performance**: Instant startup (lazy loading) and fast, indexed queries.

## 2. Database Schema Strategy

We use `better-sqlite3` for synchronous, high-performance execution in the Node.js main process.

### Tables

#### `items` (The Skeleton)
Represents the physical filesystem reality.
*   `id` (TEXT PK): SHA256 Hash of the relative path.
*   `parent_id` (TEXT FK): Pointer to the parent folder.
*   `path` (TEXT UNIQUE): Relative path from library root.
*   `type` (TEXT): 'file' | 'folder'
*   `mtime` (INTEGER): Modification time.
*   `is_missing` (INTEGER): Boolean (0/1).

#### `metadata` (The Flesh)
Content information fetched from TMDB or parsers.
*   `item_id` (TEXT FK PK)
*   `tmdb_id` (INTEGER)
*   `media_type` (TEXT): 'movie' | 'tv' | 'season' | 'episode'
*   `title`, `overview`, `year`
*   `images_json` (TEXT): JSON blob `{ poster, backdrop, logo }`.
*   `people_json` (TEXT): JSON blob for Cast/Crew.
*   `genres_json` (TEXT): JSON blob.
*   `tags_json` (TEXT): JSON blob.

#### `user_state` (The Soul)
User-specific interaction data.
*   `item_id` (TEXT FK)
*   `user_id` (TEXT): Default 'admin' for MVP.
*   `watched` (INTEGER): 0/1
*   `last_watched_at` (INTEGER)

#### `folder_settings` (The Presentation)
Configuration for how to display specific folders.
*   `item_id` (TEXT FK PK)
*   `view_settings_json` (TEXT)
*   `scraper_settings_json` (TEXT)

## 3. Implementation Status

### Completed
*   **Unified Scanner**: `filesystem.service.ts` walks the disk and performs upserts directly to SQLite.
*   **Tree Reconstruction**: The `repository.service.ts` provides methods to fetch children, ancestors, and descendants using efficient SQL queries (including CTEs).
*   **Metadata Separation**: Metadata is stored in a separate table, allowing files to be renamed (new ID) without polluting the metadata table with dead rows (though re-matching is currently required on rename).
*   **Type Safety**: Shared types updated to include `parentId`.

## 4. Current Deficiencies & Trade-offs

### A. The "Rename Problem" (ID Instability)
*   **Issue**: `id = SHA256(path)`. Renaming a file changes its ID.
*   **Impact**: User state (watched status) is lost on rename. Metadata is re-fetched.
*   **Fix Strategy**: Implement "soft renames" where we update the `path` column instead of deleting/inserting, possibly using `fs` watch events or heuristics.

### B. Search Performance
*   **Issue**: We currently load **all** items into memory to build a `Fuse.js` index at startup.
*   **Impact**: High memory usage for massive libraries.
*   **Fix Strategy**: Migrate search to **SQLite FTS5**.

### C. Type Safety
*   **Issue**: Some parts of the mapping logic use `any` casting to handle JSON blobs.
*   **Fix Strategy**: Define Zod schemas for the JSON columns to ensure runtime validity.

## 5. Future Architecture TODOs

1.  **[IMMEDIATE]** **Fix Unused Imports/Lints**: Ensure the codebase is clean. (Done)
2.  **[HIGH]** **SQLite FTS5**: Replace `Fuse.js` to drop memory usage and startup time.
3.  **[MEDIUM]** **File Watcher**: Integrate `chokidar` for real-time updates without manual refresh.
4.  **[LOW]** **DB Migrations**: Implement a versioned migration system (e.g. `kysely`) instead of raw `CREATE TABLE IF NOT EXISTS` checks.