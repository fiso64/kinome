# Spec: Manual Assignment (Fix Match)

**Version:** 1.0
**Status:** Implemented
**Related:** `scan_architecture.md`, `metadata_locking.md`

---

## 1. Abstract

Manual Assignment (the "Fix Match" workflow) provides a mechanism for users to explicitly define a media item's identity, overriding the system's automated heuristic detection. This is the primary tool for resolving ambiguous identification, corrected misidentified content, or enforcing specific structural mappings (like re-indexing a folder's season offset).

## 2. Problem Statement / Motivation

While the system is "Filesystem-First" and leverages robust automated scrapers, no heuristic is perfect. Ambiguity in filenames, multiple releases with similar titles, or unconventional library organization can lead to incorrect metadata. 

Users need a way to:
- **Correction**: Fix an item that was identified as the wrong movie or TV show.
- **Ambiguity**: Select a specific version of a movie (e.g., 1939 vs 2024 version).
- **Structural Override**: Map physical folders to specific metadata identities that differ from their naming conventions on disk.

In all cases, the manual decision must be **atomic** (metadata across the hierarchy should update) and **durable** (automated background tasks should not revert the user's manual choice).

## 3. Goals and Non-Goals

### Goals
- **Clean Slate Implementation**: Ensure that changing a match completely replaces old metadata and images to prevent data leakage between different titles.
- **Hierarchical Consistency**: Automatically propagate identity changes from parents to children (e.g., changing a Show's identity updates all its episodes).
- **Durability**: Prevent the scanner/structural sync from overwriting manual assignments during subsequent scans.
- **Unified Logic**: Reuse the standard `fetchAndApplyMetadata` pipeline to ensure manual matches follow the same robust enrichment path as automated matches.

### Non-Goals
- Individual leaf-node field edits (e.g., manual title rename) are covered by `metadata_locking.md`.
- Search result ranking and API implementation details.

## 4. Technical Design

Manual assignment is implemented as a state-transition pipeline that "primes" an item and then lets the **Unified Orchestrator** finalize the work.

### 4.1 Phase 1: Targeted Metadata Clearing
To prevent data leakage between different identities, the existing metadata and images must be reset.

- **Operation**: Call `clearItemMetadata(itemId, { targetedClear: true })`.
- **Logic**: Resets all metadata fields and deletes images for the target item. 
    - If target is a **TV Show**, it also resets its direct seasons and episodes.
    - If target is a **Season**, it also resets its direct episodes.
- **Scope**: Shallow; no further recursion is performed.

### 4.2 Phase 2: Identity Application & Persistence
The new identity (provided by the user via the Search UI) is applied.

1.  **Identity Mapping**: Apply the new `tmdbId` and `mediaType`.
2.  **Numbering Binding**: Apply specific indices (e.g., `seasonNumber`) if the result is a sub-item (Season/Episode).
3.  **Defensive Locking**:
    - **ID Lock**: The `tmdbId` is added to `lockedFields`. This signals to the scanner that it should never attempt to re-identify this item.
    - **Structural Lock**: If a structural property (like `seasonNumber`) is manually assigned, it is also added to `lockedFields`. This prevents naming-based sync logic (e.g., `syncTvShowStructure`) from reverting the number to match the filesystem name.

### 4.3 Phase 3: Orchestration & Finalization
The item (now "dirty" and "identified") is passed to `fetchAndApplyMetadata`.

1.  **Enrichment**: The orchestrator sees the new `tmdbId` and `lastRefreshedAt: null`. It fetches new images, overviews, and credits.
2.  **Structural Integrity**: For TV items, it runs a structural scan. 

    > [!IMPORTANT]
    > **Season Update Propagation**: If a **Season** is manually matched, the system **MUST** save the identity/locks to the database and then trigger a structural sync on the **Parent TV Show**. This is required because `syncTvShowStructure` only runs at the show level and needs the locked season identity in the DB to correctly re-number child episodes.

3.  **Managed Copy**: Pushes the new metadata down the hierarchy.
4.  **Atomic Broadcast**: Returns all changed items to the UI.

## 5. Implementation Example: The Filename Conflict

**Scenario**: A folder named `S01` actually contains "Breaking Bad Season 5".
1.  **User Search**: Selects "Breaking Bad: Season 5" from the search results.
2.  **Application**:
    - The `tmdbId` for Season 5 is set.
    - The `seasonNumber` is set to `5`.
    - Both `tmdbId` and `seasonNumber` are added to `lockedFields`.
3.  **Resolution**: During the next sync, the system sees the folder name is `S01` (Parsing would result in `1`), but since `seasonNumber` is **locked**, the system preserves `5`. Consequently, episodes are correctly matched to Season 5 data instead of Season 1.

## 6. Edge Cases

- **"Fix Match" to No Match**: If a user clears a match, the `tmdbId` remains null and the field is locked. This identifies the item as "Manual Unmatch", preventing the scanner from trying to identify it again.
- **Hierarchy Rebranding**: When a parent Show's identity is changed, the manual assignment logic must ensure all children are also cleared and their `lastRefreshedAt` timestamp reset, forcing a branch-wide metadata update.
