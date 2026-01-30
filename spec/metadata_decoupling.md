# Spec: Database Structure & Metadata Decoupling

**Version:** 1.0
**Status:** **Proposed**
**Related:** `scan_architecture.md`, `metadata_locking.md`, `api_rewrite.md`, `tv_parsing.md`

---

## 1. Abstract

This specification defines the database changes required to **decouple structural identity (File/Season/Episode) from content metadata (Title/Overview/Images)**. It addresses the "Stale Metadata" problem where changing an item's episode number leaves it with the old episode's title. It works in tandem with `metadata_locking.md` to ensure user edits are preserved while the system automatically corrects inconsistencies.

## 2. Problem Statement / Motivation

Currently, the `metadata` table is a monolith. The system treats `episode_number` and `title` as a single unit effectively owned by the Scanner.

*   **The "Episode Shift" Bug:** If a user renames `S01E01` (Title: "Pilot") to `S01E02` (manually or via scanner correction), the database records the new number `2`, but the Title remains "Pilot", and the Overview remains the plot of Episode 1.
*   **No Auto-Heal:** The system has no way of knowing that "Episode 2 with Title Pilot" is an invalid state that requires a re-fetch.
*   **Coupling:** A "Full Scan" currently obliterates user changes because it trusts the filename over the database.

## 3. Goals

*   **Separate Concerns:**
    *   **Structure:** `media_type`, `season_number`, `episode_number`, `tmdb_id` (Defines *what* it is).
    *   **Content:** `title`, `overview`, `images_json`, `people_json` (Defines *details* about it).
*   **Automatic Invalidation:** Changing a Structural field must automatically mark the Content as "stale" (`tmdbDetailsFetched = 0`), triggering a background repair.
*   **Respect Locks:** Refer to `metadata_locking.md` for the explicit locking mechanism.

## 4. Technical Design: The "Managed Copy" Model

We adopt a **Managed Copy** architecture. The `metadata` table is the Single Source of Truth for *Reads* (API, FTS), but the `MetadataService` manages *Writes* by copying data from the Parent's cache to the Child, subject to Locking.

### A. The Sources of Truth
1.  **Upstream (The Well):** The **Parent Folder** (Season) holds the raw TMDB data in `seasons_json` / `episodes_json`.
2.  **Downstream (The View):** The **Child Item** (Episode) holds the *effective* metadata in its columns (`title`, `overview`).

### B. The Update Logic (Write Time)
When metadata is refreshed (triggered by a scan or invalidation), the system:
1.  **Reads** the `locked_fields_json` of the Child.
2.  **Fetches** the corresponding data from the Parent's cache (`episodes_json`).
3.  **Writes** to the Child's columns **only if unlocked**.

## 5. Detailed Workflow: Changing an Episode Number

This is the critical "Decoupling" scenario.

### Step 1: User Action (The Trigger)
*   **User:** Renames `S01E01.mkv` (Episode 1) -> `S01E02.mkv` (Episode 2).
*   **Scanner:** Detects the file change.
*   **Action:** Updates `items.name`. Call `updateItem` with new `episodeNumber=2`.

### Step 2: Invalidation (The Dirty Bit)
*   **RepositoryService:** Detects that `episodeNumber` changed (1 -> 2).
*   **Action:** Sets `tmdbDetailsFetched = 0` (Dirty).
*   **Result:** The item is now "structurally valid" (Episode 2) but "content stale" (Still has Episode 1's title/overview).

### Step 3: The Refresh Loop (MetadataService)
The background loop finds the dirty item.

1.  **Check Parent Cache:** Does the Parent (Season 1) have metadata for Episode 2 in `episodes_json`?
    *   **YES:** Proceed to Step 4.
    *   **NO:** (Rare/New Season) Trigger a TMDB Fetch for **Season 1**. Update `episodes_json`. Proceed to Step 4.

2.  **Lock Check:** Read `locked_fields_json` from the Child.
    *   Is `title` locked? NO.
    *   Is `overview` locked? YES (User wrote a custom overview).

3.  **Apply Updates (The Managed Copy):**
    *   `title` = "The Second Episode" (From Parent Cache).
    *   `overview` = *KEEP "My Custom Overview"* (From Child DB).
    *   `season_number` = 1 (From Parent/Structure).
    *   `episode_number` = 2 (From Structure).

4.  **Finalize:** Set `tmdbDetailsFetched = 1`.

### Step 4: Result
*   **API:** Serves "The Second Episode" with "My Custom Overview".
*   **Search:** FTS uses the new title "The Second Episode".
*   **User:** Sees the correct metadata for the new episode number, preserving their custom overview.
