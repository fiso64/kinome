# Spec: Virtual Tags & Dynamic Categorization

**Version:** 3.0
**Status:** Implemented
**Related:** `scan_architecture.md`, `virtual_filesystem.md`, `metadata_locking.md`

---

## 1. Abstract

**Virtual Tags** are a system for creating dynamic, rule-based categories (e.g., "Is Anime", "Is 4K") derived from item metadata. Unlike static tags applied manually by users, Virtual Tags are automatically computed by the system and stored in the database.

**v3.0 Update:** Virtual tag rules now use the same **`LibraryFilter`** condition language as virtual folder filters. Both systems share a single compiler (`compileFilter` → `buildWhereFragment`), eliminating the previously separate rule engine for virtual tags. The old encoded virtual folder ID scheme (`virtual--PARENT--KEY--VALUE`) has been replaced by first-class `items` rows.

## 2. Problem Statement / Motivation

Users need a way to organize content based on dynamic criteria without manually tagging thousands of items.
-   **Example:** A user wants a "Kids Movies" section. They define a rule: "If Genre contains 'Family' OR 'Animation'".
-   **Pain Point:** Doing this manually is impossible for large libraries.
-   **Scalability:** The system must support filtering and grouping purely via database queries for performance (Lean & Lazy Architecture).
-   **Nesting:** Users often want to drill down further once inside a category (e.g., virtual folder "Anime" with grouping by "Year").

## 3. Goals and Non-Goals

### Goals
-   **Configurable Rules:** Users can define rules in settings using `LibraryFilter` conditions (e.g., `is_anime` = Genre eq 'Animation').
-   **Persistence:** Tags are stored in the `entity_virtual_tags` table (keyed by `(entity_id, key)`) to allow efficient SQL querying.
-   **Automatic Synchronization:** Tags update whenever source data (Genres, Title, etc.) changes.
-   **Database-Side Filtering:** The repository supports filtering by virtual tags directly in SQL via an EXISTS subquery.
-   **Unified Rule Language:** Virtual tag rules and virtual folder filters both use `LibraryFilter`, compiled by the same code path.

### Non-Goals
-   **Complex Code Execution:** Rules are simple metadata comparisons, not arbitrary JavaScript code execution.

## 4. Technical Design

### A. Data Types

```ts
type LibraryConditionOp = 'eq' | 'ne' | 'contains' | 'gt' | 'lt'

interface LibraryCondition {
  field: string           // any REPOSITORY_SCHEMA key, e.g. 'genres', 'year', 'addedDaysAgo'
  op: LibraryConditionOp
  value: string | number | null
}

interface LibraryFilter {
  scope?: { parentId: string }  // optional: restrict to a specific parent folder
  conditions?: LibraryCondition[]
}

interface VirtualTagCase {
  filter: LibraryFilter
  result: string          // the tag value assigned when this case matches
}

interface VirtualTagConfig {
  id: string
  name: string            // the tag key, e.g. 'is_anime'
  cases: VirtualTagCase[] // evaluated in order; first match wins
  defaultResult?: string  // assigned if no case matches
}
```

**Supported fields include computed values.** For example, `addedDaysAgo` is a computed column in `REPOSITORY_SCHEMA` (`((cast(strftime('%s','now') as int) - i.added_at / 1000) / 86400)`) — no special-casing needed:

```json
{
  "filter": { "conditions": [{ "field": "addedDaysAgo", "op": "lt", "value": 30 }] },
  "result": "New"
}
```

### B. Storage

Virtual tag values live in a dedicated `entity_virtual_tags` table:

```sql
CREATE TABLE IF NOT EXISTS entity_virtual_tags (
    entity_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (entity_id, key),
    FOREIGN KEY (entity_id) REFERENCES media_entities(id) ON DELETE CASCADE
);
```

The `PRIMARY KEY (entity_id, key)` constraint is exploited during bulk evaluation: `INSERT OR IGNORE` statements are issued in case priority order, so the first matching case wins without any `CASE WHEN` complexity.

### C. The "Materialized View" Strategy

The system uses a **Persistence Model** (effectively a Materialized View). Virtual Tags are computed and saved to `entity_virtual_tags`.

**Computation is Hybrid:**
1.  **Bulk Updates (SQL):** When settings change, `evaluateAndInsertVirtualTags` runs one `INSERT OR IGNORE` per case per tag, in order. The `(entity_id, key)` UNIQUE constraint ensures the first matching case wins.
2.  **Incremental Updates (JavaScript):** When a single item is processed (scanned/edited), `evaluateVirtualTagsForItem` evaluates tags in-memory using `matchesFilter()`, avoiding an extra DB roundtrip.

#### Why Persistence?
1.  **Read Performance:** The API can filter with a simple EXISTS subquery against `entity_virtual_tags`. It effectively flattens complex logic into a simple key-value lookup.
2.  **Indexing:** We index `entity_virtual_tags(entity_id)` for fast per-entity lookups.
3.  **Consistency:** The frontend receives a simple dictionary `{"is_anime": "Yes"}` without needing to know the complex rules that generated it.

### D. Shared Compiler (Unified Rule Language)

Virtual tag case evaluation uses the same compiler as virtual folder filter resolution:

```
VirtualTagCase.filter  ──┐
                          ├──▶ compileFilter() ──▶ buildWhereFragment() ──▶ SQL WHERE fragment
LibraryFilter (folder) ──┘
```

Both `evaluateAndInsertVirtualTags` (write path) and `buildFindQuery` (read path) call `buildWhereFragment`. This eliminates a previously separate condition engine for virtual tags and ensures both systems handle the same field set, operators, and special cases (genres EXISTS subquery, `tags.*` key-value lookup, `vt.*` virtual tag lookup, computed fields like `addedDaysAgo`).

### E. Synchronization Logic (The "Write" Trigger)

**1. Manual Edits (User Action)**
-   **Trigger:** User edits metadata via API.
-   **Action:** `item-update.service` calls `evaluateVirtualTagsForItem` (in-memory), diffs against existing tags, and writes only changed rows.

**2. Automated Enrichment (Background Job)**
-   **Trigger:** `MetadataService` fetches new data from TMDB (e.g., Genres).
-   **Action:**
    1.  Fetch TMDB Data.
    2.  Apply to item entity.
    3.  **CRITICAL:** Recalculate Virtual Tags immediately via in-memory evaluator.
    4.  Save entity to DB.

**3. Settings Change (Bulk Re-evaluation)**
-   **Trigger:** User changes a `VirtualTagConfig` definition.
-   **Action:** `evaluateAndInsertVirtualTags` runs a bulk SQL pass over all affected items using `INSERT OR IGNORE` in case priority order. Existing tags for the changed key are deleted first, then re-inserted.

### F. Database Querying (The "Read" Path)

Virtual tag values are surfaced on `LibraryItem` as a `virtualTags: Record<string, string>` dictionary, hydrated from `entity_virtual_tags` via subquery in `REPOSITORY_SCHEMA`:

```ts
virtualTags: {
  sql: `(SELECT json_group_object(vt.key, vt.value) FROM entity_virtual_tags vt WHERE vt.entity_id = e.id)`,
  isJson: true,
  isSubquery: true
}
```

Filtering by virtual tag (e.g., `vt.is_anime = 'Yes'`) compiles to an EXISTS subquery in `buildWhereFragment`:

```sql
EXISTS (
  SELECT 1 FROM entity_virtual_tags vt
  WHERE vt.entity_id = e.id AND vt.key = 'is_anime' AND vt.value = 'Yes'
)
```

## 5. Persistence vs. On-Demand

**Question:** Why not calculate Virtual Tags on-the-fly during `SELECT`?

-   *Argument for On-Demand:* Eliminates synchronization bugs. "Is Anime" is always true if "Genre = Animation". Never stale.
-   *Argument for Persistence (Chosen):*
    1.  **Performance:** Dynamically generating EXISTS subqueries for every user-defined rule on every `SELECT` adds latency proportional to the number of tag configs.
    2.  **Schema Stability:** User rules change often. Dynamically altering the SQL query structure for every request is fragile.

**Decision:** Persistence, with robust write guards ensuring `entity_virtual_tags` stays in sync on every item write path.

## 6. Edge Cases

-   **Rule Changes:** When a user changes a Virtual Tag definition:
    -   **Action:** Full library re-evaluation via `evaluateAndInsertVirtualTags`.
    -   **Logic:** Delete all rows for the changed tag key, then re-insert via bulk `INSERT OR IGNORE` in case priority order.

-   **Namespace Collision:**
    -   **Scenario:** A user manually tags items with "Animation" AND defines a Virtual Tag "Animation".
    -   **Resolution:** Virtual Tags (prefixed `vt.` in filter fields, stored in `entity_virtual_tags`) are namespaced separately from manual Tags (`tags.`, stored in `entity_tags`). No collision is possible at the storage level.

-   **No-match Items:**
    -   **Scenario:** An item matches no case in a `VirtualTagConfig`.
    -   **Resolution:** If `defaultResult` is set, a final `INSERT OR IGNORE` assigns it. Otherwise the item has no entry for that tag key.

-   **Computed Fields in Rules:**
    -   **Scenario:** A rule uses `addedDaysAgo` or other computed fields.
    -   **Resolution:** `addedDaysAgo` is a first-class entry in `REPOSITORY_SCHEMA` with its SQL expression. `buildWhereFragment` compiles it like any other field — no special-casing. The in-memory evaluator in `virtualTags.service.ts` also handles `addedDaysAgo` explicitly.
