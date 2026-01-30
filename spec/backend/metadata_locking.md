# Spec: Metadata Locking & User Edits ("Field-Level Persistence")

**Version:** 2.1 (Partial Updates + Auto-Locking)
**Status:** Proposed
**Related:** `scan_architecture.md`, `../frontend/metadata_and_settings_edits.md`

---

## 1. Concrete Implementation

The system uses a **Partial Update (PATCH) Strategy** to infer locking intent.
- **Locking Store:** A JSON array stored in the `metadata` table column `locked_fields_json`.
- **Inference Rule:** If a payload contains a field (e.g., `title`), and that field's value differs from the current DB value, the backend **Automatically Locks** that field.
- **Explicit Override:** Clients can override this behavior by explicitly sending a `lockedFields` array (e.g., to unlock a field).

## 2. The Lock List

A simplified list of keys that automated processes MUST check before writing.

| Key             | Guarded Process       | Description                                 |
| :-------------- | :-------------------- | :------------------------------------------ |
| `seasonNumber`  | **FilesystemService** | Protects user-assigned Season index.        |
| `episodeNumber` | **FilesystemService** | Protects user-assigned Episode index.       |
| `tmdbId`        | **MetadataService**   | Protects user-assigned Match (Fix Match).   |
| `title`         | **MetadataService**   | Protects user-assigned Title.               |
| `overview`      | **MetadataService**   | Protects user-assigned Overview.            |
| `posterPath`    | **MetadataService**   | Protects user-assigned (or deleted) Poster. |

## 3. Workflow Examples

### A. Automatic Locking (User Edit via PATCH)

**Action:** User changes Title via UI. Frontend sends `{ id: 1, title: 'My User Title' }`.
**Backend Logic:**
1.  Compare `payload.title` vs `db.title`.
2.  **Difference Detected:**
    - Update `title = 'My User Title'`
    - Append `'title'` to `locked_fields_json`.
3.  **Result:** Field is updated and locked automatically.

### B. Explicit Unlocking (User Revert)

**Action:** User clicks "Revert to Original" / "Unlock Field" (Not yet implemented)
**Payload:**
```json
{
  "id": "123",
  "lockedFields": {
    "title": false
  }
}
```
**Backend Logic:**
1.  Remove `'title'` from the `locked_fields_json` array.
2.  **No Automatic Refresh:** For simplicity, unlocking a field **DOES NOT** trigger an immediate metadata fetch. The current value (e.g., the user's custom title) persists until a manual refresh or scheduled scan occurs.

### B. Write Guard (Automated Enrichment)

**Action:** Metadata Service has fetched new data from TMDB (or Parent Cache).
**Logic:**

```typescript
const locks = JSON.parse(row.locked_fields_json || '[]')
const updates = {}

if (!locks.includes('title')) {
  updates.title = tmdbData.title
}
if (!locks.includes('overview')) {
  updates.overview = tmdbData.overview
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

- **Conflict: Parent Cache vs. Child Lock**

  - _Scenario:_ TMDB updates title to "The Pilot". Parent Cache is updated.
  - _Child (Unlocked):_ `MetadataService` overwrites child with "The Pilot".
  - _Child (Locked):_ `MetadataService` sees lock. Child remains "My Title".

- **The "Reset" Flow**

  - _Action:_ User clicks "Refresh Metadata (Replace All)".
  - _Logic:_ Clear `locked_fields_json` -> Set `tmdbDetailsFetched = 0` -> Trigger Refresh.
  - _Result:_ Child is overwritten with Parent Cache data.

- **"Fix Match" on Parent**

  - _Scenario:_ User changes the TMDB ID of the **Show**.
  - _Result:_ The `episodes_json` blob is completely replaced.
  - _Child Impact:_ User edits on episodes (e.g., "My Custom Title") are **preserved** because they live on the child item. Structure (Season 1, Ep 1) remains valid, but the _fallback_ data underneath changes instantly. This is a massive feature.

- **Orphaned Edits**
  - _Scenario:_ User edits `S01E01` (Title="My Title"). Then renames file to `S02E01`.
  - _Result:_ The item (and its ID) moves to Season 2. The title "My Title" moves with it.
  - _Issue:_ "My Title" might not make sense for S02E01.
  - _Decision:_ User responsibility. The system correctly preserved the _user's data_ attached to the _file_.

### D. Write Guard (Scanner/Filesystem)

**Action:** Scanner finds a file `S01E06.mkv`.
**Current Logic (Problematic):** Unconditional `INSERT ... ON CONFLICT DO UPDATE`.
**Required Logic (With Locking):**

1.  **Read Phase:** Fetch `locked_fields_json` for the item.
2.  **Determine Values:**
    - If `episodeNumber` is LOCKED: Use existing DB value.
    - If `episodeNumber` is UNLOCKED: Use parsed value (6).
3.  **Execute Upsert:**
    ```typescript
    // Pseudo-code
    const episodeVal = locks.includes('episodeNumber') ? dbItem.episodeNumber : parsedEpisode
    db.prepare(
      'INSERT ... VALUES (@episode, ...) ON CONFLICT DO UPDATE SET episode_number = excluded.episode_number'
    ).run({ episode: episodeVal })
    ```
