# Spec: Scan Architecture

**Version:** 2.1 (Timestamp Model)
**Status:** Proposed
**Related:** `tv_parsing.md`, `metadata_locking.md`, `metadata_decoupling.md`

---

## 1. Abstract

This specification defines the architecture of the scanner, which is responsible for ingesting files from the disk and retrieving metadata. Unlike systems like Jellyfin which mandate a specific folder structure (e.g. `Movies/` and `TV/`), this media server is **"Filesystem-First"**. It respects the user's arbitrary nested folder structure and only applies "Smart Parsing" (TV logic) and "Enrichment" (TMDB) when explicitly enabled or heuristically detected.

## 2. Core Concept: "Retrieve Children Metadata" Gate

The boolean flag `retrieve_children_metadata` (set on a folder) is the **Master Switch** for the scanner. It generally defaults to `false` for root/container folders and `true` for content roots.

- **IF `retrieve_children_metadata` is FALSE:** The scanner performs a "Dumb Scan". It syncs files and folders to the DB but runs **NO** local analysis (no TV parsing) and fetches **NO** external metadata.
- **IF `retrieve_children_metadata` is TRUE:** The scanner enables "Smart Features" for the **direct children** of that folder.

### Why?

This prevents the scanner from wasting resources analyzing container folders (e.g., trying to parse a folder named "Action Movies" as a TV Show) or structure indicators (e.g. `S01`) in unexpected places.

### Examples

**Example A: Mixed Root (Flat)**

- **Structure:** `/Root` contains `/Breaking Bad`, `/Inception`, `/The Wire`.
- **Config:** `/Root` has `retrieve_children_metadata = TRUE`.
- **Result:** The scanner analyzes `/Breaking Bad` (identifies as TV) and `/Inception` (identifies as Movie) because their parent (`/Root`) has the gate **OPEN**.

**Example B: Structured Root (Nested)**

- **Structure:** `/Root` contains `/TV Shows` and `/Movies`.
- **Config:**
  - `/Root` has `retrieve_children_metadata = FALSE` (Container).
  - `/TV Shows` has `retrieve_children_metadata = TRUE`.
  - `/Movies` has `retrieve_children_metadata = TRUE`.
- **Result:**
  - The scanner sees `/TV Shows` as just a folder (does not try to parse it as a show) because `/Root` has the gate **CLOSED**.
  - The scanner analyzes `/TV Shows/Breaking Bad` (identifies as TV) because its parent (`/TV Shows`) has the gate **OPEN**.

## 3. The "Filesystem-First" Philosophy (vs. Jellyfin)

| Feature            | Jellyfin / Emby / Plex                      | This Server                                               |
| :----------------- | :------------------------------------------ | :-------------------------------------------------------- |
| **Navigation**     | Library-based (Movies, TV). Merges folders. | Folder-based. Drills down into nested structures.         |
| **Identification** | "Identify" wizard. Complex.                 | "Filesystem-First". What you see on disk is what you get. |
| **Metadata**       | Top-down. Library type dictates content.    | Bottom-up. Each folder can have its own scraper settings. |

This server allows users to mix home videos, unorganized clips, and structured TV shows in the same tree. We do not force a "View" on the user; we simply represent the disk.

## 4. Scan Logic & Constraints

### A. Phase 1: Ingestion & Structural Analysis (The Scanner)

The walker iterates every file on disk.

1.  **Basic Ingestion:** (Always Runs)
    - Every file/folder is upserted to `items`.
    - Basic stats (size, mtime) are updated.

2.  **Structural Analysis (TV Parsing):** (Non-Heuristic)
    - **Gate:** Logic runs **ONLY** on children of a folder where `retrieve_children_metadata = true`.
    - **Trigger:** The scanner **no longer guesses** types. It only triggers structural parsing if the folder is **already identified as TV** (`mediaType === 'tv'`) in the database.
    - **Delegation:** This logic is delegated to the centralized `tv-show.service.ts`.
    - **Invariants for Automatic Metadata Assignment:**
        1. **Assignment Gate (Movie/TV):** An item can only receive a `tv` or `movie` type automatically if its parent has `retrieve_children_metadata = true`.
        2. **Season Gate:** A folder can only receive `season` type automatically if its parent is already identified as `tv`.
        3. **Episode Gate:** A file can only receive `episode` type automatically if its parent is identified as `tv` or `season`.
        4. **Structural Sync Restriction:** Structural sync (recursive assignment of seasons and episodes) is **ONLY** run on items already identified as `tv`. It is specifically **NOT** run on items identified as `season` (at the season level) to prevent redundant tree walking and ensure that the parent show remains the single source of truth for the hierarchy.
    - **Locking Integration:** Before writing determined numbers, it **MUST** check `spec/metadata_locking.md` (Write Guard).

### B. Phase 2: Enrichment (The Metadata Service)

The enrichment loop finds items with missing or "dirty" metadata. It delegates the heavy lifting to the **Unified Orchestrator** (see Section 6).

1.  **Gate:** Logic runs **ONLY** on children of a folder where `retrieve_children_metadata = true`.
2.  **Trigger 1 (Identification):** If `tmdb_id` is MISSING.
3.  **Trigger 2 (Refresh & Repair):** If `tmdb_id` is PRESENT but `last_refreshed_at` is NULL.

---

## 5. The Unified Orchestrator: `handleItemUpdate`

To ensure robustness and keep the code DRY, both the **Scanner** (background enrichment) and **Manual Assignment** (user-triggered) must call the same orchestration function.

### A. Orchestration Flow

The function `handleItemUpdate` (residing in `metadata.service.ts`) executes the following pipeline:

1.  **Check Identity:** If `tmdb_id` is missing, run **Identification** (TMDB Search) and apply result labels.
    - **Identity (Gated by Parent Type Hint)**:
        - **If Hint = 'tv'**: Uses the TMDB `/search/tv` endpoint (Fast & Accurate).
        - **If Hint = 'movie'**: Uses the TMDB `/search/movie` endpoint.
        - **If No Hint**: Uses the TMDB `/search/multi` endpoint and filters for movies/TV shows.
2.  **Conditional Enrichment:**
    - **Trigger:** If `last_refreshed_at` is `NULL` (item is "dirty" or newly identified).
    - **Action:** Fetch full details from TMDB (backdrops, logos, genres, credits).
3.  **Structural Sync (TV Only):**
    - **Trigger:** If `mediaType === 'tv'`.
    - **Action:** Delegate to `tvShowService.syncTvShowStructure`. This identifies season folders and episode files.
4.  **Managed Copy (TV/Season Only):**
    - **Trigger:** If `mediaType === 'tv'` or `'season'`.
    - **Action:** Runs `retrieverService.applyTvShowData`. This ensures metadata (including episode titles and posters) is correctly pushed down the hierarchy from the cached show/season results.
5.  **Finalize:**
    - Calculate **Virtual Tags**.
    - Set `last_refreshed_at = Date.now()`.
    - Persist to Database.
    - **Broadcast** changes to the UI.

### B. Invariants

- **Dry Run for Existing Items:** If called on an item that is already identified (`tmdb_id` set) and fresh (`last_refreshed_at` set), the orchestrator may still run **Structural Sync** (Step 3) to ensure hierarchy matches disk, but should skip Step 2 (Network Fetch).
- **Manual Assignment Invalidation:** Manual assignment logic MUST clear `last_refreshed_at` (set to `NULL`) and `tmdb_id` (if changing result) before calling the orchestrator. This "primes" the orchestrator to perform a full repair.
- **Image Cleanup:** When `tmdb_id` changes or is cleared, existing local images (`posterPath`, etc.) MUST be unlinked before the new fetch begins.

## 6. State Model: Identity vs. Freshness

The system does not use boolean "Is Fetched" flags, as these can desynchronize from the actual data (e.g., flag says true, but data is empty due to a crash). Instead, we use two states:

1.  **Identity (`tmdb_id`):** Determines *what* the item is.
    -   **Null:** Needs Identification (Search).
    -   **Set:** Item is Identified.

2.  **Freshness (`last_refreshed_at`):** Determines if the metadata is valid/current.
    -   **Null:** The item is "Dirty". It needs a full metadata fetch (Details + Credits + Images).
    -   **Timestamp:** The metadata state was synchronized at this time. This includes successful identification, refreshing existing data, OR confirming no match exists. Even if fields like `overview` or `credits` are empty, we trust that the fetch occurred and returned no data.

**Policy:**

-   The `last_refreshed_at` timestamp is **ONLY** updated after a *successful*, atomic completion of the fetch routine (Details + Credits + Images + (Seasons + Episodes if TV Show)).
-   If a fetch fails or the server crashes mid-process, the timestamp remains `NULL`. The next scan will automatically retry.

## 7. Metadata Integrity & Decoupling

Crucially, this architecture supports the **Decoupled Metadata** workflow defined in `spec/metadata_decoupling.md`.

### The Scenario: Changing Episode Numbers

1.  **Initial Scan:** Scanner reads `S01E01.mkv`. DB = `Episode 1`. Title = "Pilot".
2.  **User Edit:** User changes DB to `Episode 2` (implicitly locking it).
    - DB `episode_number` becomes `2`.
    - `locked_fields_json` includes `"episodeNumber"`.
    - `last_refreshed_at` is set to `NULL` (Dirty).
3.  **Re-Scan (Phase 1):** Scanner sees `S01E01.mkv`. Checks locks. Sees lock. **DOES NOT** overwrite DB with `1`. DB remains `2`.
4.  **Re-Enrich (Phase 2):** Metadata service sees `last_refreshed_at IS NULL`.
    - Refetches metadata for `Episode 2` (not 1).
    - Updates Title to "The Second Episode".
    - **Result:** The file `S01E01.mkv` is now effectively "Episode 2" in the UI, with correct metadata, despite the filename.