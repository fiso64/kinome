# Spec: Metadata Locking & User Edits ("Field-Level Persistence")

**Version:** 2.2 (Partial Updates + Auto-Locking + Overwrite Rules)
**Status:** Implemented
**Related:** `scan_architecture.md`, `manual_assignment.md`, `../frontend/metadata_and_settings_edits.md`

---

## 0. Overwrite Rules

These rules decide what any process may overwrite. Everything below implements them.

A lock is a field name on the item's lock list. Two groups of fields can be locked:

- **Identity fields** say what the item is: `tmdbId`, `mediaType`, `seasonNumber`, `episodeNumber`.
- **Descriptive fields** say how it is shown: `title`, `overview`, artwork, `year`, `genres`, and the rest.

Descriptive edits belong to an identity, and only the user changes an identity.

1. **Automatic processes write only unlocked fields.** Scans, structure sync, and metadata refresh never change a locked field and never remove a lock. A renamed or renumbered file keeps the user's edits.
2. **A manual match sets and locks the full identity:** `tmdbId` and `mediaType`, plus `seasonNumber` for a season.
3. **Changing an item's identity resets its description.** A match to a different title or season drops the item's descriptive locks along with its automatic values. Applying the same match again keeps them. A first manual match counts as a change.
4. **A parent rematch resets the children that follow from it.** Seasons and episodes under a rematched show or season are cleared and derived again. Their descriptive locks follow rule 3.
5. **A child with an identity lock is never reset by a parent action.** A file matched as another title, or one whose type or number the user set, stays as it is under show and season rematches. Clearing that child hands it back.
6. **Clear metadata removes everything, including every lock,** for the item or for all its children. It is the only way back to fully automatic. There is no per-field unlock in the UI.

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
| `mediaType`     | **FilesystemService** | Protects the type of a manual match or edit. |
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

- **The "Reset" Flow (Refresh Metadata)**
  - _Action:_ User clicks "Refresh Metadata (Replace All)".
  - _Logic:_ Clear `locked_fields_json` -> Set `tmdbDetailsFetched = 0` -> Trigger Refresh.
  - _Result:_ Child is overwritten with Parent Cache data.

- **The "Fix Match" Flow**
  - See [manual_assignment.md](manual_assignment.md) for details on how manual matches interact with locking.

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
