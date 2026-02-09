# Spec: Scan Architecture (Two-Phase Model)

**Version:** 2.0
**Status:** Approved
**Related:** `tv_parsing.md`, `metadata_locking.md`

---

## 1. Abstract

This specification defines the "Filesystem-First" architecture of the scanner. It respects arbitrary nested folder structures and only applies "Smart Parsing" (TV logic) and "Enrichment" (TMDB) when explicitly enabled.

To ensure O(1) performance on unchanged structures, the scan process is strictly divided into two decoupled phases:
1.  **Phase 1: Filesystem Sync (Disk → DB)**: Gated by `mtime`. Settles binary existence and basic filesystem stats (Fingerprint).
2.  **Phase 2: Metadata Enrichment (DB → API)**: Gated by `last_refreshed_at` and structural drift. Settles identity, TV show structure (S/E), and artwork.

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
- **`is_missing`**: The **Binary Existence Flag**.
    - **0**: The item was successfully found on disk during the latest scan.
    - **1**: The item is missing from disk but its record is preserved due to user edits (Ghost Item).

---

## 3. Formal Algorithm (Pseudocode)

### Phase 1: Filesystem Sync (`syncDiskToDatabase`)

```js
function syncDiskToDatabase(root):
  upsert_structural_metadata(root) // Ensure root exists and is marked present
  
  visitedIds = new Set()
  walk(root, visitedIds)

  // #1 Missing Item Detection
  // Any item in this root's DB scope that wasn't visited is gone from disk.
  missingItems = db.getItemsInScope(root.path).where(id => !visitedIds.has(id))
  
  for item in missingItems:
    if item.has_locked_fields:
      // Ghost Item: Keep the record (and user edits).
      // Allow the UI to show the item as missing.
      db.markAsMissing(item.id) 
    else:
      // Clean Deletion: No user value in this record, drop it.
      db.delete(item.id)

// Phase 1 is a Pre-order Depth-First Search (DFS)
function walk(dir, visitedIds):
  visitedIds.add(dir.id)

  // 1. Initial Gate Check
  if dir.disk.mtime == dir.db.mtime:
    // O(1) Skip: But we MUST still mark all known descendants as visited
    // to prevent them from being marked missing.
    visitedIds.addAll(db.getAllDescendantIds(dir.id))
    return 

  // 2. Process CURRENT Level (Files + Folders)
  for item in dir.disk.children:
    // Syncs: path, size (fast, non-recursive), birthtime, is_missing.
    // NOTE: Does NOT update folder mtime here!
    upsert_structural_metadata(item) 
    visitedIds.add(item.id)

  // 3. Descend RECURSIVELY into sub-directories
  for item in dir.disk.children:
    if item.is_folder:
      walk(item, visitedIds)

  // 4. Seal the Gate
  // Update the DB mtime ONLY after children are successfully processed.
  dir.db.mtime = dir.disk.mtime
```

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
        AND (last_refreshed_at IS NULL OR mtime > last_refreshed_at) // Optimization: Only analyze structure if the folder itself has been touched since last refresh
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
    )
  """)
  
  // 3. The Orchestration Loop
  for item in dirty_roots + changed_structure_tv_shows:
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
      if item.mediaType == 'tv':
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
  
  all_seasons_ok = true

  // get season folders in the show folder
  // This can also return a "fake season folder" which is the show itself, if the show has direct children episodes.
  seasons = db.getSeasons(show.id)
  
  for season in seasons: 
    if season.id != show.id: // Do not apply season metadata to the show itself.
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
