# Spec: Scan Architecture (Two-Phase Model)

**Version:** 2.0
**Status:** Approved
**Related:** `tv_parsing.md`, `metadata_locking.md`

---

## 1. Abstract

This specification defines the "Filesystem-First" architecture of the scanner. It respects arbitrary nested folder structures and only applies "Smart Parsing" (TV logic) and "Enrichment" (TMDB) when explicitly enabled.

To ensure O(1) performance on unchanged structures, the scan process is strictly divided into two decoupled phases:
1.  **Phase 1: Filesystem Sync (Disk → DB)**: Gated by `mtime`. Settles binary existence and structural identity.
2.  **Phase 2: Metadata Enrichment (DB → API)**: Gated by `last_refreshed_at`. Settles stories, artwork, and hierarchy.

---

## 2. Core Variables & State

### A. Structural Fingerprint
For every file and folder, the scanner persists a **Fingerprint** in the `items` table:
- **`path`**: The relative path from the library root (Unique ID).
- **`mtime`**: Filesystem modification time (Primary change signal).
- **`size`**: Byte size (Fast raw stat; non-recursive for folders).
- **`birthtime`**: Creation time.

### B. Control Variables
- **`last_refreshed_at`**: The **Process Completion Marker**. 
    - **NULL**: Initial state or invalidated. Requires Phase 2 enrichment.
    - **SET**: The item has been successfully processed (even if no TMDB match was found).
- **`retrieve_children_metadata` (Gate A)**: Set on a folder. Enables/disables Phase 2 features for immediate children.
- **`process_tv_children` (Gate B)**: Set on a TV Show. Enables/disables structural analysis (S/E parsing) and hierarchy propagation.

---

## 3. Formal Algorithm (Pseudocode)

### Phase 1: Filesystem Sync (`syncDiskToDatabase`)

```js
function syncDiskToDatabase(root):
  upsert_structural_metadata(root) // Ensure root exists and is marked present
  walk(root)

// Phase 1 is a Pre-order Depth-First Search (DFS)
function walk(dir):
  // 1. Initial Gate Check
  if disk.mtime == db.mtime:
    return // O(1) Skip entire branch

  // 2. Process CURRENT Level (Files + Folders)
  for item in disk.children:
    // Syncs: path, size (fast, non-recursive), birthtime, is_missing.
    // NOTE: Does NOT update folder mtime here!
    upsert_structural_metadata(item) 

  // 3. Descend RECURSIVELY into sub-directories
  for item in dir.children:
    if item.is_folder:
      walk(item)

  // 4. Seal the Gate
  db.dir.mtime = disk.mtime
```

### Phase 2: Metadata Enrichment (`enrichDatabase`)

```js
function enrichDatabase():
  // Preprocess: Find all tv shows that have changed structure, and mark them as dirty.
  maybe_dirty_tv_shows = db.query("""
    SELECT * FROM items 
    WHERE (
        (mediaType == 'tv')
        AND (process_tv_children == TRUE) // this flag is true by default for tv shows
    )
  """)

  // Array to store shows that have changed structure AND need re-fetching from TMDB.
  changed_structure_tv_shows = []
  
  for tv_show in maybe_dirty_tv_shows:
    // Our normal tv parsing function (should be able to walk db instead of fs). Analyzes the whole tree, assigns S/E numbers. 
    // Note: Respects locked fields.
    // Note: Marks any changes when any file gets a new S/E number (whether it already had one or not).
    // Does not mark any changes when a file with S/E info is deleted.
    anyChanges = tvShowService.syncTvShowStructure(tv_show) 

    // We only want to further process the show in phase 2 if
    // 1. The structure changed (anyChanges)
    // 2. The show exists on TMDB, so trying to re-fetch metadata is worthwhile.
    // This avoids always re-processing shows that don't exist on TMDB.
    if anyChanges and tv_show.tmdbId IS NOT NULL:
      // Structure changed. DEFINITELY need to reassign metadata to children.
      // LIKELY need to re-fetch cached season/episode metadata from TMDB, and
      // possibly even for the show itself.
      changed_structure_tv_shows.append(tv_show)

  // We select:
  // - All Library Roots (The permanent entry points)
  // - Dirty Movies/Shows/Folders (The content entry points)
  // ALL filtered by Gate A (Must be enabled or be the Root itself).
  dirty_roots = db.query("""
    SELECT * FROM items 
    WHERE (
        // Recall that lastRefreshedAt is SET even for items that have not been found on TMDB.
        // This includes only items which we have never successfully TRIED to find on TMDB.
        (mediaType IN ('movie', 'tv', NULL) AND lastRefreshedAt IS NULL)
        AND (parent.retrieve_children_metadata == TRUE)
    )
  """)
  
  for item in dirty_roots + changed_structure_tv_shows:
    process_root(item)

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
      if item.mediaType == 'tv':
        // It doesn't matter if we invalidate changed children here, because we know that 
        // the entire tv show is new anyways.
        // Note: This function respects locked numbers.
        tvShowService.syncTvShowStructure(item, invalidateIfNeeded = false)
         
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
  
  all_seasons_ok = true
  seasons = db.getSeasons(show.id) // get season folders in the show folder
  
  for season in seasons:
    // Copy metadata from Show Cache -> Season Item
    // This function respects locked fields. If 'title' is locked, it is skipped.
    metadataService.managedCopy(season, show.seasonsAndEpisodesCache)
    
    // Process Episodes
    all_episodes_ok = true
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
