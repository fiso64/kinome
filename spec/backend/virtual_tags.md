# Spec: Virtual Tags & Dynamic Categorization

**Version:** 1.0
**Status:** **Implemented**
**Related:** `scan_architecture.md`, `api_rewrite.md`, `metadata_locking.md`

---

## 1. Abstract

**Virtual Tags** are a system for creating dynamic, rule-based categories (e.g., "Is Anime", "Is 4K") derived from item metadata (Genres, Resolution, Paths). Unlike static tags applied manually by users, Virtual Tags are automatically computed by the system. This spec defines the architecture for defining, calculating, persisting, and querying these tags.

## 2. Problem Statement / Motivation

Users need a way to organize content based on dynamic criteria without manually tagging thousands of items.
-   **Example:** A user wants a "Kids Movies" section. They define a rule: "If Genre contains 'Family' OR 'Animation'".
-   **Pain Point:** Doing this manually is impossible for large libraries.
-   **Scalability:** The system must support filtering and grouping purely via database queries for performance (Lean & Lazy Architecture).

## 3. Goals and Non-Goals

### Goals
-   **Configurable Rules:** Users can define rules in settings (e.g., `is_anime = Genre contains 'Animation'`).
-   **Persistence:** Tags are stored in the database (`virtual_tags_json`) to allow efficient SQL querying, sorting, and indexing.
-   **Automatic Synchronization:** Tags must automatically update whenever the source data (Genres, Title, Path) changes.
-   **Database-Side Filtering:** The API must support filtering by virtual tags directly in SQL (e.g., `json_extract(virtual_tags_json, '$.is_anime') = 'Yes'`).

### Non-Goals
-   **Complex Code Execution:** Rules are simple metadata comparisons, not arbitrary JavaScript code execution.

## 4. Technical Design

### A. The "Materialized View" Strategy

The system uses a **Persistence Model** (effectively a Materialized View). Virtual Tags are computed and saved to the `virtual_tags_json` column.

**Computation is Hybrid:**
1.  **Bulk Updates (SQL):** When settings change, we use efficient SQL `CASE WHEN` statements to update the entire library in seconds without moving data to Node.js.
2.  **Incremental Updates (JavaScript):** When a single item is processed (scanned/edited), we calculate the tags in memory (JavaScript) before saving, avoiding the need for a re-read.

#### Why Persistence?
1.  **Read Performance:** The API can query `SELECT * FROM items WHERE virtualTags.is_anime = 'Yes'` using simple JSON extraction. It effectively flattens complex logic into a simple key-value pair.
2.  **Indexing:** We can create SQLite indexes on specific virtual tags if needed for performance.
3.  **Consistency:** The frontend receives a simple dictionary `{"is_anime": "Yes"}` without needing to know the complex rules that generated it.

### B. Synchronization Logic (The "Write" Trigger)

To maintain data integrity, we hook into the **Write Path** of the system.

**1. Manual Edits (User Action)**
-   **Trigger:** User edits metadata via API (calls `libraryService.updateItem`).
-   **Action:** `libraryService` calls `_finalizeItemUpdate`, which:
    1.  Calculates new Virtual Tags in memory.
    2.  Writes to `metadata` table.

**2. Automated Enrichment (Background Job)**
-   **Trigger:** `MetadataService` fetches new data from TMDB (e.g., Genres).
-   **Action:**
    1.  Fetch TMDB Data.
    2.  Apply to Item Object (e.g., `item.genres = ['Animation']`).
    3.  **CRITICAL:** Recalculate Virtual Tags immediately: `item.virtualTags = evaluateVirtualTags(item)`.
    4.  Save entire object to DB.

### C. Database Querying (The "Read" Path)
Refactored to "Lean & Lazy" principles (See `api_rewrite.md`).

-   **Frontend Request:** `GET /items/:id/children?groupByKey=vt.is_anime&groupByValue=Yes`
-   **API Layer (`v2.ts`):** Parses the request.
-   **Repository Layer (`repository.service.ts`):** Generates optimized SQL:
    ```sql
    SELECT * FROM items
    JOIN metadata m ON items.id = m.item_id
    WHERE json_extract(m.virtual_tags_json, '$.is_anime') = 'Yes'
    ```

## 5. Persistence vs. On-Demand (Unresolved Questions)

**Question:** Why not calculate Virtual Tags on-the-fly during `SELECT` (On-Demand)?
-   *Argument for On-Demand:* It eliminates synchronization bugs. "Is Anime" is always true if "Genre = Animation". You never have stale tags.
-   *Argument for Persistence (Chosen):*
    1.  **Performance:** Generating complex SQL `CASE WHEN` statements for every single user-defined rule on every `SELECT` is expensive and complex to maintain.
    2.  **Schema Stability:** User rules change. Dynamically altering the SQL query structure for every request is fragile.

**Decision:** We stick with **Persistence** for now, unless we encouter related bugs.
-   **Mitigation:** We implemented robust "Write Guards" in both `library.service` and `metadata.service` to ensure `virtual_tags_json` is never stale.

## 6. Edge Cases

-   **Rule Changes:** When a user changes the definition of a Virtual Tag (e.g., adds "Shonen" to "Is Anime"):
    -   **Action:** The system triggers a **Full Library Re-evaluation**.
    -   **Logic:** `libraryService.reapplyVirtualTagsAfterSettingsChange()` iterates every item in the DB, recalculates tags, and bulk-updates the `virtual_tags_json` column.

-   **Virtual Folders (The 404 Problem):**
    -   **Problem:** Virtual Folders (e.g., "Anime Section") do not exist in the DB.
    -   **Solution:** The API intercepts `virtual--` IDs and synthesizes a `LibraryItem` on the fly. Children are fetched by querying the DB with the Virtual Tag filter.
