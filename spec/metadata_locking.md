
# Spec: Metadata Locking & User Edits ("Field-Level Persistence")

**Version:** 2.0 (Concrete)
**Status:** Proposed
**Related:** `scan_architecture.md`

---

## 1. Concrete Implementation

Locking is a JSON array stored in the `metadata` table column `locked_fields_json`. It acts as a **Write Guard** for the automated background processes.

## 2. The Lock List
A simplified list of keys that automated processes MUST check before writing.

| Key | Guarded Process | Description |
| :--- | :--- | :--- |
| `seasonNumber` | **FilesystemService** | Protects user-assigned Season index. |
| `episodeNumber` | **FilesystemService** | Protects user-assigned Episode index. |
| `tmdbId` | **MetadataService** | Protects user-assigned Match (Fix Match). |
| `title` | **MetadataService** | Protects user-assigned Title. |
| `overview` | **MetadataService** | Protects user-assigned Overview. |
| `posterPath` | **MetadataService** | Protects user-assigned (or deleted) Poster. |

## 3. Workflow Examples

### A. Explicit Locking (User Edit)
**Action:** User changes Title via UI.
**SQL:**
```sql
UPDATE metadata 
SET 
  title = 'My User Title',
  locked_fields_json = json_insert(locked_fields_json, '$[#]', 'title') -- append if not exists
WHERE item_id = ?
```

### B. Write Guard (Automated Enrichment)
**Action:** Metadata Service has fetched new data from TMDB (or Parent Cache).
**Logic:**
```typescript
const locks = JSON.parse(row.locked_fields_json || '[]');
const updates = {};

if (!locks.includes('title')) {
  updates.title = tmdbData.title;
}
if (!locks.includes('overview')) {
  updates.overview = tmdbData.overview;
}
// Apply updates...
```

### C. Write Guard (Scanner/Structure)
**Action:** Scanner finds `S01E05.mkv`.
**Logic:**
```typescript
if (locks.includes('episodeNumber')) {
  // Do NOT update season/episode numbers
}
```

## 6. Edge Cases & Unresolved Questions

*   **Conflict: Parent Cache vs. Child Lock**
    *   *Scenario:* TMDB updates title to "The Pilot". Parent Cache is updated.
    *   *Child (Unlocked):* `MetadataService` overwrites child with "The Pilot".
    *   *Child (Locked):* `MetadataService` sees lock. Child remains "My Title".

*   **The "Reset" Flow**
    *   *Action:* User clicks "Refresh Metadata (Replace All)".
    *   *Logic:* Clear `locked_fields_json` -> Set `tmdbDetailsFetched = 0` -> Trigger Refresh.
    *   *Result:* Child is overwritten with Parent Cache data.

*   **"Fix Match" on Parent**
    *   *Scenario:* User changes the TMDB ID of the **Show**.
    *   *Result:* The `episodes_json` blob is completely replaced.
    *   *Child Impact:* User edits on episodes (e.g., "My Custom Title") are **preserved** because they live on the child item. Structure (Season 1, Ep 1) remains valid, but the *fallback* data underneath changes instantly. This is a massive feature.

*   **Orphaned Edits**
    *   *Scenario:* User edits `S01E01` (Title="My Title"). Then renames file to `S02E01`.
    *   *Result:* The item (and its ID) moves to Season 2. The title "My Title" moves with it.
    *   *Issue:* "My Title" might not make sense for S02E01.
    *   *Decision:* User responsibility. The system correctly preserved the *user's data* attached to the *file*.

### D. Write Guard (Scanner/Filesystem)
**Action:** Scanner finds a file `S01E06.mkv`.
**Current Logic (Problematic):** Unconditional `INSERT ... ON CONFLICT DO UPDATE`.
**Required Logic (With Locking):**

1.  **Read Phase:** Fetch `locked_fields_json` for the item.
2.  **Determine Values:**
    *   If `episodeNumber` is LOCKED: Use existing DB value.
    *   If `episodeNumber` is UNLOCKED: Use parsed value (6).
3.  **Execute Upsert:**
    ```typescript
    // Pseudo-code
    const episodeVal = locks.includes('episodeNumber') ? dbItem.episodeNumber : parsedEpisode;
    db.prepare('INSERT ... VALUES (@episode, ...) ON CONFLICT DO UPDATE SET episode_number = excluded.episode_number').run({ episode: episodeVal });
    ```
