# Database Migration Plan (JSON to SQLite)

This document outlines the transition from the in-memory `database.json` tree structure to a relational `SQLite` database.

## 1. Objectives

1.  **Scalability**: Support libraries with 100,000+ items without memory bottlenecks.
2.  **Reliability**: Use atomic transactions to prevent data corruption during writes/crashes.
3.  **Separation of Concerns**: Decouple filesystem state, fetched metadata, and user preferences.
4.  **Performance**: Instant startup and fast, indexed queries.

## 2. Database Schema Strategy

We will use `better-sqlite3` for synchronous, high-performance execution.

### Tables

#### `items` (The Skeleton)
Represents the physical filesystem reality.
*   `id` (TEXT PK): Hash of the relative path. Stable across moves if we implement move-tracking later, but generally path-dependent.
*   `parent_id` (TEXT FK): Adjacency list pointer to the parent folder.
*   `path` (TEXT UNIQUE): Relative path from library root.
*   `name` (TEXT)
*   `type` (TEXT): 'file' | 'folder'
*   `mtime` (INTEGER): Modification time, used to detect file changes during scans.
*   `missing` (INTEGER): Boolean (0/1). If 1, file was not found during last scan.

#### `metadata` (The Flesh)
Content information fetched from TMDB or parsers.
*   `item_id` (TEXT FK PK)
*   `tmdb_id` (INTEGER)
*   `media_type` (TEXT): 'movie' | 'tv' | 'season' | 'episode'
*   `title`, `overview`, `year`, `release_date`, `runtime`
*   `images_json` (TEXT): JSON blob `{ poster, backdrop, logo }` (Simplifies multiple image types).
*   `people_json` (TEXT): JSON blob for Cast/Crew.
*   `genres_json` (TEXT): JSON blob `["Action", "Sci-Fi"]`.
*   `tags_json` (TEXT): JSON blob `{"resolution": "4k"}`.

#### `user_state` (The Soul)
User-specific interaction data.
*   `item_id` (TEXT FK)
*   `user_id` (TEXT): Default 'admin' for MVP.
*   `watched` (INTEGER): 0/1
*   `last_watched_at` (INTEGER)
*   `progress_seconds` (INTEGER): For resume capability (future).
*   *PK*: (`item_id`, `user_id`)

#### `folder_settings` (The Presentation)
Configuration for how to display specific folders.
*   `item_id` (TEXT FK PK)
*   `view_mode` (TEXT): JSON blob storing layout, sort order, grid size, etc.
*   `scrapper_config` (TEXT): JSON blob for `retrieve_children_metadata`, etc.

## 3. Implementation Phases

### Phase 1: Infrastructure
*   Install `better-sqlite3`.
*   Create `src/main/database/client.ts` to handle connection and WAL mode pragma.
*   Create `src/main/database/schema.sql`.

### Phase 2: The Repository Layer
*   Create `src/main/services/repository.service.ts` (Rewrite).
*   **Crucial Change**: This service must map SQL rows back to the `LibraryItem` interface expected by the UI.
    *   *Read*: `SELECT * FROM items LEFT JOIN metadata ...` -> map to object.
    *   *Write*: Deconstruct object -> `UPDATE items ...; UPDATE metadata ...`.

### Phase 3: The Scanner (Filesystem Service)
*   Rewrite `filesystem.service.ts`.
*   **Old Logic**: Recursive function returning a huge nested Object.
*   **New Logic**:
    1.  Start Transaction.
    2.  Walk directory.
    3.  Hash path -> ID.
    4.  `INSERT OR IGNORE` into items.
    5.  Track "seen" IDs.
    6.  After scan, `UPDATE items SET missing=1 WHERE id NOT IN seen_ids`.

### Phase 4: Service Refactoring
*   **`library.service.ts`**: Update traversal methods. "Mark as Watched" can no longer just loop over `node.children`. It must execute: `UPDATE user_state SET watched=1 WHERE item_id IN (SELECT id FROM items WHERE path LIKE ?)` (or use a recursive CTE).
*   **`search.service.ts`**: For MVP, select all searchable columns at startup and feed Fuse.js (same as current behavior).
*   **`metadata.service.ts`**: Update to write to `metadata` table instead of mutating objects.

### Phase 5: Data Migration
*   Create `scripts/migrate_json_to_sqlite.py`.
*   Logic: Read `database.json` -> Iterate Nodes -> SQL Insert.

## 4. Future Architecture & Performance TODOs

These items are not required for the port but are necessary for the app to "grow up."

1.  **Full Text Search (FTS5)**:
    *   *Goal*: Remove `Fuse.js` in the backend.
    *   *Implementation*: Use SQLite's FTS5 virtual table extension.
    *   *Benefit*: Instant search over 100k items without loading them into RAM.

2.  **Recursive Common Table Expressions (CTEs)**:
    *   *Goal*: Efficiently query trees.
    *   *Use Case*: "Get all episode IDs for this Show" or "Calculate total size of folder".
    *   *Why*: Replaces recursive application logic with a single, highly optimized SQL query.

3.  **Cursor-Based Pagination (Virtualization)**:
    *   *Goal*: Support folders with 10,000 files.
    *   *Implementation*: The API shouldn't return `children: LibraryItem[]`. It should return a "window" of items.
    *   *Frontend*: `VirtualList` component needs to be connected to a paginated backend API.

4.  **Dataloader Pattern**:
    *   *Goal*: Solve N+1 query issues.
    *   *Context*: If we need to fetch metadata for 50 items, do one query `WHERE id IN (...)` instead of 50 queries inside a loop.

5.  **Multi-User Support**:
    *   The `user_state` table is designed for this. The backend will need to context-switch based on the requesting `user_id`.

6.  **DB Migration Tooling**:
    *   Move from raw SQL schema files to a lightweight migrator (like `kysely` or a simple custom script) to handle version upgrades (v1 -> v2) automatically.