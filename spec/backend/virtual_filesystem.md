# Spec: Full Virtual Filesystem

**Version:** 2.0
**Status:** Planned — see `docs/virtual-filesystem-analysis.md` for implementation plan
**Related:** `virtual_tags.md`, `scan_architecture.md`

---

## Abstract

This spec defines the architecture for persistent virtual folders — first-class rows in the `items` table that the rest of the system treats like real folders. Virtual folders replace the current transient, encoded-ID grouping system.

The fundamental invariant: **real items never move**. A real item's `parent_id` always points to its filesystem parent, permanently. Virtual folders define their contents via a stored pool query that is compiled to SQL at read time. Multiple virtual folders can independently include the same real item without conflict.

---

## Goals

- Virtual folders are real `items` rows with stable UUID identity and their own `folder_settings`.
- Grouping is a **write operation** on a folder, not a read-time transformation. The children endpoint stops doing in-memory grouping.
- Frontend `isVirtual` checks collapse to a single boolean flag. No more encoded-ID parsing anywhere.
- The scanner is unaware of virtual items; they are excluded from all scanner-adjacent queries by `is_virtual = 1`.

---

## Virtual Folder Types

### `virtual_type = 'grouping'`

Created when a user applies a grouping to a real folder (e.g., "group Movies by Year"). One virtual folder is created per unique group value, each with a `filter_json` that selects matching real children of the parent folder. Real items are never moved.

**Lifecycle:** Created by `applyGrouping(folderId, key)`. Blown away and rebuilt atomically when grouping changes. Destroyed by `removeGrouping`. May have their own `folder_settings` row (controls the expanded full view of the folder). Settings are lost when regrouping — this is expected. The parent's `childViewSettings` separately controls how grouping folders appear when rendered inline as tabs/sections.

### `virtual_type = 'season'`

Created automatically by the scanner (Phase 2, post-`syncTvShowStructure`) when loose episode files exist in a TV show folder without a physical season subfolder. One virtual season folder per distinct `seasonNumber`, with a pool query selecting episodes of that season.

**Lifecycle:** Created/destroyed by the scanner. Uses a **deterministic ID** (`sha256('virtual:season:' + tvShowFolderId + ':' + seasonNumber)`) so that rescan is idempotent — an already-existing season folder is left untouched, preserving any `folder_settings` the user may have configured. Orphaned season folders (no matching episodes remaining) are deleted on rescan.

### `virtual_type = 'user'`

Created explicitly by the user. Stable UUID — never rebuilt. Defines contents via `filter_json`, or is left as a plain folder with manually added children.

**Lifecycle:** Created by user action. Destroyed by explicit user deletion. Has its own `folder_settings` row; settings survive indefinitely.

---

## Schema

New columns on the `items` table:

```sql
is_virtual      INTEGER DEFAULT 0,
virtual_type    TEXT CHECK(virtual_type IN ('user', 'grouping', 'season')),
filter_json TEXT
```

Virtual items use:
- `id` = `crypto.randomUUID()`
- `path` = `virtual://{id}` — satisfies `NOT NULL UNIQUE`, namespace-separated from real paths
- Filesystem stat columns (`size`, `mtime`, `inode`, etc.) are `NULL`

---

## LibraryFilter

A `filter_json` defines what a virtual folder shows. Stored as a `LibraryFilter` JSON object, compiled to SQL at read time on every request — never cached.

```json
{
  "scope": { "parentId": "uuid-of-real-folder" },
  "conditions": [
    { "field": "year", "op": "eq", "value": "2024" },
    { "field": "vt.is_anime", "op": "eq", "value": "Yes" },
    { "field": "addedDaysAgo", "op": "lt", "value": 30 }
  ]
}
```

**Supported scope (v1):** `parentId` — direct real children of a given folder (implicitly excludes `is_virtual = 1`).

**Supported conditions (v1):**
- Any field in `REPOSITORY_SCHEMA` with any operator
- `vt.{key}` — matched via `entity_virtual_tags`
- `tags.{key}` — matched via `entity_tags`
- `genre` — matched via `entity_genres`
- `addedDaysAgo` — computed field: `((now_unix - added_at / 1000) / 86400)`

**Operators:** `eq`, `ne`, `contains` (case-insensitive), `gt`, `lt`

`LibraryFilter` is the same condition language used by `VirtualTagConfig.cases` — virtual folder filters and virtual tag cases share `compileFilter()` as a single compiler.

---

## Children Endpoint Logic

The children endpoint has three branches based on the type of the requested item:

```
getChildren(folderId):

  if item.isVirtual:
    → compile item.filter and run find()

  else if item.viewSettings.appliedGrouping:
    → WHERE parent_id = folderId
        AND (virtual_type = 'grouping' OR virtual_type = 'user')

  else:
    → WHERE parent_id = folderId
        AND (is_virtual = 0 OR virtual_type = 'user')
```

When grouping is active, real children and grouping virtual folders coexist under the same `parent_id` in the DB. Only one set is returned at a time. The `appliedGrouping` field on the parent's `folder_settings` is the switch.

User-created virtual folders (`virtual_type = 'user'`) appear in both states — they are always visible alongside whatever the parent folder is showing.

---

## Grouping Behavior

Applied via `POST /api/items/:id/grouping { groupBy: string | null }`.

**Applying grouping:**
1. Fetch all real children of the folder.
2. Collect unique values for `groupByKey` across those children.
3. In a transaction:
   - Delete existing `virtual_type='grouping'` children.
   - For each unique value: `insertVirtualItem` with `filter_json = { scope: { parentId: folderId }, conditions: [{ field: groupByKey, op: 'eq', value }] }`.
   - Set `appliedGrouping = groupByKey` in the folder's settings.

**Removing grouping (`groupBy: null`):**
1. Delete all `virtual_type='grouping'` children.
2. Clear `appliedGrouping` from the folder's settings.

No reparenting occurs in either direction. Real items are untouched.

---

## `appliedGrouping` Setting

Replaces the old `groupBy` view setting. Set and cleared atomically with the grouping virtual folders. It is:
- Never inherited by child folders.
- Not directly user-editable — only `applyGrouping()` / `removeGrouping()` touch it.
- Read by the UI to show what grouping is active and offer to change or remove it.
- Read by the children endpoint to determine which branch to take.

---

## Home Virtual Folder

A special `virtual_type='user'` item created at startup if it doesn't exist. Its `filter_json` defaults to all direct children of the library root (configurable). `/?folder=home` resolves to this item's UUID. `/?folder=root` is treated as any other real folder with no special logic.

---

## Examples

### Movies folder grouped by Year

**On disk / in the `items` table** (permanent, never changes):
```
movies/        parent_id=root,   is_virtual=0
Oppenheimer/   parent_id=movies, is_virtual=0, year=2023
Barbie/        parent_id=movies, is_virtual=0, year=2023
Dune 2/        parent_id=movies, is_virtual=0, year=2024
```

**After `applyGrouping(movies, 'year')`** — new rows written to DB:
```
2023/          parent_id=movies, is_virtual=1, virtual_type='grouping',
               filter={ scope:{parentId:movies}, conditions:[{field:'year',op:'eq',value:2023}] }
2024/          parent_id=movies, is_virtual=1, virtual_type='grouping',
               filter={ scope:{parentId:movies}, conditions:[{field:'year',op:'eq',value:2024}] }
```
`appliedGrouping='year'` is also set on movies' folder_settings. Real items are untouched.

**`GET /items/movies/children`** — `appliedGrouping` is set, returns grouping virtual folders:
```json
[
  { "id": "2023-uuid", "name": "2023", "isVirtual": true },
  { "id": "2024-uuid", "name": "2024", "isVirtual": true }
]
```

**`GET /items/2023-uuid/children`** — virtual folder, compiles pool query:
```json
[
  { "id": "oppenheimer-id", "name": "Oppenheimer", "isVirtual": false },
  { "id": "barbie-id",      "name": "Barbie",      "isVirtual": false }
]
```

---

### TV show with loose episodes

**On disk / in the `items` table** (permanent):
```
Breaking Bad/   parent_id=root, is_virtual=0
S01E01.mkv      parent_id=Breaking Bad, is_virtual=0, seasonNumber=1
S01E02.mkv      parent_id=Breaking Bad, is_virtual=0, seasonNumber=1
S02E01.mkv      parent_id=Breaking Bad, is_virtual=0, seasonNumber=2
```

**After scanner runs** — new virtual season rows:
```
Season 1/       parent_id=Breaking Bad, is_virtual=1, virtual_type='season',
                filter={ scope:{parentId:Breaking Bad}, conditions:[{field:'seasonNumber',op:'eq',value:1}] }
Season 2/       parent_id=Breaking Bad, is_virtual=1, virtual_type='season',
                filter={ scope:{parentId:Breaking Bad}, conditions:[{field:'seasonNumber',op:'eq',value:2}] }
```
`appliedGrouping='seasonNumber'` set on Breaking Bad's folder_settings.

**`GET /items/Breaking Bad/children`**:
```json
[
  { "id": "s1-uuid", "name": "Season 1", "isVirtual": true },
  { "id": "s2-uuid", "name": "Season 2", "isVirtual": true }
]
```

**`GET /items/s1-uuid/children`** — compiles pool query:
```json
[
  { "id": "s01e01-id", "name": "S01E01.mkv" },
  { "id": "s01e02-id", "name": "S01E02.mkv" }
]
```

---

### User-created "Recently Added"

**In the `items` table:**
```
Home/             parent_id=root, is_virtual=1, virtual_type='user',
                  filter={ scope:{parentId:root} }
Recently Added/   parent_id=Home, is_virtual=1, virtual_type='user',
                  filter={ conditions:[{field:'addedDaysAgo',op:'lt',value:30}] }
```

Real items (Dune 2, etc.) live wherever they live on disk. Their `parent_id` is unchanged.

**`GET /items/Recently-Added-uuid/children`** — compiles filter, returns real items added in the last 30 days:
```json
[
  { "id": "dune2-id", "name": "Dune 2", "isVirtual": false, "parentId": "movies-id" },
  ...
]
```

Note that the returned items' `parentId` still points to their real filesystem parent, not to the "Recently Added" folder.

---

## What Remains Transient

The **"Files"** group (catch-all for loose items that don't match any grouping virtual folder in a tabs/sections layout) is not persisted. It is a rendering concern created at read time. It is never written to the database.
