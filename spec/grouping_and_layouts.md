# Spec: Grouping and Layouts

**Version:** 2.0
**Status:** Implemented
**Related:** `spec/backend/virtual_filesystem.md`, `spec/backend/virtual_tags.md`

---

## 1. Abstract

Kinome's viewing engine is split into two distinct systems: **Layout Resolution** and **Logical Grouping**. While Layout Resolution handles the visual style (e.g., Grid, List, Sections), Logical Grouping handles the organization of items into hierarchical virtual structures.

As of v2.0, grouping is a **write operation** — applying a grouping creates persistent virtual folder rows in the `items` table. The children endpoint reads these rows; it never does in-memory partitioning. See `spec/backend/virtual_filesystem.md` for the full virtual folder architecture.

## 2. Layout Resolution: The Cascading Model

Layout Resolution is the process of determining the effective visual settings (layout type, poster size, click actions) for any container. It uses a calculated specificity cascade where specific instructions override generic ones.

### 2.1 The Specificity Cascade

When resolving settings for an item, the system builds a stack of `StoredViewSettings` layers. The **first** layer to define a scalar property (like `layout`) wins.

The order of specificity is (from highest to lowest):

1.  **Direct Override**: An explicit instruction from a parent targeting exactly this child's ID (via `childViewSettings.overrides[childId]`).
2.  **Inherited Context**: The general `childViewSettings` passed down from a parent (e.g., "all items in this section should be Lists").
3.  **Local Item Settings**: Settings saved directly on the folder in the database (`folder_settings.view_settings_json`).
4.  **Media-Type Defaults**: Global defaults for the category (e.g., `tv`, `movie`, `season`).
5.  **Global System Default**: The absolute fallback for all folders (`_default`).

### 2.2 Additive Merging of Complex Maps

Unlike scalar properties, complex maps are **merged** across all cascade layers (least-specific first, most-specific last):

- **`childViewSettings.overrides`**: Per-child-ID overrides from all layers are combined. A more-specific layer's override for a given child ID wins.

### 2.3 groupBy Resolution

The `groupBy` property determines how a container layout organizes its children:

- If any cascade layer explicitly sets `groupBy`, that value wins (normal specificity rules).
- If no layer sets it and the resolved layout is `tabs` or `sections`, `groupBy` defaults to `'folder'`.
- For non-container layouts (`grid`, `list`, etc.), `groupBy` is `null`.

### 2.4 Layout-Specific Settings

Each layout type defines its own set of tunable properties (e.g., `gridPosterSize` for grid, `listDescriptionRows` for list). These are resolved per the normal specificity cascade, but only keys relevant to the **resolved layout** are included in the output. Switching layout switches which keys appear.

Fallback values come from `settings.defaultLayoutSettings[resolvedLayout]` when no cascade layer provides a value.

### 2.5 Null-Settings Fallback

When the global `Settings` object is unavailable (e.g., during initial load), the resolver produces safe defaults:
- `layout`: from `inheritedSettings` or `item.viewSettings`, falling back to `'grid'`.
- `clickAction`: same chain, falling back to `'detail'`.
- Layout-specific keys use the static `LAYOUT_SPECIFIC_SETTINGS_CONFIG` defaults.

## 3. Logical Grouping: Persistent Virtual Folders

Grouping is a **write-time operation** that creates persistent virtual folder rows in the database. The children endpoint reads these rows — it never partitions items in memory. See `spec/backend/virtual_filesystem.md` for schema, lifecycle, and filter details.

### 3.1 Applying a Grouping (`applyGrouping`)

When a user groups a folder by a metadata key (e.g., `year`, `genres`, `vt.is_anime`):

1. **Value Extraction**: All real (non-virtual) children are fetched. For each child, `getValuesForKey(item, key)` extracts values.
2. **Multi-value Support**: If an item has multiple values (e.g., Genres: "Action" and "Sci-Fi"), it contributes to multiple group folders.
3. **Uncategorized Bucket**: Items with no value for the key produce an "Uncategorized" folder whose filter uses `{op: 'isNull'}`.
4. **Atomic Write**: In a transaction, existing grouping folders are deleted, new ones are inserted, and `appliedGrouping` is set on the parent's `folder_settings`.

Each grouping virtual folder stores a `LibraryFilter` that selects its members at read time via `compileFilter()`.

### 3.2 Structural Grouping (`groupBy: folder`)

The `folder` grouping key is handled by the children endpoint's standard branch logic — it simply returns the real sub-folders. No virtual folders are created for `groupBy: folder`; the physical structure is the grouping.

Season grouping for TV shows is handled separately by `syncVirtualSeasonFolders`, which creates `virtual_type='season'` folders with deterministic IDs. See `spec/backend/virtual_filesystem.md` § Virtual Folder Types.

### 3.3 The Children Endpoint (`getChildren`)

The children endpoint resolves folder contents through three branches:

```
getChildren(folderId):
  if item.isVirtual:
    → Branch A: compile item.filter and run find()
  else:
    → childrenFilter(item) selects the right SQL:
      if appliedGrouping set → grouping/season/user virtual folders
      else                  → real items + user virtual folders
```

After resolving children, `embedChildrenForContainers` recursively fetches and embeds children for any folder whose resolved layout is `tabs` or `sections`, preventing N+1 requests from the frontend.

### 3.4 The "Files" Catch-All

The "Files" group (catch-all for loose items that don't match any grouping virtual folder in a tabs/sections layout) is **not persisted**. It is a rendering concern created at read time. It is never written to the database.

## 4. Architectural Invariants

These invariants are the "Laws" of the Kinome view engine.

### I1: Invariant of Direct View Isolation
**"Items requested directly are resolved in a vacuum."**
When a user navigates to a folder (Full View), the `inheritedSettings` context is strictly `undefined`. This ensures a folder always presents its own intended style, preventing a parent's "styling intent" from leaking into standalone navigation.

### I2: Invariant of Inline Inheritance
**"Parent intent only propagates through the side-channel of container views."**
A parent only influences a child when that child is rendered *inside* the parent (Tabs/Sections). This inheritance is temporary and context-bound.

### I3: Invariant of Mixed Content Fallback
**"TV shows must default to Season content layouts even when customized."**
If a TV show defines child overrides (e.g., for an "Extras" folder) but does *not* define a general layout for its children, the engine automatically injects the **Season Default** into the cascade. This prevents episodes/seasons from accidentally inheriting a "TV Show" (Tabs) layout.

### I4: Invariant of Real Item Immutability
**"Real items never move."**
A real item's `parent_id` always points to its filesystem parent, permanently. Virtual folders define their contents via stored filter queries — they do not reparent real items.

## 5. Virtual Folder Types

| Type | Created By | Identity | Settings Persistence |
| :--- | :--- | :--- | :--- |
| **`grouping`** | `applyGrouping()` | Random UUID | Lost on re-grouping |
| **`season`** | `syncVirtualSeasonFolders()` | Deterministic SHA-256 | Preserved across rescans |
| **`user`** | User action | Random UUID | Permanent |
| **`home`** | `ensureHomeVirtualFolder()` | Constant `'virtual-home'` | Permanent |

Virtual folders are first-class `items` rows. They have their own `folder_settings` and stable IDs. See `spec/backend/virtual_filesystem.md` for the full schema and lifecycle details.

## 6. Tree Side-Channel (`viewHierarchy`)

To enable responsive navigation and "Deep Tabs," Kinome provides a side-channel API called `viewHierarchy`.
- **Purpose**: It allows the frontend to know the entire layout tree (nested tabs/sections) before fetching heavy item metadata.
- **Scope**: Resolves logical structure and view settings. It does NOT return file lists or posters.
- **Recursion**: It follows the container structure as deep as the library defines (capped at depth 10 as a safety guard).
- **Branch Logic**: Uses the same `childrenFilter()` helper as `getChildren` to determine which children to recurse into, ensuring consistency.

## 7. Edge Cases & Error Handling

- **Circular Nesting**: `resolveViewHierarchy` maintains a depth counter (capped at 10) to prevent infinite loops.
- **Orphan Cleanup**: `syncVirtualSeasonFolders` deletes virtual season folders whose season number no longer appears in any child episode.
- **Uncategorized Filter**: Uses `{op: 'isNull'}` to correctly match items with NULL values for the grouping key, rather than comparing against a sentinel string.
