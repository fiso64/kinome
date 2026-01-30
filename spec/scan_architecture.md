# Spec: Scan Architecture

**Version:** 2.0
**Status:** Proposed
**Related:** `tv_parsing.md`, `metadata_locking.md`, `metadata_decoupling.md`

---

## 1. Abstract

This specification defines the architecture of the scanner, which is responsible for ingesting files from the disk and retrieving metadata. Unlike systems like Jellyfin which mandate a specific folder structure (e.g. `Movies/` and `TV/`), this media server is **"Filesystem-First"**. It respects the user's arbitrary nested folder structure and only applies "Smart Parsing" (TV logic) and "Enrichment" (TMDB) when explicitly enabled or heuristically detected.

## 2. Core Concept: "Retrieve Children Metadata" Gate

The boolean flag `retrieve_children_metadata` (set on a folder) is the **Master Switch** for the scanner. It generally defaults to `false` for root/container folders and `true` for content roots.

*   **IF `retrieve_children_metadata` is FALSE:** The scanner performs a "Dumb Scan". It syncs files and folders to the DB but runs **NO** local analysis (no TV parsing) and fetches **NO** external metadata.
*   **IF `retrieve_children_metadata` is TRUE:** The scanner enables "Smart Features" for the **direct children** of that folder.

### Why?
This prevents the scanner from wasting resources analyzing container folders (e.g., trying to parse a folder named "Action Movies" as a TV Show) or structure indicators (e.g. `S01`) in unexpected places.

### Examples

**Example A: Mixed Root (Flat)**
*   **Structure:** `/Root` contains `/Breaking Bad`, `/Inception`, `/The Wire`.
*   **Config:** `/Root` has `retrieve_children_metadata = TRUE`.
*   **Result:** The scanner analyzes `/Breaking Bad` (identifies as TV) and `/Inception` (identifies as Movie) because their parent (`/Root`) has the gate **OPEN**.

**Example B: Structured Root (Nested)**
*   **Structure:** `/Root` contains `/TV Shows` and `/Movies`.
*   **Config:**
    *   `/Root` has `retrieve_children_metadata = FALSE` (Container).
    *   `/TV Shows` has `retrieve_children_metadata = TRUE`.
    *   `/Movies` has `retrieve_children_metadata = TRUE`.
*   **Result:**
    *   The scanner sees `/TV Shows` as just a folder (does not try to parse it as a show) because `/Root` has the gate **CLOSED**.
    *   The scanner analyzes `/TV Shows/Breaking Bad` (identifies as TV) because its parent (`/TV Shows`) has the gate **OPEN**.

## 3. The "Filesystem-First" Philosophy (vs. Jellyfin)

| Feature | Jellyfin / Emby / Plex | This Server |
| :--- | :--- | :--- |
| **Navigation** | Library-based (Movies, TV). Merges folders. | Folder-based. Drills down into nested structures. |
| **Identification** | "Identify" wizard. Complex. | "Filesystem-First". What you see on disk is what you get. |
| **Metadata** | Top-down. Library type dictates content. | Bottom-up. Each folder can have its own scraper settings. |

This server allows users to mix home videos, unorganized clips, and structured TV shows in the same tree. We do not force a "View" on the user; we simply represent the disk.

## 4. Scan Logic & Constraints

### A. Phase 1: Ingestion & Structural Analysis
The walker iterates every file on disk.

1.  **Basic Ingestion:** (Always Runs)
    *   Every file/folder is upserted to `items`.
    *   Basic stats (size, mtime) are updated.

2.  **Structural Analysis (TV Parsing):** (Conditional)
    *   **Gate:** Logic runs **ONLY** on children of a folder where `retrieve_children_metadata = true`.
    *   **Invariant 1 (TV Show):** A folder can be assigned `media_type = 'tv'` **ONLY IF** its parent has `retrieve_children_metadata = true`.
    *   **Invariant 2 (Season/Episode):** A folder/file can be assigned `media_type = 'season'` or `'episode'` **ONLY IF** one of its ancestors is identified as a TV Show.
    *   **Locking Integration:** Before writing determined numbers, it **MUST** check `spec/metadata_locking.md` (Write Guard).

### B. Phase 2: Enrichment
The enrichment loop finds items with missing or "dirty" metadata.

1.  **Gate:** logic runs **ONLY** on children of a folder where `retrieve_children_metadata = true`.
2.  **Trigger:** It looks for items where:
    *   `media_type` is set (implies Structural Analysis passed).
    *   Any of the **State Flags** (see below) are `false` (or missing).

### C. State Flags & Eager Fetching

The system tracks metadata progress via three computed flags. While these flags allow for partial states, the architecture mandates **Eager Fetching** during Phase 2. We do not wait for user navigation to fetch "deep" data (credits/episodes).

| Flag | Condition | Logic |
| :--- | :--- | :--- |
| `tmdbDetailsFetched` | `items.tmdb_id IS NOT NULL` | Basic details (Title, Overview, Poster) are present. |
| `tmdbCreditsFetched` | `metadata.people_json IS NOT NULL` | Cast & Crew have been populated. |
| `tmdbEpisodesFetched` | `metadata.episodes_json IS NOT NULL` | (TV Only) Season/Episode list is cached. |

**Policy:**
*   When the enrichment loop picks up an item, it MUST attempt to resolve **ALL missing flags** immediately.
*   A "Healthy" item in a metadata-enabled folder should have all applicable flags set to `true`.
*   These flags function as a progress monitor, not a feature toggle for lazy loading.

## 5. Metadata Integrity & Decoupling

Crucially, this architecture supports the **Decoupled Metadata** workflow defined in `spec/metadata_decoupling.md`.

### The Scenario: Changing Episode Numbers
1.  **Initial Scan:** Scanner reads `S01E01.mkv`. DB = `Episode 1`. Title = "Pilot".
2.  **User Edit:** User changes DB to `Episode 2` (implicitly locking it).
    *   DB `episode_number` becomes `2`.
    *   `locked_fields_json` includes `"episodeNumber"`.
    *   `tmdbDetailsFetched` is set to `0` (Dirty).
3.  **Re-Scan (Phase 1):** Scanner sees `S01E01.mkv`. Checks locks. Sees lock. **DOES NOT** overwrite DB with `1`. DB remains `2`.
4.  **Re-Enrich (Phase 2):** Metadata service sees `tmdbDetailsFetched = 0`.
    *   Refetches metadata for `Episode 2` (not 1).
    *   Updates Title to "The Second Episode".
    *   **Result:** The file `S01E01.mkv` is now effectively "Episode 2" in the UI, with correct metadata, despite the filename.