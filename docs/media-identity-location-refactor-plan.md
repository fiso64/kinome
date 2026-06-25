# Media identity/location/entity refactor plan

## Status

Planning document. No implementation has been started here.

This document audits the current media identity model and proposes the clean refactor where Kinome has three core concepts:

1. `MediaItem`: the durable logical thing shown in the library.
2. `MediaLocation`: a physical filesystem occurrence of that item.
3. `MediaEntity`: external/fetched metadata identity and payload.

The goal is not to patch one scanner edge case. The goal is to remove the current conflation between logical media identity and filesystem location.

A second design constraint is that the storage model should not bake the native file-tree UI in as the only possible presentation shape. Kinome's current UI/API should remain file-tree-first, but the core data model should be neutral enough that future read models can present the same library differently without duplicating state or treating one view as a hack.

## Summary

The current `items` table is doing too many jobs. One row currently represents:

- a logical media object in the UI;
- a physical filesystem path;
- the persistent API/cache identity;
- a tree node via `parent_id`;
- metadata ownership via `entity_id`;
- user state ownership via `user_state.item_id`;
- folder setting ownership via `folder_settings.item_id`;
- account visibility ownership via `account_visible_items.item_id`;
- virtual folders via `is_virtual`, `virtual_type`, and `filter_json`;
- scan state via `is_missing`, `is_hidden`, `ignored`, and file stats.

This works while a path is stable. It breaks when the location changes but the logical media object should survive.

The most visible failure is a cross-source move:

1. Source 1 contains a TV show folder.
2. Source 1 shadows the same relative folder in source 2.
3. The folder is moved from source 1 to source 2.
4. A rescan runs.
5. Watch state, metadata edits, folder settings, images, and refresh history do not transfer cleanly.
6. TMDB is refetched and images are downloaded again.

The root cause is that item IDs are generated from `sourceId + relativePath`. That is a location identity, not a media identity.

## Current identity model

`src/main/database/repositories/filesystem.repo.ts` generates item IDs as:

```ts
sha256(`${sourceId}:${relativePath}`)
```

That means these two paths are different items, even if they represent the same show:

```txt
source1/Shows/Foo
source2/Shows/Foo
```

Current schema relationships make that ID the owner of almost everything:

```txt
items.id
  -> user_state.item_id
  -> folder_settings.item_id
  -> account_visible_items.item_id
  -> items_fts.rowid/content identity
  -> image filenames in metadata-processing
  -> playback/cache/API/frontend identity
```

So when a folder moves between sources, Kinome does not see a move. It sees one item disappear and another item appear.

## Why the shadow-promotion bug happens

The scanner is source-local, while the expected behavior is library-global.

Current scan shape:

```txt
for each source in priority order:
  scan source
  reconcile missing items for that source
  build search index
  enrich metadata
```

During the repro:

1. Source 1 no longer has the show.
2. Source 1 reconciliation marks/deletes the old source-1 item before source 2 is reconciled as the replacement.
3. The rename rescue logic only compares missing items against newly discovered items in the same source scan.
4. Source 2 later discovers the show, but its ID is different because `sourceId` changed.
5. Source 2 inserts a fresh item with no previous `entity_id`, `user_state`, `folder_settings`, or image paths.
6. Metadata enrichment treats it as dirty/new and fetches TMDB again.

Shadowing contributes because a lower-priority copy may be invisible to the DB while it is shadowed. But the deeper problem is not shadowing itself. The deeper problem is that the durable identity is attached to the active source/path instead of the logical item.

## Audit findings by subsystem

### Database schema

Current core table:

- `items` stores logical identity, physical path, tree shape, virtual-folder state, scan state, metadata link, and source path data.
- `media_entities` stores TMDB metadata, images, virtual tags, locks, and refresh timestamps.
- `user_state` references `items(id)`.
- `folder_settings` references `items(id)`.
- `account_visible_items` references `items(id)`.
- `items_fts` is keyed by `items.id`.

The current `media_entities` table is only partially an entity table. It also contains item-level concepts:

- field locks;
- user-edited metadata values;
- image paths selected/downloaded for a specific item;
- `last_refreshed_at` used as the item's refresh gate.

If two logical items point at the same `media_entities` row, edits/locks/images/refresh state are shared. That may or may not be intended. The full refactor needs to make this explicit.

### Filesystem scan

`src/main/services/filesystem.service.ts` scans one source at a time.

Important current behaviors:

- IDs are generated from source/path.
- `foundPaths` is a set of item IDs, not stable media identities.
- `newItemsMap` is keyed by inode/device and only used inside the current source scan.
- cleanup is done by source before all sources have been observed.
- shadowing currently prevents lower-priority candidates from participating as normal discovered locations.

This prevents clean cross-source migration.

### Library scan orchestration

`src/main/services/library.service.ts` calls the scan/enrich pipeline per source.

That is too early for destructive reconciliation and metadata refresh. The library should first collect all physical candidates across all sources, compute shadowing and matching, reconcile identities, and only then run metadata enrichment.

### Repository/read model

`src/main/services/repository.service.ts`, `src/main/database/query-builder.ts`, and `src/main/database/repo-definitions.ts` assume one row can provide:

- item identity;
- parent identity;
- source/path/stats;
- metadata fields;
- user state;
- settings;
- virtual-folder filter state.

A full refactor should preserve the public `LibraryItem` shape where useful, but it should become an assembled read model from multiple tables.

### Metadata enrichment

`src/main/services/metadata.service.ts` and `src/main/services/metadata-processing.service.ts` operate on item IDs.

Current image file names use item IDs:

```txt
${item.id}.jpg
${item.id}-backdrop.jpg
${item.id}-logo-...
```

When a cross-source move creates a new item ID, old images are not reused. Metadata also refetches because the new item has no linked entity and no refresh timestamp.

In the target model, media refresh should be based on the durable `MediaItem` and its metadata association, not the active physical location.

### TV show structure

`src/main/services/tv-show.service.ts` updates seasons and episodes by walking the current item tree.

The current tree is filesystem-parent based. Virtual season folders are also persisted as `items` rows.

In the target model, TV shows/seasons/episodes should be logical `MediaItem` rows. Physical files/folders should be `MediaLocation` rows linked to those items. Virtual season folders can still be logical items without locations, or they can be replaced by a pure query/read model. This needs an explicit product decision.

### Virtual folders and grouping

`src/main/services/grouping.service.ts` and `src/main/services/virtualFolders.service.ts` persist virtual folders in `items`.

This actually fits the new model if virtual folders become `MediaItem` rows with no `MediaLocation`. Their filters should target `MediaItem` fields and, when necessary, joined selected-location fields.

### User state

`src/main/database/repositories/user.repo.ts` stores state by `item_id`.

That is correct only if `item_id` is a durable logical ID. It is incorrect while item IDs are source/path-derived.

The target model should keep user state attached to `MediaItem`, not `MediaLocation`.

### Folder settings

`folder_settings.item_id` currently stores both presentation settings and scan/scraper behavior:

- layouts;
- child view settings;
- grouping;
- retrieve-children-metadata;
- children type hints;
- TV child processing.

Most of these are logical item settings and should stay on `MediaItem`.

Some scanner-derived behavior may depend on a physical folder. The refactor should either keep these settings item-level, or split location-level scan rules from item-level presentation rules.

### Account filters

`src/main/services/account-filter.service.ts` stores visibility by item ID and expands visible descendants/ancestors using path and parent relationships.

After the split, account visibility should be keyed by `MediaItem`. Any rules that depend on source/path will need explicit joins to `MediaLocation`. Descendant expansion should use logical `parent_item_id`, not string path prefixes.

### Playback/actions

`src/main/services/playback.service.ts` already treats the stream target as a concrete item ID. `/api/playlist/:id` builds playlist entries from file item IDs, and `/api/stream/:id/:filename` streams that file item by resolving its stored source/path.

The frontend mirrors this: `playerLauncherService.playItem(file)` builds a playlist URL from `file.id`; `App.svelte` opens movie files as details but directly plays non-movie files; `ItemDetail.svelte` makes `opensAsFolder` movie files appear as a detail page with a synthetic playable child.

Therefore the target model should preserve the current product shape:

- a playable file is its own `MediaItem`;
- a movie folder is also its own `MediaItem` and can have metadata;
- the movie folder's child files remain separate playable `MediaItem`s;
- a `MediaLocation` is the physical occurrence of that exact logical node, not a generic playable alternative for its parent folder.

After the split, playback should continue to receive a file `MediaItem.id` and resolve a present visible `MediaLocation` for that file item. A folder item should not be made playable by choosing one child or one folder location.

### Frontend/API

The frontend heavily uses `item.id` as the cache/navigation/playback key. That can remain true if `item.id` becomes `MediaItem.id`.

The API does not necessarily need a large first-pass shape change. It can continue returning `LibraryItem`, but location fields should be treated as the selected/display location for that same logical item. Longer term, expose a nested location shape:

```ts
item.location       // selected/display location for this item, if any
item.locationsCount
item.isMissing      // derived from locations and/or visible descendants
item.isShadowed     // selected/display state, not logical deletion
```

### Read-model boundary

The current native API is a file-tree read model over the library. That should remain true for this refactor. However, the database should not make the native tree the only semantic hierarchy that can ever be derived.

The important distinction is:

```txt
Core model:
  stable items, physical locations, metadata, relationships, state

Native read model:
  file-tree navigation, selected/display locations, current LibraryItem shape

Future read models:
  may group or expose the same items differently without changing ownership of state
```

Practical implications for this refactor:

- keep `MediaItem.id` as the durable owner of user state, settings, metadata overrides, and images;
- keep playable files as first-class `MediaItem`s, not as opaque media sources hidden inside folder items;
- do not make filesystem parentage the only relationship that can have meaning;
- keep physical path/source facts on `MediaLocation`;
- assemble API shapes from the core model instead of letting API shapes define storage semantics.

This does not require building any alternate API now. It only means the schema and service boundaries should avoid assuming that the native file tree is the only possible representation of the library.

## Target model

### Core concept 1: MediaItem

A `MediaItem` is the durable logical thing in the library.

It should own:

- stable ID used by API/frontend/user state;
- logical parent/child relationship;
- item type or node type;
- virtual-folder fields when applicable;
- metadata association;
- item-level lifecycle state;
- optional preferred/default location reference for compatibility fields.

Suggested table shape:

```sql
CREATE TABLE media_items (
  id TEXT PRIMARY KEY,
  parent_item_id TEXT REFERENCES media_items(id) ON DELETE CASCADE,
  physical_kind TEXT NOT NULL, -- file | folder | virtual
  media_kind TEXT,             -- movie | tv | season | episode | video | collection | folder | etc.
  name TEXT NOT NULL,
  entity_id TEXT REFERENCES media_entities(id) ON DELETE SET NULL,

  is_virtual INTEGER NOT NULL DEFAULT 0,
  virtual_type TEXT,
  filter_json TEXT,

  is_hidden INTEGER NOT NULL DEFAULT 0,
  logical_missing INTEGER NOT NULL DEFAULT 0,
  preferred_location_id TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Notes:

- `logical_missing` can also be derived from locations and/or visible descendants instead of stored.
- `preferred_location_id` is optional admin/default preference for this exact item. It is not the same as account-aware selected/display location.
- Selected/display location should usually be derived in the read model from present locations, account visibility, source priority, and shadow rules. A single stored selected location cannot represent all accounts.
- The existing public `LibraryItem.id` should map to `media_items.id`.

### Core concept 2: MediaLocation

A `MediaLocation` is one physical filesystem occurrence.

It should own:

- source;
- relative path;
- filesystem stats;
- scan presence/missing state;
- physical hidden/ignored state;
- shadow state;
- link to the logical media item.

Suggested table shape:

```sql
CREATE TABLE media_locations (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- file | folder

  size INTEGER,
  mtime INTEGER,
  birthtime INTEGER,
  inode TEXT,
  device_id TEXT,
  location_fingerprint TEXT,

  is_present INTEGER NOT NULL DEFAULT 1,
  is_ignored INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  is_shadowed INTEGER NOT NULL DEFAULT 0,
  shadowed_by_location_id TEXT REFERENCES media_locations(id) ON DELETE SET NULL,

  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  missing_since INTEGER,

  UNIQUE(source_id, relative_path)
);
```

Notes:

- `is_shadowed` is a location display/selection property. It must not delete or invalidate the logical item.
- A lower-priority location should be allowed to exist while shadowed.
- A missing high-priority location should not destroy or detach the logical item if another location can be promoted.

### Core concept 3: MediaEntity

A `MediaEntity` is external metadata identity and fetched metadata.

Target semantics must be decided. The cleanest long-term split is:

```txt
media_entities
  canonical provider/fetched metadata identity

media_item_metadata
  item-specific selected/edited values, locks, images, refresh state
```

That introduces a support table beyond the three core concepts, but it keeps the three core concepts clean. Without this split, `MediaEntity` cannot safely be shared across multiple `MediaItem`s without accidentally sharing user edits and image choices.

Suggested canonical table shape:

```sql
CREATE TABLE media_entities (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,      -- tmdb
  provider_id TEXT NOT NULL,
  media_type TEXT,
  canonical_title TEXT,
  canonical_payload_json TEXT,
  fetched_at INTEGER,
  UNIQUE(provider, provider_id, media_type)
);
```

Suggested item-specific metadata table:

```sql
CREATE TABLE media_item_metadata (
  item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  entity_id TEXT REFERENCES media_entities(id) ON DELETE SET NULL,

  title TEXT,
  original_title TEXT,
  sort_title TEXT,
  overview TEXT,
  poster_path TEXT,
  backdrop_path TEXT,
  logo_path TEXT,
  runtime INTEGER,
  release_date TEXT,
  year INTEGER,
  rating REAL,
  media_type TEXT,
  season_number INTEGER,
  episode_number INTEGER,
  locked_fields_json TEXT,
  last_refreshed_at INTEGER,
  metadata_version INTEGER NOT NULL DEFAULT 0
);
```

If the project insists on exactly three storage tables, then `MediaEntity` must remain item-specific rather than canonical. That is simpler but less conceptually clean.

For this identity/location refactor, canonicalizing `MediaEntity` is not required. It is acceptable to keep `media_entities` item-specific in the first pass, as long as this invariant is explicit:

```txt
Until item-specific metadata tables exist, media_entities must not be shared
by multiple MediaItems.
```

### Support concept: tags and virtual tags

Virtual tags should be item-bound derived facts.

The tag definition remains a filter over the assembled library item:

```txt
mediaType = movie AND genre contains Animation
```

That filter may read fields from item metadata, canonical provider metadata, user state, folder settings, parent fields, and selected-location fields. The computed result should belong to the logical item:

```sql
CREATE TABLE item_virtual_tags (
  item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (item_id, key)
);
```

Filtering by genre still works because genre is an input to rule evaluation, not the owner of the virtual tag result. A genre can come from `media_entities` or `media_item_metadata`; the virtual tag value is still written to the item that matched the rule.

Manual/user tags should probably follow the same rule and live on items. Provider facts such as TMDB genres, cast, studios, ratings, and release data can remain entity/provider metadata.

This is not a precondition for splitting items and locations if `media_entities` stays item-specific. It becomes required if `MediaEntity` becomes canonical/shared, otherwise tags and virtual tags would leak between distinct logical items that happen to share the same TMDB identity.

### Support concept: source roots and tree semantics

The current database persists source roots as `items` rows under the library root. After an item can have multiple locations, source roots need an explicit design decision:

- keep source roots as logical `MediaItem`s for the native file-tree read model;
- make source roots read-model-only containers assembled from locations;
- or keep compatibility source-root items while separating them from semantic library hierarchy.

The important constraint is that `parent_item_id` cannot accidentally mean both "logical parent" and "physical parent in whichever source is selected" when an item has multiple locations. The native file tree can still expose source roots, but the core item relationship should be intentional.

### Support concept: item relationships

The three core concepts should remain `MediaItem`, `MediaLocation`, and `MediaEntity`, but the implementation should leave room for explicit relationships between items. This can start as normal `parent_item_id` plus inferred relationships, but the schema should not make it impossible to add a relation table later.

Useful future relationship roles include:

```txt
contains
primary_playable
alternate_version
part
extra
subtitle
local_artwork
```

For the first implementation, do not overbuild this. The native tree can continue to use `parent_item_id`, and most relationships can be inferred from the current tree. The important decision is architectural: a movie folder and its playable child files are separate logical items, and future read models may interpret that relationship differently without changing where watch state, metadata edits, or physical locations live.

## Required invariants

After the refactor:

1. Moving media between sources must not change `MediaItem.id`.
2. Moving media between paths should create/update `MediaLocation`, not replace `MediaItem`.
3. User state must reference `MediaItem.id`.
4. Folder settings must reference `MediaItem.id`.
5. Metadata edits and locks must survive location changes.
6. Metadata refresh should not run just because the selected/display location changed.
7. Images should be keyed by durable item/metadata identity, not source/path location identity.
8. Shadowing must select visible/display locations, not suppress identity reconciliation.
9. Missing cleanup must run after all sources have been discovered and matched.
10. The public item ID should be stable enough for frontend cache/navigation and durable references.
11. Playable files must remain first-class items; folders with metadata must not absorb their child files as mere locations.
12. Physical kind (`file`/`folder`/`virtual`) and semantic media kind (`movie`/`tv`/`season`/`episode`/etc.) must not be conflated.
13. The native file tree is a read model over the core data, not the only semantic shape that can ever be derived from it.
14. A stored preferred location must not override account-aware location selection.
15. Filesystem actions must resolve an explicit present `MediaLocation`; they must not operate on stale compatibility path fields.
16. If `MediaEntity` is canonical/shared, tags, virtual tags, locks, selected images, and user edits must move to item-specific storage.
17. Source/path filters are location access rules, not content identity rules.
18. Ambiguous location matches must create conflicts or new items rather than silently merging unrelated media.

## Current playback/API model to preserve

Current code has an important product invariant:

- `/api/playlist/:id` accepts an item ID and builds a playlist from that item and its file siblings;
- `/api/stream/:id/:filename` streams by file item ID;
- the renderer launches playback with `playerLauncherService.playItem(file)`;
- movie folders can own metadata while containing multiple individually playable movie files;
- movie file items can open as details via `opensAsFolder`, but the detail page still exposes the same file as the playable child.

The refactor should preserve this. `MediaLocation` is not a substitute for child file items. It represents where a given logical item currently exists. For a movie folder, that means folder locations. For a child movie file, that means file locations.

## Filesystem actions

Playback is not the only code path that needs physical paths. Rename, delete/trash, reveal in explorer, item properties, download, custom actions, local image operations, and subtree rescans all currently resolve `source_id + path` from the item row.

After the split, all filesystem-touching operations should go through one location resolver:

```txt
resolveLocation(itemId, accountId?, operation)
  -> present visible MediaLocation for that exact item
```

The operation matters:

- playback/download need a file location;
- reveal/properties may use a file or folder location;
- rename/delete should decide whether they affect one selected location, all locations, or the logical item plus all locations;
- subtree rescan needs a folder location and should not assume the logical parent has only one physical path.

The first pass can keep UI semantics simple by operating on the selected/display location, but the service boundary should be explicit so multiple-location behavior can be surfaced later.

## Whole-library scan pipeline

The scanner should become a whole-library reconciliation process.

### Phase 1: discover physical candidates

Scan all sources and produce in-memory `DiscoveredLocation` records:

```ts
type DiscoveredLocation = {
  sourceId: string
  relativePath: string
  name: string
  type: 'file' | 'folder'
  size?: number
  mtime?: number
  birthtime?: number
  inode?: string
  deviceId?: string
  childrenFingerprint?: string
  mediaFingerprint?: string
}
```

No logical item should be deleted during this phase.

Each whole-library scan should have a scan run ID or scan token. Locations seen during the run can record `last_seen_scan_id`, which makes it possible to distinguish "confirmed missing after a successful scan" from "not seen because the scan failed, was partial, or the source was offline."

### Phase 2: compute source priority and shadowing

Compute shadowing across all discovered locations.

Rules:

- shadowing is a property of `MediaLocation`;
- lower-priority locations are still recorded;
- only non-empty higher-priority folders should shadow lower-priority folders;
- promotion from shadowed to active should preserve the linked `MediaItem`;
- source priority changes should be treated as selected/display-location changes, not item replacements.

### Phase 3: match locations to existing locations/items

Matching order should be conservative:

1. Exact existing location match: `source_id + relative_path`.
2. Device/inode match, when available and trustworthy.
3. Previous shadowed location promotion for the same logical relative path.
4. Cross-source same relative path match.
5. Folder/content fingerprint match.
6. Parsed media identity match, especially for TV episode sets.
7. New `MediaItem` creation only if no safe match exists.

Matching should record the matched rule and enough confidence/debug information to diagnose decisions. Ambiguous matches must not be silently merged. Examples:

- one old item matches multiple new locations;
- two old items match one discovered location;
- same relative path exists across sources but shadowing does not apply;
- parsed media identity agrees but folder/file fingerprints disagree.

In ambiguous cases, prefer preserving both logical items and reporting a conflict over merging unrelated media.

For TV, folder name alone is weak. Stronger signals include:

- parsed show title/year;
- season/episode keys;
- episode filename set;
- count and relative structure;
- existing TMDB/entity match;
- previously known shadow relation.

### Phase 4: reconcile in one transaction

Once matching is complete:

- insert/update `media_locations`;
- create new `media_items` only for unmatched discoveries;
- link promoted locations to existing items;
- mark vanished locations missing;
- derive item missing state from present locations;
- derive selected/display locations for compatibility fields;
- update logical parent relationships where appropriate;
- rebuild or incrementally update search indexes.

### Phase 5: metadata enrichment

Run metadata enrichment after item/location reconciliation.

Dirty selection should be item/entity based, not source/path based.

A pure location move should not be dirty unless:

- parsed media identity changed;
- user explicitly requested refresh;
- metadata is absent;
- metadata is stale by policy;
- a new logical item was created.

## Migration plan

### Step 0: freeze behavior with tests

Add failing tests before schema migration:

- cross-source move preserves item ID or at least preserves user state/metadata/settings;
- shadowed lower-priority location promotes when high-priority location disappears;
- empty high-priority folder does not shadow non-empty lower-priority folder;
- metadata service is not called for pure location promotion;
- images are reused after promotion;
- folder settings survive promotion;
- account visibility survives promotion;
- current primary-key rename paths do not lose dependent state;
- filesystem actions resolve the promoted selected/display location;
- path/source changes do not rely on stale compatibility fields.

### Step 1: add new schema beside old schema

Add migrations for:

- `media_items`;
- `media_locations`;
- metadata support table if selected;
- new FTS table keyed by `media_items.id`.

Keep the old `items` table during migration or create a compatibility view/read adapter until the service layer is moved.

Before applying the migration to a real library, create a backup or require an explicit backup path. Add migration tests that run against fixture databases, not only fresh schemas.

### Step 2: migrate existing rows

For each existing non-virtual `items` row:

1. Create a `media_items` row.
2. Preserve the old `items.id` as `media_items.id` where possible to avoid immediate frontend/user-state churn.
3. Create a `media_locations` row from old `source_id`, `path`, stats, hidden/ignored/missing state.
4. Link the location to the migrated item.
5. Copy `parent_id` to `parent_item_id` initially.
6. Copy `entity_id` to the item/metadata association.

For virtual `items` rows:

1. Create a `media_items` row with `is_virtual = 1`.
2. Do not create a `media_locations` row.
3. Preserve `filter_json`, `virtual_type`, and `parent_id`.

Then migrate dependent tables:

- `user_state.item_id` continues to point to the preserved `media_items.id`.
- `folder_settings.item_id` continues to point to the preserved `media_items.id`.
- `account_visible_items.item_id` continues to point to the preserved `media_items.id`.
- Rebuild FTS.

Migration should also preserve image files and verify that migrated image paths still resolve. Old source/path-derived IDs may remain as opaque item IDs for existing items; new items should use location-independent IDs.

### Step 3: replace repository assembly

Introduce repositories such as:

- `media-item.repo.ts`;
- `media-location.repo.ts`;
- `media-entity.repo.ts`;
- optional `media-item-metadata.repo.ts`.

`RepositoryService` should assemble the public `LibraryItem` from:

```txt
media_items
LEFT JOIN active media_locations
LEFT JOIN media item metadata/entity
LEFT JOIN user_state
LEFT JOIN folder_settings
```

The public `LibraryItem.id` should be `media_items.id`.

### Step 4: rewrite query builder/search

`query-builder.ts` needs new aliases and field mapping.

Suggested aliases:

```txt
mi = media_items
ml = active media_locations
e  = media_entities
m  = media_item_metadata, if used
u  = user_state
f  = folder_settings
```

Filters should distinguish:

- logical fields: title, media type, watched, virtual tags, parent;
- selected/display-location fields: source, relative path, size, mtime, missing;
- any-location fields: duplicates, source availability, shadowed copies.

The current `media_entities` FTS triggers are not sufficient if metadata can be shared. FTS should be rebuilt/updated per `media_items.id`.

### Step 5: rewrite scanner/reconciliation

Replace source-local reconciliation with the whole-library pipeline described above.

Important changes:

- no per-source deletion before all sources are scanned;
- `foundPaths` becomes found location keys, not item IDs;
- shadowed candidates are persisted as locations;
- rename/move rescue becomes item-location matching across all sources;
- cleanup marks locations missing/tombstoned, not logical items, unless no locations remain and retention policy allows deletion.

### Step 6: update metadata and images

Metadata services should operate on `MediaItem` identity.

Decisions needed:

- image filenames should probably use `media_items.id` or item-specific metadata ID;
- canonical provider images may be cached separately if desired;
- edited/selected images should be item-level;
- moving/promoting a location should not rename or redownload images.

### Step 7: update TV structure logic

TV show logic should produce/maintain logical items for:

- show;
- seasons;
- episodes;
- extras/special folders if supported.

Physical files/folders should be locations linked to those logical items.

Season decision: seasons are first-class logical `MediaItem`s. They may have a physical season-folder `MediaLocation`, or they may be generated from flat episode files and have no direct location. Season identity should be deterministic within a show, e.g. show item plus season number, so a later physical `Season 1/` folder attaches to the existing Season 1 item instead of creating a duplicate.

### Step 8: update playback/actions

Playback should keep the current API semantics: it receives a file `MediaItem.id`, not a folder/entity ID. The stream layer then resolves a present visible `MediaLocation` for that same file item.

For movie folders with multiple movie files, the folder remains a metadata/navigation `MediaItem` and each child file remains individually playable. `opensAsFolder` movie files should keep their current special behavior: the file opens a detail page, and the detail page exposes a synthetic playable child for the same file item.

Resolution policy for file items should consider:

- account-visible locations for that file item;
- source priority among equivalent locations;
- shadow state;
- existence/presence;
- duplicate/moved file locations.

Server-side operations that need filesystem access should resolve the selected/display `MediaLocation` for the exact item being operated on. For playback, that item is a file `MediaItem`. For folder-level scanning or metadata operations, that item may be a folder `MediaItem`. This resolution is separate from playback and must not collapse child files into their parent folder.

Replace direct `getItemSourceId`/`getItemPath` callers with the shared location resolver. This includes playback, download, reveal, properties, rename, delete/trash, custom actions, and subtree rescans.

### Step 9: update account filters

Account filters should write visible `MediaItem.id`s for item-level visibility rules. Source/path allow/deny rules should be evaluated against `MediaLocation`s.

An account can see an item when it has at least one present location visible to that account, or when it is a logical/virtual container with visible descendants. If all present locations are denied and no visible descendants remain, the item is hidden. Inaccessible locations must not shadow accessible locations for that account.

Ancestor/descendant expansion should use logical parent relationships, not path prefixes.

### Step 10: update frontend types gradually

Keep public `item.id` stable as `MediaItem.id`.

Add selected/display-location fields gradually:

```ts
type LibraryItem = {
  id: string
  parentId?: string | null
  sourceId?: string | null       // selected/display location compatibility field
  path?: string | null           // selected/display location compatibility field
  location?: MediaLocationSummary
  locationsCount?: number
}
```

The frontend can mostly stay ID-driven, but anything displaying source/path or acting on files should use selected/display-location semantics.

Compatibility `sourceId` and `path` fields should be treated as read-model fields only. New writes should not update logical item identity by changing these fields.

## Test plan

### Scanner/reconciliation tests

- same-source rename preserves item ID/state/metadata;
- cross-source move preserves item ID/state/metadata;
- source priority swap changes selected/display location but preserves item identity;
- shadowed low-priority location promotes when high-priority disappears;
- empty high-priority folder does not shadow non-empty lower-priority folder;
- missing source does not immediately delete logical items;
- duplicate non-shadowed copies are represented according to the chosen duplicate policy;
- ambiguous match conflicts are not silently merged;
- failed/partial/offline scans do not mark locations as confirmed missing.

### Metadata tests

- pure location move does not call TMDB search/details;
- existing `last_refreshed_at` prevents refetch after move;
- locked fields survive move/promotion;
- selected/custom image survives move/promotion;
- virtual tags remain attached to the logical item/entity as designed;
- if entities are canonicalized, item-specific tags/vtags/locks/images do not leak between items sharing one entity.

### User state/settings tests

- watched state survives cross-source move;
- continue-watching/next-up survives episode location move;
- folder settings survive cross-source folder promotion;
- account visibility survives move/promotion.

### TV tests

- show folder promotion preserves show entity and episode watch state;
- episode files moved between sources relink to same logical episodes;
- virtual/real season representation stays stable;
- extras folders do not get incorrectly merged with show seasons.

### API/frontend tests

- `GET /items/:id` still works after location changes;
- stream endpoint resolves the promoted location for the same file item;
- navigation/breadcrumbs use logical parentage;
- search returns one logical item unless duplicate policy says otherwise;
- download/reveal/properties/rename/delete/custom actions resolve locations through the shared resolver;
- source/path compatibility fields are derived from selected/display location;
- path normalization and case sensitivity behave consistently on Windows, macOS, and Linux.

### Migration tests

- old fixture databases migrate without losing user state, folder settings, account visibility, metadata, images, or virtual folders;
- migrated image paths resolve and no unnecessary image redownload is triggered;
- old path-derived item IDs remain usable as opaque public IDs;
- foreign keys and FTS rows point at `MediaItem.id` after migration;
- migration can be run only after a backup path is available or explicit backup policy is satisfied.

## Resolved design decisions and implementation notes

### 1. Is `MediaEntity` canonical or item-specific?

If `MediaEntity` is canonical TMDB data, user edits/locks/images/refresh state need an item-specific support table.

If `MediaEntity` remains item-specific, the model is simpler but less clean, and duplicate items cannot share canonical fetched metadata safely.

Recommendation: canonical `MediaEntity` plus item-specific metadata/override table.

### 2. What is the duplicate policy?

When two sources contain the same movie/show, should Kinome create:

- one `MediaItem` with multiple `MediaLocation`s; or
- two `MediaItem`s linked to the same `MediaEntity`?

Decision: merge only when locations are alternative occurrences of the same library node, not merely because they share a TMDB match.

Same `MediaItem`:

- exact shadow-equivalent path across sources;
- shadow promotion after a high-priority location disappears;
- confirmed move/rename by inode/device or strong folder/file fingerprint;
- same relative path across sources when shadowing applies.

Different `MediaItem`s:

- same TMDB movie/show in different logical folders;
- 4K vs 1080p folders;
- director's cut vs theatrical cut;
- backup copy in a non-shadow-equivalent structure.

Different logical items may still link to the same canonical `MediaEntity`, with separate item-specific metadata/override rows.

### 3. What is item-level vs location-level hidden/ignored state?

Decision: split this by ownership.

Location-level:

- `.ignore` files;
- scanner exclusions;
- physical path/source rules;
- shadowing;
- hidden state caused by a specific location being unavailable or suppressed.

Item-level:

- user-facing "hide this movie/show/folder" behavior;
- logical visibility rules that should survive moves;
- virtual-folder visibility.

The current `is_hidden` and `ignored` flags are both on `items`; migration must map them carefully rather than copying both to the same target layer blindly.

### 4. How should missing/offline sources behave?

Decision: rescan may mark locations unavailable, but normal rescan should not destroy user-owned logical state.

A disappeared location should become missing immediately. If the item has another present visible location, the item remains available. If it has zero present locations, the item becomes missing/unavailable while preserving metadata, watch state, edits, images, and folder settings.

Start with explicit cleanup only. If automatic cleanup is later added, it should be conservative and require a retention window plus proof that the source was successfully scanned after the location disappeared. Logical item deletion should require zero present locations and no preserved user state, locks, manual matches, custom artwork, or child state.

### 5. What are seasons in the target model?

Decision: seasons are first-class logical `MediaItem`s, preserving the current freedom around metadata, folder settings, layouts, locks, and images.

A season item may have:

- a physical season-folder `MediaLocation`;
- no direct location, when it is generated from flat episode files;
- child episode `MediaItem`s whose physical locations may sit directly under the show folder.

Season identity should be deterministic within a show, e.g. show item + season number. If episodes first create a virtual Season 1 and a physical `Season 1/` folder appears later, the folder should attach as a location to the existing Season 1 item rather than creating a duplicate season.

### 6. What owns image files?

Options:

- item-owned images: stable across moves, good for edits;
- entity-owned images: shared provider cache, good for deduplication;
- both: provider cache plus item-selected image.

Recommendation: item-owned selected images, optional provider cache later.

### 7. Should old IDs be preserved?

Preserving existing `items.id` as `media_items.id` makes migration safer for frontend caches, user state, and API references. The old value may still look like a source/path hash, but it can become opaque.

New items should use a location-independent ID.

### 8. How should selected/display location be chosen?

Decision: selected/display location is a compatibility/read-model choice for the exact item being read or operated on. It is not a statement that a folder item has absorbed its playable children.

Selection should be deterministic and account-aware:

- filter to present locations for the same `MediaItem`;
- filter to locations visible to the current account, when applicable;
- ignore shadowing from inaccessible locations;
- sort by source priority and shadow rules;
- prefer non-empty higher-priority folders only when they are actually present;
- optionally allow an explicit user/admin preference later.

For playback, the requested item is a file `MediaItem`, so the selected location is a concrete file path for that same file item. Movie/show/season folders with metadata are not reduced to single playable locations. Their child files remain separate playable items.

### 9. How should account filters interact with multiple locations?

Decision: source/path allow/deny rules are location-level access controls, not content blacklists.

An account can see an item when at least one of these is true:

- the item has a present location visible to that account;
- the item is a logical/virtual container with visible descendants.

If an item has locations in source A and source B, and the account denies source A only, the source B location can still make the item visible and playable. If all present locations are denied and no visible descendants remain, the item is hidden.

Location selection for compatibility fields and streaming should be account-aware: choose the highest-priority present location visible to that account. Inaccessible locations should not shadow accessible ones for that account.

### 10. Are source roots logical items?

Decision needed before implementation.

Current source roots are persisted `items` rows under the library root. In the target model, source roots may be logical `MediaItem`s for the native tree, read-model-only containers, or temporary compatibility items. Do not let this happen accidentally through migration. The chosen model determines how root browsing, breadcrumbs, account filters, and source priority changes behave.

### 11. What owns virtual tags and manual tags?

Recommendation: virtual tags and manual/user tags should be item-bound. Their definitions are still filters over assembled library items, so they can depend on genre or other metadata fields. The result belongs to the item that matched.

This is not a prerequisite for the item/location split while `media_entities` remains item-specific. It becomes required if `MediaEntity` becomes canonical/shared.

### 12. What is metadata canonicalization?

Metadata canonicalization means changing `MediaEntity` from "this item's metadata record" into "one shared provider identity and fetched payload for a real-world thing," such as `tmdb/movie/603`.

Canonical provider data can be shared:

- provider IDs;
- canonical fetched title/overview/release fields;
- provider genres/cast/crew/studios/ratings;
- raw provider payload and fetched timestamp.

Item-specific data should not be shared:

- title/metadata overrides;
- locks;
- selected/custom images;
- manual tags and virtual tags;
- item refresh state if it controls this item's enrichment;
- season/episode overrides.

The first pass may keep `media_entities` item-specific. If canonicalization is done during this refactor, item-specific metadata/tag tables must be introduced at the same time.

### 13. How should filesystem actions resolve paths?

Decision: all filesystem-touching operations should resolve a `MediaLocation` through a shared resolver. Compatibility `path` and `sourceId` fields are read-model output, not write authority.

Initial behavior can operate on the selected/display location. Longer term, actions that can affect data loss, such as delete/trash and rename, may need UI support for "this location" vs "all locations" vs "logical item."

### 14. How should scan presence be proven?

Decision: use a scan run ID or equivalent token. Mark a location missing only when the relevant source/scope was successfully scanned and the location was not seen. Do not treat failed, partial, skipped, offline, or unauthorized scans as proof of disappearance.

### 15. How should paths be normalized?

Decision needed before matching logic lands.

Normalize relative paths consistently, including separators, dot segments, Unicode normalization where practical, and platform case behavior. Windows and many macOS volumes are case-insensitive; Linux usually is not. Matching should avoid creating duplicate logical items from casing-only path changes on case-insensitive sources.

### 16. How should migration be operated?

Decision: treat this as a high-risk migration. Use fixture DB tests, validate foreign keys/FTS/image paths, and require a backup policy before migrating a real library.

The current code sometimes changes primary keys to rescue renames. The target model should retire that as normal behavior, but tests should preserve the dependent-state guarantees it currently tries to provide.

### 17. How should ambiguous matches be handled?

Decision: ambiguous matches should not silently merge. Keep separate items or create a conflict state that can be inspected/resolved. Strong matches such as exact location, trustworthy inode/device, prior shadow relation, or strong folder/file fingerprint can auto-link; weak matches such as title-only or TMDB-only should not.

## Recommended implementation order

1. Finalize the schema details for the resolved decisions above, especially metadata ownership, item/location hidden state, and account-aware location selection.
2. Add schema migrations and compatibility read assembly.
3. Migrate existing rows while preserving public item IDs.
4. Move user state/settings/account visibility to `MediaItem` semantics.
5. Rewrite scanner as whole-library discovery/reconciliation.
6. Update metadata/image code to use durable item identity.
7. Update query builder/search/account filters.
8. Update TV structure and virtual folder logic.
9. Run regression suite and add cross-source/shadow-promotion coverage.
10. Remove old `items` compatibility paths only after API/frontend behavior is stable.

## Outlook

This refactor is intentionally not an external-API project. The useful future-facing outcome is narrower: once logical items, physical locations, metadata, relationships, and state are separated cleanly, Kinome can keep its native file-tree UI while still allowing other read models to be assembled from the same state later.
