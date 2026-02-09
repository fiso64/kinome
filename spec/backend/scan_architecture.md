# Spec: Scan Architecture (Two-Phase Model)

**Version:** 2.0
**Status:** Approved
**Related:** `tv_parsing.md`, `metadata_locking.md`

---

## 1. Abstract

This specification defines the "Filesystem-First" architecture of the scanner. It respects arbitrary nested folder structures and only applies "Smart Parsing" (TV logic) and "Enrichment" (TMDB) when explicitly enabled.

To ensure O(1) performance on unchanged structures, the scan process is strictly divided into two decoupled phases:
1.  **Phase 1: Filesystem Sync (Disk → DB)**: Parallelized `stat` crawl. Settles binary existence, filesystem stats, and per-disk identity (`inode` + `device_id`).
2.  **Phase 2: Metadata Enrichment (DB → API)**: Gated by `last_refreshed_at` and structural drift. Settles identity, TV show structure (S/E), and artwork.

---

## 2. Core Variables & State

### A. Structural Fingerprint
For every file and folder, the scanner persists a **Fingerprint** in the `items` table:
- **`path`**: The relative path from the library root (Persistent Identifier).
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

```js
// We define explicit limits for the scan process.
// These are tuned for performance on HDDs.
FOLDER_LIMIT = 1
CHILDREN_BATCH_SIZE = 50

// Phase 1: Global Queue manages FOLDERS (Best for HDD & Memory)
async function syncDiskToDatabase(root):
  foundPaths = new Set()
  
  // OPTIMIZATION: Use a Map for O(1) lookup in Phase 2
  // Key: `${device_id}_${inode}`, Value: ItemData
  newItemsMap = new Map() 
  
  queue = createConcurrencyQueue(limit: FOLDER_LIMIT)
  
  queue.push(root)

  await queue.process(async (currentDir) => {
    // 1. Get all entries (Files and Folders)
    entries = await fs.readdir(currentDir, { withFileTypes: true })
    
    // 2. CHECK FOR SUPPRESSION (System .ignore OR User is_hidden)
    hasIgnoreFile = entries.some(e => e.name === '.ignore')
    isUserHidden = db.getIsHidden(currentDir)

    if (hasIgnoreFile || isUserHidden):
       // Mark this folder state and STOP walking subfolders.
       // IMPLEMENTATION DETAIL: This is the AUTHORITATIVE write for this folder.
       db.updateFingerprint(currentDir, { is_ignored: hasIgnoreFile, is_hidden: isUserHidden, is_missing: 0 })
       foundPaths.add(generateId(currentDir))
       return 

    // 3. PROCESS CHILDREN (Files and Subfolders)
    for (let i = 0; i < entries.length; i += CHILDREN_BATCH_SIZE) {
      const batch = entries.slice(i, i + CHILDREN_BATCH_SIZE)
      
      await Promise.all(batch.map(async (entry) => {
        // Every entry (File or Folder) must be stat-ed to reconcile its identity
        const stats = await fs.stat(entry)
        const itemData = { 
          path: entry.relative_path, 
          inode: stats.ino, 
          device_id: stats.dev,
          // IMPLEMENTATION DETAIL (Suppression Race): 
          // During discovery, we do not know the authoritative suppression status yet.
          // We must use 'null' so that the subsequent deferred bulk sync (#3) 
          // does not clobber the authoritative status set by Step #2.
          is_ignored: entry.isDirectory ? null : 0, 
          is_hidden: entry.isDirectory ? null : 0,
          ...stats 
        }
        
        // RECONCILIATION
        if db.existsByPath(itemData.path):
            // EFFICIENCY: Batch UPSERTs to bypass IPC/Transaction overhead.
            // Flushes every 500 items OR every 1000ms.
            fingerprintBuffer.add(itemData)
            foundPaths.add(generateId(itemData.path))
        else:
            // Store in Map for fast lookup during Rename Rescue
            key = `${itemData.device_id}_${itemData.inode}`
            newItemsMap.set(key, itemData)

        // If it's a folder, push to queue for recursive traversal
        if (entry.isDirectory):
           queue.push(entry.fullPath)
      }))
    }
  })
  // --- RECONCILIATION PHASE ---
  
  // 1. Flush remaining fingerprints (the buffer ensures O(N) throughput)
  fingerprintBuffer.flush()

  // #1 Missing Item Detection
  missingItems = db.getPresentItemsInScope(root.path).where(id => !foundPaths.has(id))
  
  // #2 Identity-Based Rename Rescue (O(N))
  for item in missingItems:
    key = `${item.device_id}_${item.inode}`
    match = newItemsMap.get(key) // Instant Lookup
    
    if match:
      db.migrateRecord(oldId: item.id, newId: match.id, newPath: match.path)
      foundPaths.add(match.id) 
      newItemsMap.delete(key) // Remove to prevent duplicate insertion
      continue

  // #3 Final Sync (Insert whatever is left in the map)
  if (newItemsMap.size > 0):
      // IMPLEMENTATION DETAIL: This must use COALESCE(excluded.is_ignored, is_ignored) 
      // to ensure discovery-time 'null' values do not overwrite authoritative worker states.
      db.bulkInsert(newItemsMap.values())

  // #4 Conditional Cleanup
  for item in missingItems (where not rescued):
    if item.has_locked_fields:
      db.markAsMissing(item.id) 
    else:
      db.delete(item.id)
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

### A. SQLite Batching (The 500/1 Rule)
To prevent SQLite from becoming the bottleneck (and to avoid losing all progress on a crash):
- **Buffer Size**: 500 operations.
- **Flush Interval**: 1,000ms (via `setTimeout`).
- **Phase 1 Bypass**: Fingerprint updates in Phase 1 MUST use raw SQL (`db.prepare().run()`) and bypass the `ItemUpdateService` to avoid comparison/broadcasting overhead.

### B. UI Synchronization (The 10Hz Rule)
The scanner provides real-time breadcrumbs to the UI:
- **Event**: `SCANNER_PROGRESS`.
- **Throttling**: Maximum 1 broadcast every 100ms.
- **Data**: Current relative path, items found so far.

### C. Inode Reliability (Multi-Hardware Policy)
The `(device_id, inode)` tuple is unique only per machine.
- **On Path Conflict**: Path ALWAYS wins.
- **On Identity Conflict**: If two paths claim the same Inode, the most recently seen file is updated, and the old one is marked missing (preventing duplicate DB entries for hard-links).
