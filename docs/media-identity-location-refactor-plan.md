# Media identity/location/entity refactor plan

## Status

Implementation status: the media identity/location split is implemented. Item-bound tags/vtags are implemented as part of the tag ownership work tracked in `docs/TODO.md`.

Completed work:

- Added `media_items` and `media_locations`, then removed the legacy `items` table from the current schema.
- Added migration `0002_add_media_items_and_locations` that preserves old public item IDs as `media_items.id`.
- Backfilled one `media_locations` row per legacy non-virtual filesystem item using deterministic `location:${itemId}` IDs.
- Kept `media_entities` as the existing metadata record for an item.
- Added `media_items_read`, a media-table-backed read model that exposes the current legacy-shaped item fields from `media_items` plus the selected `media_locations` row.
- Moved `query-builder.ts` and the core hydrated filesystem repository reads to `media_items_read`.
- Added automatic pre-migration backups for existing on-disk `library.db` files when pending migrations are detected.
- Added an account-aware selected-location resolver backed by `media_items_read`, and moved streaming/actions path resolution to require a present selected `MediaLocation`.
- Moved source/path cleanup queries to `media_locations`, and made cleanup mark individual locations missing before deleting a logical item.
- Made cleanup delete unlocked missing `MediaLocation` rows directly, while preserving the logical `MediaItem` when another present location exists.
- Added explicit scan-success proof so failed, partial, offline, or unreadable scan scopes cannot authorize missing-location cleanup.
- Changed scanner rename/move rescue to preserve the existing `MediaItem.id`, including cross-source moves matched by inode/device while cleanup is deferred.
- Made automatic move/shadow matching conservative: ambiguous inode/device, missing-relative-path, shadow-relative-path, and same-scan fingerprint candidates are not silently merged.
- Replaced first-time source/path-derived IDs for newly discovered child filesystem items with opaque item IDs. Source roots remain stable by source UUID, and old migrated/source-path IDs remain valid as opaque existing item IDs.
- Centralized source-relative path normalization at the repository/service boundary so scanner writes, settings imports, renames, and path lookups use the same location key.
- Changed full-library scans to defer missing-location cleanup until every source has scanned, while allowing targeted metadata enrichment for successfully scanned source results before slower sources finish.
- Changed deferred scan cleanup to track found source-relative locations, not only found item IDs.
- Scanner writes now explicitly upsert `media_items`/`media_locations`; there is no runtime write path to a legacy `items` table.
- Scanner now records a shadowed lower-priority folder candidate as an explicit `MediaLocation` row for the same logical item.
- Scan-time shadowing now uses current-cycle non-empty folder paths before falling back to DB state, avoiding stale deferred-cleanup shadow sets.
- Moved account filter expansion to logical parent/child relationships rather than path-prefix expansion.
- Migrated `user_state`, `folder_settings`, and `account_visible_items` foreign keys to `media_items(id)`.
- Added `media_items_fts`, rebuilt/searches against it, and removed the old `items_fts` index/triggers.
- Added `item_tags` and `item_virtual_tags`, migrated existing entity-owned tag rows to item-owned rows, and moved filtering/search/autocomplete/grouping/vtag writes to the item tables.
- Added migration `0007_drop_legacy_items_table` to drop the old mirror triggers and `items` table after data has been migrated.
- Added migration/read-model tests for existing row preservation, full-chain dependent state preservation, legacy table removal, preferred-location selection, media FTS, foreign-key retargeting, and item-bound tags.
- Added a deterministic scan-order test proving targeted enrichment can run for one completed source before the next source is scanned, without relying on timings.

## User-observable behavior changes

- Existing libraries with pending schema migrations now get an automatic SQLite backup before migration. Backups are written under the database directory's `backups/` folder and include the source and target schema versions in the filename.
- Existing public item IDs are preserved during migration. Old source/path-derived IDs remain valid as opaque IDs, but newly discovered child filesystem items get opaque location-independent IDs instead of predictable `sourceId:path` hashes. Source root IDs remain stable by source UUID.
- The public item shape still exposes `path` and `sourceId`, but those fields now describe the selected/display location for a logical item. They can change when a moved, promoted, or preferred physical location is selected without changing the item ID.
- Same-source renames and safe cross-source moves/promotions now preserve the logical item, so watch state, folder settings, account visibility, metadata links, images, locks, tags, and vtags stay attached when the match is unambiguous.
- Ambiguous physical matches are no longer silently merged. In ambiguous inode/device, missing-relative-path, shadow-relative-path, or same-scan fingerprint cases, Kinome keeps or creates separate items instead of risking state or metadata being attached to the wrong media.
- Shadowed lower-priority folders are recorded as physical locations of the same logical item. When the higher-priority location disappears, the lower-priority location can become the selected/display location without creating a fresh library item.
- Full-library scans defer missing-location cleanup until all sources have been scanned. Targeted metadata enrichment can now run for the successfully scanned source's found item IDs before slower sources finish, while the final whole-library search/metadata maintenance pass still runs after cleanup.
- Failed, partial, offline, or unreadable scans no longer count as proof that locations disappeared. Cleanup only runs for a source or scope that completed successfully.
- Missing cleanup is location-based. A disappeared unlocked location can be removed, but the logical item remains available when another present location exists; locked items are marked missing rather than discarded.
- Playback, streaming, downloads, renames, custom actions, and subtree rescans resolve a present selected location for the exact item being operated on. Missing or inaccessible selected locations now fail as unavailable instead of using stale stored path fields.
- Stream path caching is account-aware, so one account cannot reuse another account's resolved physical path for the same item.
- Account filter expansion now follows logical parent/child relationships instead of string path prefixes. Navigation ancestors/descendants should follow the library tree even when the selected physical location changes.
- Manual tags and virtual tag results are item-bound. They move with the logical item across location changes and are no longer implicitly shared by every item that points at the same metadata row. Genre filtering still works through existing metadata/entity genre data.
- Search and autocomplete use the media-item search index and item-bound tag tables. Results should remain item-shaped, but they now track logical items rather than legacy path rows.
- Source-relative paths are normalized at scan/write/read boundaries, including path separators and `.` segments. Deeper Unicode and case-insensitive-volume behavior remains follow-up hardening.
- Direct database inspection or custom scripts will see `media_items`, `media_locations`, `media_items_fts`, `item_tags`, and `item_virtual_tags` as the durable tables. The old `items` and `items_fts` tables are migration inputs only and are dropped after the migration completes.

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

Pre-refactor schema relationships made that ID the owner of almost everything:

```txt
items.id
  -> user_state.item_id
  -> folder_settings.item_id
  -> account_visible_items.item_id
  -> old items_fts row/content identity
  -> image filenames in metadata-processing
  -> playback/cache/API/frontend identity
```

So when a folder moves between sources, Kinome does not see a move. It sees one item disappear and another item appear.

## Why the shadow-promotion bug happens

The scanner is source-local, while the expected behavior is library-global.

Pre-refactor scan shape:

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

Pre-refactor core table:

- `items` stores logical identity, physical path, tree shape, virtual-folder state, scan state, metadata link, and source path data.
- `media_entities` stores TMDB metadata, images, locks, and refresh timestamps.
- `user_state` references `items(id)`.
- `folder_settings` references `items(id)`.
- `account_visible_items` references `items(id)`.
- `items_fts` was keyed by `items.id`.

The current `media_entities` table is only partially an entity table. It also contains item-level concepts:

- field locks;
- user-edited metadata values;
- image paths selected/downloaded for a specific item;
- `last_refreshed_at` used as the item's refresh gate.

If two logical items point at the same `media_entities` row, edits/locks/images/refresh state are shared. That may or may not be intended. The full refactor needs to make this explicit.

### Filesystem scan

`src/main/services/filesystem.service.ts` scans one source at a time.

Important pre-refactor behaviors:

- IDs are generated from source/path.
- cleanup discovery used item IDs rather than source-relative location keys.
- `newItemsMap` is keyed by inode/device and only used inside the current source scan.
- cleanup is done by source before all sources have been observed.
- shadowing currently prevents lower-priority candidates from participating as normal discovered locations.

Those behaviors prevented clean cross-source migration.

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

The refactor preserves the public `LibraryItem` shape where useful, but assembles it from the media-backed read model instead of treating the legacy row as the source of truth.

Current implementation status: `media_items_read` now provides this legacy-shaped read surface from `media_items` plus a selected `media_locations` row, and `query-builder.ts` plus the main hydrated filesystem repository reads use it. This is a useful boundary because it moves reads onto the new model without changing the API shape in the same step.

Important caveat: the selected-location projection is a compatibility read surface. It prefers `preferred_location_id`, then present non-shadowed locations, then present shadowed locations, then missing locations. Filesystem actions and account-scoped operations use the explicit selected-location resolver rather than treating compatibility path fields as write authority.

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

A `MediaEntity` is the existing metadata record linked from a `MediaItem`. This refactor does not change metadata ownership beyond preserving the item/entity link across location changes and ensuring that metadata refresh/image state follows the durable `MediaItem`, not a source/path-derived row.

### Support concept: tags and virtual tags

Virtual tags should be item-bound derived facts.

The tag definition remains a filter over the assembled library item:

```txt
mediaType = movie AND genre contains Animation
```

That filter may read fields from the existing media/entity relationship, user state, folder settings, parent fields, and selected-location fields. The computed result should belong to the logical item:

```sql
CREATE TABLE item_virtual_tags (
  item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (item_id, key)
);
```

Filtering by genre still works because genre is an input to rule evaluation, not the owner of the virtual tag result. Genre remains read from the existing metadata/entity tables; the virtual tag value is written to the item that matched the rule.

Manual/user tags follow the same rule and live on items. Provider facts such as TMDB genres, cast, studios, ratings, and release data can remain metadata/entity data.

Implemented: `item_tags` and `item_virtual_tags` now exist, existing entity-owned tag rows are migrated by item/entity association, vtag evaluation writes `item_id`, and filtering/search/autocomplete/grouping read the item tables. Genre filtering remains entity-backed, so vtags can still be derived from genre without genre itself becoming item-owned.

### Support concept: source roots and tree semantics

The current implementation keeps source roots as logical `MediaItem`s for the native file-tree read model. Each source root has a present folder `MediaLocation`, while the singleton library root/home nodes are virtual `MediaItem`s without physical locations.

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
16. Source/path filters are location access rules, not content identity rules.
17. Ambiguous location matches must create conflicts or new items rather than silently merging unrelated media.

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

The scanner now behaves as a whole-library reconciliation process for destructive cleanup and maintenance.

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

Each whole-library scan should have a scan run ID or equivalent token. The current implementation uses a successful-scan scoped equivalent: each source reports the relative locations it actually found, full-library scans defer destructive cleanup until all sources have completed discovery, and cleanup only marks locations missing for sources/scopes that were successfully scanned. A persisted `last_seen_scan_id` column can still be added later if Kinome needs offline/partial-source diagnostics beyond the current successful-scope boundary.

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
- new FTS table keyed by `media_items.id`.

Use the old `items` table only as an upgrade input. After migrated data has been copied into `media_items`/`media_locations` and dependent foreign keys have been retargeted, drop the old table and its temporary mirror triggers.

Before applying the migration to a real library, create a backup or require an explicit backup path. Add migration tests that run against fixture databases, not only fresh schemas.

Implemented backup policy: startup now creates a SQLite-consistent backup with `VACUUM INTO` before applying pending migrations to an existing on-disk `library.db`. Backups are written under the library data directory's `backups/` folder with the source and target schema versions in the filename. In-memory test databases and brand-new database files do not create backups.

Implementation note: `media_items`, `media_locations`, `media_items_read`, `media_items_fts`, `item_tags`, and `item_virtual_tags` now exist in the current schema and migrations. Runtime scanner/repository/search/tag paths write or read these tables directly. Migration `0007_drop_legacy_items_table` removes the old `items` table and temporary mirror triggers after the media tables and dependent state tables are in place.

The same step also adds `media_items_read`, a read-model view over `media_items` and `media_locations`. This view is directionally aligned with the final architecture because it is backed by the new tables. Its exact legacy-shaped columns are still an API compatibility surface; longer term, the API can expose nested location data and an account-aware selected-location result.

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

- `user_state.item_id` points to the preserved `media_items.id`.
- `folder_settings.item_id` points to the preserved `media_items.id`.
- `account_visible_items.item_id` points to the preserved `media_items.id`.
- FTS is rebuilt into `media_items_fts`.
- Manual tags and virtual tags are copied from entity-owned tables into `item_tags` and `item_virtual_tags`.

Migration should also preserve image files and verify that migrated image paths still resolve. Old source/path-derived IDs remain valid as opaque item IDs. Brand-new child filesystem items receive opaque item IDs; initial folder settings are applied after discovery by resolving the created `(source_id, relative_path)` location. Source roots remain stable by source UUID.

### Step 3: replace repository assembly

Introduce repositories such as:

- `media-item.repo.ts`;
- `media-location.repo.ts`;
- `media-entity.repo.ts`;

Implemented:

- `media-item.repo.ts` with basic item fetch/existence helpers;
- `media-location.repo.ts` with basic location fetch helpers;
- `media_items_read`, used by the dynamic query builder and core hydrated filesystem reads.
- core filesystem repository reads, selected-location resolution, streaming/actions, account filters, FTS, and tags/vtags now operate through media-item identity.

`RepositoryService` should assemble the public `LibraryItem` from:

```txt
media_items
LEFT JOIN active media_locations
LEFT JOIN media_entities
LEFT JOIN user_state
LEFT JOIN folder_settings
```

The public `LibraryItem.id` should be `media_items.id`.

Implemented cleanup: the temporary legacy `items` mirror has been removed from the current schema and runtime write paths. The remaining future API work is to expose richer all-location data to callers that need more than the selected/display location.

### Step 4: rewrite query builder/search

`query-builder.ts` needs new aliases and field mapping.

Suggested aliases:

```txt
mi = media_items
ml = active media_locations
e  = media_entities
u  = user_state
f  = folder_settings
```

Filters should distinguish:

- logical fields: title, media type, watched, virtual tags, parent;
- selected/display-location fields: source, relative path, size, mtime, missing;
- any-location fields: duplicates, source availability, shadowed copies.

FTS should be rebuilt/updated per `media_items.id`.

Implemented: `query-builder.ts` reads from `media_items_read` instead of `items`, including parent-condition subqueries. Search uses `media_items_fts`. Tags and vtags are item-bound via `item_tags` and `item_virtual_tags`; genre filtering remains entity-bound via `entity_genres`. The read model still has legacy-shaped selected-location columns, so future API work should distinguish logical item fields, selected-location fields, any-location fields, and account-specific visibility/location selection explicitly.

### Step 5: rewrite scanner/reconciliation

Replace source-local reconciliation with the whole-library pipeline described above.

Important changes:

- no per-source deletion before all sources are scanned;
- cleanup uses found location paths, not only item IDs;
- shadowed candidates are persisted as locations;
- rename/move rescue becomes item-location matching across all sources;
- cleanup marks locations missing/tombstoned, not logical items, unless no locations remain and retention policy allows deletion.

Implemented: full-library scans now defer cleanup until every source has been scanned, then run missing-location cleanup and the final whole-library metadata/search maintenance pass. Discovery writes locations during each source scan, while destructive reconciliation is whole-library scoped. Successfully scanned source results can run a targeted enrichment pass for their found item IDs before slower sources finish; this uses the same dirty/gated candidate rules as the full enrichment path, but does not run broad cleanup or global maintenance. It resolves each found path to an existing item by exact source/path first, then by reusable cross-source inode/device, then by reusable missing same-relative-path location, and only generates a new ID when no match exists. Same-source rename rescue and cross-source move rescue now preserve the original `MediaItem.id`, so folder settings, user state, metadata links, and image names remain attached to the logical item.

Implemented: scanner persistence explicitly upserts `media_items` and `media_locations` without maintaining a legacy mirror row. Shadowed lower-priority folder candidates are recorded as shadowed `MediaLocation` rows for the same logical item. During a scan, higher-priority shadow sets use current-cycle non-empty folder paths before falling back to DB state, so a location that disappeared earlier in the same full scan does not incorrectly shadow a lower-priority source.

Post-refactor hardening: add stronger folder/file fingerprints for ambiguous non-inode filesystems, and keep or delete missing logical items according to an explicit retention policy.

### Step 6: update metadata and images

Metadata services should operate on `MediaItem` identity.

Implemented invariant:

- existing item IDs are preserved as durable `media_items.id`;
- image filenames and metadata refresh gates remain attached to that durable item/entity relationship;
- moving/promoting a location does not rename image files or create a fresh item that refetches metadata solely because the path changed.

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

Implemented: playback/streaming, download, rename, custom actions, and subtree rescans resolve an account-aware selected present `MediaLocation` instead of reading path/source directly from a filesystem item row. Streaming additionally requires a selected file location and keys its path cache by account plus item to avoid cross-account location leakage. The compatibility-shaped `getItemSourceId`/`getItemPath` helpers read from the media-backed selected-location read model.

Post-refactor hardening: expose operation-specific policies more explicitly.

### Step 9: update account filters

Account filters should write visible `MediaItem.id`s for item-level visibility rules. Source/path allow/deny rules should be evaluated against `MediaLocation`s.

An account can see an item when it has at least one present location visible to that account, or when it is a logical/virtual container with visible descendants. If all present locations are denied and no visible descendants remain, the item is hidden. Inaccessible locations must not shadow accessible locations for that account.

Ancestor/descendant expansion should use logical parent relationships, not path prefixes.

Implemented: account filter expansion uses logical `parent_id` relationships through the media-backed read model. The selected-location resolver is account-aware for materialized item visibility, so an account cannot stream/download/rename through a hidden item simply because another account or admin can see it.

Post-refactor hardening: source/path-specific account rules would need explicit `MediaLocation` predicates if the product adds them. Current account filters are item-level filters.

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
- foreign keys, FTS rows, manual tags, and virtual tags point at `MediaItem.id` after migration;
- migration can be run only after a backup path is available or explicit backup policy is satisfied.

## Resolved design decisions and implementation notes

### 1. What is the duplicate policy?

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

### 2. What is item-level vs location-level hidden/ignored state?

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

### 3. How should missing/offline sources behave?

Decision: rescan may mark locations unavailable, but normal rescan should not destroy user-owned logical state.

A disappeared location should become missing immediately. If the item has another present visible location, the item remains available. If it has zero present locations, the item becomes missing/unavailable while preserving metadata, watch state, edits, images, and folder settings.

Start with explicit cleanup only. If automatic cleanup is later added, it should be conservative and require a retention window plus proof that the source was successfully scanned after the location disappeared. Logical item deletion should require zero present locations and no preserved user state, locks, manual matches, custom artwork, or child state.

### 4. What are seasons in the target model?

Decision: seasons are first-class logical `MediaItem`s, preserving the current freedom around metadata, folder settings, layouts, locks, and images.

A season item may have:

- a physical season-folder `MediaLocation`;
- no direct location, when it is generated from flat episode files;
- child episode `MediaItem`s whose physical locations may sit directly under the show folder.

Season identity should be deterministic within a show, e.g. show item + season number. If episodes first create a virtual Season 1 and a physical `Season 1/` folder appears later, the folder should attach as a location to the existing Season 1 item rather than creating a duplicate season.

### 5. What owns image files?

Decision: image references should remain attached to the existing durable item/entity relationship and survive location changes. This refactor preserves existing image filenames and paths by preserving `MediaItem.id` across moves/promotions.

### 6. Should old IDs be preserved?

Preserving existing `items.id` as `media_items.id` makes migration safer for frontend caches, user state, and API references. The old value may still look like a source/path hash, but it can become opaque.

Current implementation: old IDs are preserved as opaque `MediaItem.id`s even when they look source/path-derived. Brand-new child filesystem items use opaque generated IDs. Source roots remain stable by source UUID, and code that starts from a source-relative path resolves the actual item through `media_locations`.

### 7. How should selected/display location be chosen?

Decision: selected/display location is a compatibility/read-model choice for the exact item being read or operated on. It is not a statement that a folder item has absorbed its playable children.

Selection should be deterministic and account-aware:

- filter to present locations for the same `MediaItem`;
- filter to locations visible to the current account, when applicable;
- ignore shadowing from inaccessible locations;
- sort by source priority and shadow rules;
- prefer non-empty higher-priority folders only when they are actually present;
- optionally allow an explicit user/admin preference later.

For playback, the requested item is a file `MediaItem`, so the selected location is a concrete file path for that same file item. Movie/show/season folders with metadata are not reduced to single playable locations. Their child files remain separate playable items.

### 8. How should account filters interact with multiple locations?

Decision: source/path allow/deny rules are location-level access controls, not content blacklists.

An account can see an item when at least one of these is true:

- the item has a present location visible to that account;
- the item is a logical/virtual container with visible descendants.

If an item has locations in source A and source B, and the account denies source A only, the source B location can still make the item visible and playable. If all present locations are denied and no visible descendants remain, the item is hidden.

Location selection for compatibility fields and streaming should be account-aware: choose the highest-priority present location visible to that account. Inaccessible locations should not shadow accessible ones for that account.

### 9. Are source roots logical items?

Decision: keep source roots as logical `MediaItem`s for the native file-tree read model. They are not provider metadata identities and they do not make the native tree the only possible future read model; they are stable containers that preserve current root browsing, breadcrumbs, source settings, and account-filter behavior.

### 10. What owns virtual tags and manual tags?

Recommendation: virtual tags and manual/user tags should be item-bound. Their definitions are still filters over assembled library items, so they can depend on genre or other metadata fields. The result belongs to the item that matched.

Implemented: both virtual tags and manual tags are item-bound. Broader vtag follow-up notes are tracked from `docs/TODO.md`.

### 11. How should filesystem actions resolve paths?

Decision: all filesystem-touching operations should resolve a `MediaLocation` through a shared resolver. Compatibility `path` and `sourceId` fields are read-model output, not write authority.

Initial behavior can operate on the selected/display location. Longer term, actions that can affect data loss, such as delete/trash and rename, may need UI support for "this location" vs "all locations" vs "logical item."

### 12. How should scan presence be proven?

Decision: use a scan run ID or equivalent token. Mark a location missing only when the relevant source/scope was successfully scanned and the location was not seen. Do not treat failed, partial, skipped, offline, or unauthorized scans as proof of disappearance.

Current implementation: successful source/scope scans report found relative location paths, full-library scans defer cleanup until all source discovery has completed, and cleanup only reconciles that successfully scanned source/scope. A persisted `last_seen_scan_id` can be added later if the app needs richer scan audit/debug state.

### 13. How should paths be normalized?

Decision: normalize separators to `/` at scan boundaries and keep relative paths as the location key. Further path normalization, including dot segments, Unicode normalization where practical, and platform case behavior, is hardening work. Windows and many macOS volumes are case-insensitive; Linux usually is not. Matching should avoid creating duplicate logical items from casing-only path changes on case-insensitive sources.

### 14. How should migration be operated?

Decision: treat this as a high-risk migration. Use fixture DB tests, validate foreign keys/FTS/image paths, and require a backup policy before migrating a real library.

The current code sometimes changes primary keys to rescue renames. The target model should retire that as normal behavior, but tests should preserve the dependent-state guarantees it currently tries to provide.

### 15. How should ambiguous matches be handled?

Decision: ambiguous matches should not silently merge. Keep separate items or create a conflict state that can be inspected/resolved. Strong matches such as exact location, trustworthy inode/device, prior shadow relation, or strong folder/file fingerprint can auto-link; weak matches such as title-only or TMDB-only should not.

## Post-refactor hardening

1. Add stronger fingerprints/conflict states for ambiguous filesystems where inode/device is unavailable or unreliable.
2. Expose richer location data in APIs that need all locations rather than only selected/display compatibility fields.
3. Add a persisted scan-run marker if successful-scope cleanup is not enough for offline/partial-source diagnostics.
4. Expand path normalization for case-insensitive filesystems and Unicode/path-segment edge cases.

## Outlook

This refactor is intentionally not an external-API project. The useful future-facing outcome is narrower: once logical items, physical locations, metadata, relationships, and state are separated cleanly, Kinome can keep its native file-tree UI while still allowing other read models to be assembled from the same state later.
