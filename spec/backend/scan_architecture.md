# Spec: Scan Architecture (Two-Phase Model)

**Version:** 2.0
**Status:** Approved
**Related:** `tv_parsing.md`, `metadata_locking.md`

---

## 1. Abstract

This specification defines the "Filesystem-First" architecture of the scanner. It respects arbitrary nested folder structures and only applies "Smart Parsing" (TV logic) and "Enrichment" (TMDB) when explicitly enabled.

To ensure good performance on unchanged structures, the scan process is strictly divided into two decoupled phases:
1.  **Phase 1: Filesystem Sync (Disk → DB)**: Parallelized `stat` crawl. Settles binary existence, filesystem stats, and per-disk identity (`inode` + `device_id`).
2.  **Phase 2: Metadata Enrichment (DB → API)**: Gated by `last_refreshed_at` and structural drift. Settles identity, TV show structure (S/E), and artwork.

---

## 2. Core Variables & State

### A. Structural Fingerprint
For every file and folder, the scanner stores physical observations in `media_locations`:
- **`relative_path`** is the path under the source root.
- **`mtime`**: Filesystem modification time (File-level change signal).
- **`size`**: Byte size (Fast raw stat; non-recursive).
- **`birthtime`**: Creation time.
- **`inode`**: Filesystem-level unique ID (FileID/Index).
- **`device_id`**: Partition/Volume ID (Sourced from `st_dev`).

### B. Control Variables
- **`last_refreshed_at`**: The **Process Completion Marker**. 
    - **NULL**: Initial state or invalidated. Requires Phase 2 enrichment.
    - **SET**: The item has been successfully processed (even if no TMDB match was found).
- **`retrieve_children_metadata` (Gate A)**: Set on a folder. Enables/disables Phase 2 features for immediate children.
- **`process_tv_children` (Gate B)**: Set on a TV Show. Enables/disables structural analysis (S/E parsing) and hierarchy propagation.
- **`is_missing`**: The **Binary Existence Flag**.
    - **0**: found on disk.
    - **1**: missing from disk but its record is preserved due to user edits (Ghost Item).
- **`is_ignored`**: The **Filesystem Suppression Flag**.
    - Set to **1** if the folder (or an ancestor) contains an `.ignore` file.
    - Scanner stops walk at this folder. Prevents discovery/update of children.
- **`is_hidden`**: The **User Preference Flag**.
    - Manual hide from UI. 
    - Like `.ignore`, setting this on a folder stops scanner discovery for that entire branch.

---

## 3. Formal Algorithm (Pseudocode)

### Phase 1: Filesystem Sync (`syncDiskToDatabase`)

Discovery walks one folder at a time and reads supported files in bounded batches.
It records physical paths and stats, skips hidden or ignored branches, and computes
content fingerprints when the cached stats change.

Reconciliation matches known source paths first, then checks inode and device,
shadowing, proven-absent paths on other sources, content fingerprints, and TV
episode identity. It applies the plan in one transaction. Ambiguous candidates
stay separate. A confirmed rename moves its location row and preserves its ID.
Copy-and-delete recovery can attach a new location and retain the old location
for recovery.

A successful scan marks vanished locations missing. Full-library scans defer
this step until every source has been processed. Missing items keep their
metadata, user state, and folder settings until explicitly deleted. An incomplete
scan leaves unobserved locations alone.

### Phase 2: Metadata Enrichment (`enrichDatabase`) 

Invariant: No function in phase 2 walks the filesystem. All data is read from the database.

```js
function enrichDatabase():
  // 1. Preprocess: Find all tv shows that have changed structure, and mark them as dirty.
  changed_structure_tv_shows = []
  maybe_dirty_tv_shows = db.query("""
    SELECT * FROM items 
    WHERE (
        (mediaType == 'tv')
        AND (process_tv_children == TRUE) // this flag is true by default for tv shows
        AND (is_ignored == FALSE)
        AND (is_hidden == FALSE)
    )
  """)
  
  for tv_show in maybe_dirty_tv_shows:
    // Our normal tv parsing function. Analyzes the whole tree, assigns S/E numbers. 
    // Note: Respects locked fields.
    // Note: Marks any changes when any file gets a new S/E number.
    // Does not mark any changes when a file with S/E info is deleted.
    anyChanges = tvShowService.syncTvShowStructure(tv_show) 

    if anyChanges and tv_show.tmdbId IS NOT NULL:
      // Structure changed. DEFINITELY need to reassign metadata to children.
      // LIKELY need to re-fetch cached metadata and possibly even for the show itself.
      changed_structure_tv_shows.append(tv_show)

  // 2. Discovery: Find the logical starting points for Phase 2.
  // We select:
  // - Dirty Movies/Shows/Folders (The content entry points)
  // ALL filtered by Gate A (Must be enabled).
  dirty_roots = db.query("""
    SELECT * FROM items 
    WHERE (
        // Recall that lastRefreshedAt is SET even for items that have not been found on TMDB.
        // This includes only items which we have never successfully TRIED to find on TMDB.
        (mediaType IN ('movie', 'tv', NULL) AND lastRefreshedAt IS NULL)
        AND (parent.retrieve_children_metadata == TRUE)
        AND (is_ignored == FALSE)
        AND (is_hidden == FALSE)
    )
  """)
  
  // 3. The Orchestration Loop
  for item in dirty_roots ∪ changed_structure_tv_shows:
    process_root(item)

  // #2 Maintenance Pass
  // Cleanup and Refresh tasks that don't block the core scan completion.
  maintenancePass()

function maintenancePass():
  verifyImageExistence()  // Check if posters/backdrops still exist on disk
  evaluateVirtualTags()   // Refresh dynamic tags (e.g., "Recently Added")

function process_root(item):
  // ------------------------------------------
  // STEP A: IDENTIFICATION (If unknown)
  // ------------------------------------------
  if item.tmdbId IS NULL:
    // Search TMDB multi endpoint or with type hint if available
    match = metadataService.identify(item, item.mediaType || item.parent.childrenTypeHint || 'multi')
    
    if match:
      item.tmdbId = match.id
      item.mediaType = match.type // 'movie' or 'tv'
      db.save(item)
      
      // TRIGGER: The "Chicken and Egg" Fix
      // We just identified a folder as a TV Show. The files inside are currently 
      // generic (Phase 1 didn't parse them because it didn't know the type).
      // We MUST run structural parsing NOW to generate Episodes before enriching.
      if item.mediaType == 'tv' and item.process_tv_children:
        // Note: This function respects locked numbers.
        tvShowService.syncTvShowStructure(item)
         
    else:
      // No match found. Mark processed to prevent infinite loops.
      // User must use "Fix Match" manually.
      item.lastRefreshedAt = now() 
      db.save(item)
      return

  // ------------------------------------------
  // STEP B: ENRICHMENT (Type Specific)
  // ------------------------------------------
  if item.mediaType == 'movie':
    process_movie(item)
  else if item.mediaType == 'tv':
    process_show(item)

function process_movie(item):
  metadata = tmdb.getMovie(item.tmdbId)
  // Apply metadata respecting Locked Fields
  metadataService.apply(item, metadata) 
  item.lastRefreshedAt = now()
  db.save(item)

function process_show(show):
  // 1. Fetch & Persist Series Level Data
  showMetadata = tmdb.getShow(show.tmdbId)
  metadataService.apply(show, showMetadata)
  
  // 2. Fetch Full Season and Episode Data (The Upstream Cache)
  
  // This downloads raw data for all seasons and all episodes of every season of the show.
  // It acts as the "Source of Truth" for the Managed Copy.
  show.seasonsAndEpisodesCache = tmdb.getSeasonsAndEpisodes(show.tmdbId)

  // 3. The Managed Copy (Downstream Sync)
  // We iterate the DB structure (which reflects the filesystem)
  // and try to "paint" it with metadata from the cache.

  // get season folders in the show folder
  // This can also return a "fake season folder" which is the show itself, if the show has direct children episodes.
  seasons = db.getSeasons(show.id)
  
  for season in seasons: 
    if season.id != show.id: // Do not apply season metadata to the show itself.
      // Copy metadata from Show Cache -> Season Item
      // This function respects locked fields. If 'title' is locked, it is skipped.
      metadataService.managedCopy(season, show.seasonsAndEpisodesCache)
    
    // Process Episodes
    episodes = db.getEpisodes(season.id)
    
    for episode in episodes:
       // Copy metadata from Show Cache -> Episode Item
       metadataService.managedCopy(episode, show.seasonsAndEpisodesCache)
       
       episode.lastRefreshedAt = now()
       db.save(episode)
       
    season.lastRefreshedAt = now()
    db.save(season)

  show.lastRefreshedAt = now()
  db.save(show)
```

## 4. Performance & Reactivity Strategy

### A. SQLite Batching

Reconciliation applies item and location updates in a transaction per source.
Discovery and file sampling run before the transaction to keep filesystem I/O
out of the database write lock.

### B. UI Synchronization (The 10Hz Rule)
The scanner provides real-time breadcrumbs to the UI:
- **Event**: `SCANNER_PROGRESS`.
- **Throttling**: Maximum 1 broadcast every 100ms.
- **Data**: Current relative path, items found so far.

### C. Inode Reliability (Multi-Hardware Policy)
The `(device_id, inode)` tuple is unique only per machine.
- **On Path Conflict**: Path ALWAYS wins.
- **On Identity Conflict**: If two paths claim the same Inode, the most recently seen file is updated, and the old one is marked missing (preventing duplicate DB entries for hard-links).
