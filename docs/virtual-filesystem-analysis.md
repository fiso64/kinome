
# Virtual Filesystem Refactor — Analysis & Detailed Plan

## Implementation Status

### ❌ Phase 1: Schema Foundation
### ❌ Phase 2: Virtual Folder Write Service
### ❌ Phase 3: Children Endpoint Simplification
### ❌ Phase 4: Virtual Season Folders (Scanner Integration)
### ❌ Phase 5: Home Virtual Folder
### ❌ Phase 6: API & Frontend

---

## Current Architecture (What We're Replacing)

Virtual folders don't exist in the database. They are constructed at read time by `grouping.service.ts` using encoded ID strings (`virtual--{physicalParentId}--genre:Action--year:2024`). Every request to a folder in tabs/sections layout runs `getGroupedChildren` → `getGroups` → `groupItemsRecursive` — 727 lines of recursive in-memory transformation.

Settings for virtual folders are stored on the physical parent's `folder_settings` row, nested under `view_settings_json.virtualFolderSettings[tokenPath]`. This creates: unbounded growth on the parent row, lost settings on regrouping, and special-cased read/write logic throughout the stack.

Approximately 20 frontend files check `isVirtual`; `ContextMenu.svelte` alone has 8 conditionals on it.

---

## Architectural Decisions

### 1. Virtual folders are first-class `items` rows

Persisted in the `items` table with `path = 'virtual://{uuid}'`. Satisfies `NOT NULL UNIQUE`, is namespace-separated from real paths, and carries no semantic content.

### 2. UUID identity

Identity is `crypto.randomUUID()`. Two identically-defined virtual folders in different locations are distinct objects with independent settings.

### 3. `virtual_type` column

| `virtual_type` | Created by | Destroyed by | Survives regrouping? |
|---|---|---|---|
| `'grouping'` | `applyGrouping()` | `applyGrouping()` rebuild / `removeGrouping()` | No |
| `'season'` | Scanner (Phase 2) | Re-scan | No |
| `'user'` | User action | User deletion | Yes |

### 4. Real items never move

**`parent_id` on a real item never changes.** Real items always point to their filesystem parent. Virtual folders resolve their children dynamically via `pool_query_json` — they do not own children in the DB sense. Multiple virtual folders can independently include the same real item without conflict.

There is no reparenting. There is no `real_parent_id` column.

### 5. `pool_query_json` — how virtual folders define their contents

Every virtual folder has a `pool_query_json` that is compiled to SQL at read time:

```json
{
  "scope": { "parentId": "uuid-of-real-folder" },
  "filters": {
    "year": "2024",
    "vtag.is_anime": "Yes",
    "addedWithinDays": 30
  }
}
```

Supported scope (v1): `parentId` — direct children of a given folder (excludes `is_virtual = 1` implicitly).
Supported filters (v1): any `REPOSITORY_SCHEMA` field with equality match, `vtag.{key}`, `addedWithinDays`.

Pool query extension (richer scoping, new filter types) is **out of scope for this refactor**.

### 6. Children endpoint logic

The children endpoint for a real folder must distinguish between two states based on whether `appliedGrouping` is set in the folder's `folder_settings`:

```
getChildren(folderId):
  item = getItemById(folderId)

  if item.isVirtual:
    return find(compilePoolQuery(item.poolQuery))

  else if item.viewSettings.appliedGrouping:
    // Grouping is active — show the grouping virtual folders (plus any user virtual folders at this level)
    return find({ parentId: folderId, virtualType: IN ['grouping', 'user'] })

  else:
    // No grouping — show real children plus any user virtual folders
    return find({ parentId: folderId, isVirtual: false })
    // Note: user virtual folders added directly to this folder will be missed by isVirtual=0.
    // Correct filter: WHERE parent_id = ? AND (is_virtual = 0 OR virtual_type = 'user')
```

Real items and grouping virtual folders coexist in the DB under the same `parent_id` — only one set is visible at a time depending on `appliedGrouping`.

### 7. `appliedGrouping` replaces `groupBy` view setting

The old `groupBy` view setting controlled runtime grouping. After the refactor it is replaced by `appliedGrouping` — set atomically by `applyGrouping()` and cleared by `removeGrouping()`. It is not user-editable directly; it's a descriptor of current DB state that the UI reads to show what grouping is active. It is never inherited — it belongs only to the folder it's set on. Remove `groupBy` from `StoredViewSettings` and from `resolveViewSettings` inheritance logic.

### 8. Virtual folder settings

All virtual folder types can have their own `folder_settings` rows. This is independent of `childViewSettings` on the parent — the parent's `childViewSettings` controls how the virtual folder looks when rendered *inline as a tab/section child*; the virtual folder's own settings control how it looks when *opened in full view*.

- `virtual_type='grouping'`: settings are tied to the virtual folder's UUID. When grouping is removed or changed, the virtual folder rows are deleted and their `folder_settings` cascade-delete. Settings are effectively lost on regrouping — this is natural and expected behavior.
- `virtual_type='season'`: settings survive rescan because season virtual folders use deterministic IDs (see Phase 4).
- `virtual_type='user'`: stable UUIDs, settings survive indefinitely.

### 9. Vtag storage kept

`entity_virtual_tags` remains a materialized cache for performance. Pool queries reference vtag values as a filter dimension — pool queries are not vtags, and vtags are not pool queries.

---

## Schema Changes

### New columns on `items`

```sql
is_virtual      INTEGER DEFAULT 0,
virtual_type    TEXT CHECK(virtual_type IN ('user', 'grouping', 'season')),
pool_query_json TEXT
```

### New indexes

```sql
CREATE INDEX IF NOT EXISTS idx_items_is_virtual   ON items(is_virtual);
CREATE INDEX IF NOT EXISTS idx_items_virtual_type ON items(virtual_type);
```

### `REPOSITORY_SCHEMA` additions (`repo-definitions.ts`)

```ts
isVirtual:   { sql: 'i.is_virtual',      table: 'i', parser: Boolean },
virtualType: { sql: 'i.virtual_type',    table: 'i' },
poolQuery:   { sql: 'i.pool_query_json', table: 'i', isJson: true },
addedAt:     { sql: 'i.added_at',        table: 'i' },
```

Note: `added_at` exists in the schema today but is absent from `REPOSITORY_SCHEMA` — add it here.

---

## Phase 1: Schema Foundation

**Goal:** Add columns and indexes; update scanner queries; add new repo functions. No behavior change.

### `schema.ts`
Add 3 columns + 2 indexes to `items`.

### `filesystem.repo.ts`
1. `getAllIdsInScope` — add `AND is_virtual = 0` to both query variants.
2. `getItemsForCleanup` — add `AND is_virtual = 0`.
3. **New: `insertVirtualItem(params)`** — insert a single virtual item row. Separate from `upsertLibraryItems` (scanner write path, real items only).
4. **New: `deleteVirtualItemsByType(parentId, virtualType)`** — delete all virtual children of a parent with a given type.

### `repo-definitions.ts`
Add the 4 fields listed above to `REPOSITORY_SCHEMA`.

Also add the `virtual_type IN (...)` and `is_virtual = 0 OR virtual_type = 'user'` filter patterns to `buildFindQuery`. The `where` clause today only supports equality; the children endpoint needs compound OR conditions. Add a `rawConditions?: string[]` field to `FindOptions` as an escape hatch for pre-built SQL fragments.

### `mappers.ts`
Map `is_virtual → isVirtual` (boolean), `virtual_type`, `pool_query_json` from raw rows.

### Tests
- All 146 existing tests pass (schema-only change).
- New: scanner cleanup excludes `is_virtual = 1` items.
- New: `insertVirtualItem` + `deleteVirtualItemsByType` + cascade verify (`folder_settings` ON DELETE CASCADE).

---

## Phase 2: Virtual Folder Write Service

**Goal:** New `virtualFolders.service.ts` implementing all write-side operations.

### `applyGrouping(folderId, groupByKey)`

```
1. Fetch all real children of folderId (is_virtual = 0)
2. Collect unique values for groupByKey across those children (reuse getValuesForKey)
3. In a transaction:
   a. deleteVirtualItemsByType(folderId, 'grouping')
   b. For each unique value:
      - id = crypto.randomUUID()
      - poolQuery = { scope: { parentId: folderId }, filters: { [groupByKey]: value } }
      - insertVirtualItem({ id, parentId: folderId, name: value, virtualType: 'grouping', poolQueryJson })
   c. Update folder_settings: set appliedGrouping = groupByKey
```

Real items are never touched. Every grouping virtual folder gets a `pool_query_json` regardless of whether the key is single-valued or multi-valued. No distinction needed.

### `removeGrouping(folderId)`

```
1. deleteVirtualItemsByType(folderId, 'grouping')
2. Update folder_settings: clear appliedGrouping
```

### `createUserVirtualFolder(parentId, name, poolQueryJson?)`

Creates a `virtual_type='user'` item with a stable UUID and `pool_query_json`. Returns the new item.

### `deleteVirtualFolder(id)`

Asserts `virtual_type='user'`. Calls `deleteItem(id)` — `folder_settings` and `user_state` cascade-delete automatically.

### Pool Query Compiler

```ts
function compilePoolQuery(poolQuery: PoolQuery): FindOptions
```

Maps `poolQuery.scope.parentId` to `where.parentId` and `poolQuery.filters` to `where` entries. `addedWithinDays` maps to a `rawConditions` entry: `i.added_at > (unixepoch() - N * 86400) * 1000`.

---

## Phase 3: Children Endpoint Simplification

**Goal:** Remove all runtime grouping from the read path. Preserve and simplify the eager-child-embedding behavior that prevents N+1 requests.

### What to delete from `grouping.service.ts`

- **`getGroups`** — pure grouping dispatch, gone
- **`groupItemsRecursive`** — the grouping+embedding engine. The grouping half is gone entirely; the embedding half is re-implemented more simply (see below)
- **`getGroupsOnly`** — replaced by a direct DB children query
- **`getLogicalFolderInfo`** — encoded ID construction, gone
- **`getVirtualItem`** and all `buildVirtualItem` / `isVirtualId` / `parseVirtualId` callers — virtual items are real DB rows, fetched normally by `getItemById`
- **`groupItemsForDetailView`** — dead code; `createForDetailViewCopy` at `repository.service.ts:297` doesn't actually call it
- The `groupBy`-resolution block in `getGroupedChildren` (step 3: `finalGroupBy`, the `getGroups` branch in step 6)
- The encoded-ID virtual resolution in `getGroupedChildren` (step 4: `isVirtualId` branch) — replaced by pool query compilation

### What to keep / rewrite

**`resolveEffectiveSettings`** — unchanged.

**`resolveViewHierarchy`** — survives. Replace the `getGroupsOnly` call with a direct DB folder children query. The recursion structure and settings-resolution logic inside are otherwise unchanged:

```ts
// Before: construct virtual IDs for every possible group value in memory
const childrenResult = await getGroupsOnly(targetId, inheritedSettings)

// After: real DB folder children (virtual grouping folders are now actual rows)
const childrenResult = getFolderChildren(targetId) // WHERE parent_id = ? AND type = 'folder'
```

**`getGroupedChildren` → `getChildren`** — strips down to the parts that are not grouping:

```ts
async function getChildren(id, options):
  // 1. Root alias resolution (unchanged)
  // 2. includeHidden / includeIgnored defaults (unchanged)
  // 3. Contextual default sorting by parent mediaType (unchanged)
  //    — episodes → episodeNumber ASC, tv → seasonNumber ASC, else → name ASC
  // 4. Child resolution:
  item = getItemById(resolvedId)
  if item.isVirtual:
    items = find(compilePoolQuery(item.poolQuery))
  else if item.viewSettings?.appliedGrouping:
    items = find({ parentId: id, virtualType: IN ['grouping', 'user'] })
  else:
    items = find({ parentId: id, is_virtual = 0 OR virtual_type = 'user' })
  // 5. Eager embedding for container layouts (see below)
  return embedChildrenForContainers(items, options)
```

### Eager child embedding (replaces the non-grouping half of `groupItemsRecursive`)

`groupItemsRecursive` currently has two jobs. The first is creating virtual folder objects in memory — that goes away. The second is **eagerly embedding children** for any folder using a tabs/sections layout, so the frontend receives a fully-nested tree in a single response instead of making N+1 requests per tab.

This second job must survive. After the refactor it is much simpler:

```ts
async function embedChildrenForContainers(items, options):
  for each item where item.type === 'folder':
    effectiveSettings = resolveEffectiveSettings(item.id)
    if effectiveSettings.layout in ['tabs', 'sections']:
      item.children = await getChildren(item.id, options)  // recurses naturally
  return items
```

`getChildren` is called recursively on each container child. Since `getChildren` itself handles pool query compilation for virtual folders, the embedding works identically for real folders and virtual grouping folders — no special-casing needed.

The "Files" transient group (catch-all for loose non-folder items within a container level) is built inside `embedChildrenForContainers` when a pool query or real children query returns loose file-type items alongside folders.

### `virtual-item.factory.ts`

Delete after confirming no callers remain.

### API layer

Remove any code intercepting `PUT /api/items/{virtualId}` and redirecting settings writes to the physical parent. Virtual items are first-class — `_updateItem(virtualFolderId, updates)` works directly.

---

## Phase 4: Virtual Season Folders (Scanner Integration)

**Goal:** Scanner creates `virtual_type='season'` folders for loose episode files during Phase 2.

### Deterministic IDs for idempotency

Season virtual folders use a **deterministic ID** rather than a random UUID:

```ts
id = sha256('virtual:season:' + tvShowFolderId + ':' + seasonNumber)
```

This is consistent with how real items use `sha256(relativePath)`. The `path` column is still `virtual://{id}` (unique, namespace-separated). The benefit: `insertVirtualItem` can use `INSERT OR IGNORE` on the primary key — if the season folder already exists from a previous scan, it is left untouched, preserving any user-configured `folder_settings`.

### Process

After `syncTvShowStructure` assigns S/E numbers to loose episode files in a TV show folder:

1. Query for distinct `seasonNumber` values among direct episode-file children of the TV show folder (`parent_id = tvShowFolderId AND is_virtual = 0 AND seasonNumber IS NOT NULL`).
2. For each `seasonNumber`:
   - Compute `id = sha256('virtual:season:' + tvShowFolderId + ':' + seasonNumber)`.
   - `INSERT OR IGNORE INTO items (...) VALUES (id, ...)` — no-op if already exists.
3. Delete orphaned virtual season folders: virtual season folders whose pool query season number no longer matches any episode in the TV show folder.
4. Set `appliedGrouping = 'seasonNumber'` on the TV show folder's settings (idempotent — same value, no-op if already set).

Episodes remain in the TV show folder (`parent_id = tvShowFolderId`). The virtual season folder resolves its contents via the pool query at read time.

---

## Phase 5: Home Virtual Folder

At startup (`ensureRootExists`-adjacent), create a `virtual_type='user'` item named `__home__` with `pool_query_json = { scope: { parentId: rootId } }` if none exists.

`GET /api/items/home/children` resolves to this item's UUID. `/?folder=root` is treated as any other real folder.

---

## Phase 6: API & Frontend

New endpoint: `POST /api/items/:id/grouping { groupBy: string | null }`

New endpoint: `POST /api/items/:parentId/virtual-folders { name, poolQuery? }`

Frontend `isVirtual` checks collapse from encoded-ID string parsing to `item.isVirtual` boolean.

Grouping UI: becomes a trigger for the write endpoint, not a view settings dropdown.

---

## Gotchas

### 1. `getAllDescendantsAsList` will include virtual folder rows

`fetchAllDescendantsRaw` (recursive CTE on `parent_id`) is called in 5+ places in `library.service.ts` and `metadata.service.ts` for watched state and metadata bulk operations. After the refactor, virtual grouping folders appear in these results as rows with `parent_id = real_folder_id`. The CTE correctly does NOT traverse into their children (those children point to the real folder, not the virtual folder, since we don't reparent). So no items are duplicated. The issue is only that watched-state operations will attempt to update `user_state` for virtual grouping folders themselves. This is harmless but wasteful. **Audit all callers** and add `WHERE is_virtual = 0` filtering where appropriate.

### 2. `buildFindQuery` needs compound OR conditions

The children endpoint needs `WHERE parent_id = ? AND (is_virtual = 0 OR virtual_type = 'user')` which the current query builder can't express. Add `rawConditions?: string[]` to `FindOptions` as an escape hatch for pre-built SQL fragments. Use sparingly — only for the children endpoint filter logic.

### 3. `StoredViewSettings` — removing `groupBy`

The `groupBy` field in `StoredViewSettings` currently drives runtime grouping. After the refactor it is superseded by `appliedGrouping`. Remove `groupBy` from `StoredViewSettings` and from `resolveViewSettings` inheritance logic. `appliedGrouping` is never inherited — it belongs only to the folder it's set on.

### 4. Virtual season folders and `syncTvShowStructure` ordering

Virtual season folder creation must happen after `syncTvShowStructure` assigns `seasonNumber` values, since the pool query filters by `seasonNumber`. Ensure the virtual folder creation step is a post-step of `syncTvShowStructure`, not interleaved with the S/E assignment loop.
