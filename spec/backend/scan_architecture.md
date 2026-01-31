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
    - **Invariant 1 (TV Show):** A folder can be assigned `media_type = 'tv'` **ONLY IF** its parent has `retrieve_children_metadata = true`.
    - **Invariant 2 (Season/Episode):** A folder/file can be assigned `media_type = 'season'` or `'episode'` **ONLY IF** its ancestor is identified as a TV Show.
    - **Locking Integration:** Before writing determined numbers, it **MUST** check `spec/metadata_locking.md` (Write Guard).

### B. Phase 2: Enrichment (The Metadata Service)

The enrichment loop finds items with missing or "dirty" metadata.

1.  **Gate:** Logic runs **ONLY** on children of a folder where `retrieve_children_metadata = true`.
2.  **Trigger 1 (Identification - Atomic Sync):** Identification is a **single-path atomic event** for all media types:
    -   **Identity (Gated by Parent Type Hint)**:
        -   **If Hint = 'tv'**: Uses the TMDB `/search/tv` endpoint (Fast & Accurate).
        -   **If Hint = 'movie'**: Uses the TMDB `/search/movie` endpoint.
        -   **If No Hint**: Uses the TMDB `/search/multi` endpoint and filters for movies/TV shows.
    -   **Enrichment**: Immediately call `/movie/{id}` or `/tv/{id}` to fetch full details (Backdrops, Logos, Genres, Credits). This ensures **"First-Scan Parity"** for both movies and TV shows.
    -   **Structural Re-sync (TV Only)**: Immediately trigger `tvShowService.syncTvShowStructure` after details are fetched (required for season/episode hierarchy).
3.  **Trigger 2 (Refresh & Repair):** A secondary pass looks for items that are "Identified" (`tmdb_id` is present) but "Stale" or "Corrupt".
    -   **Condition:** `last_refreshed_at` is `NULL`.
    -   **Logic:** This indicates a previous fetch failed, crashed, or the item was manually invalidated by a user edit. The system must attempt to re-fetch details, credits, and images.

### C. State Model: Identity vs. Freshness

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

## 5. Metadata Integrity & Decoupling

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