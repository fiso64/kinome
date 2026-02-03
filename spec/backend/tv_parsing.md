# Spec: TV Structure Parsing (Phase 1 Logic)

**Version:** 3.0 (Centralized & Triggered)
**Status:** Implemented
**Related:** `scan_architecture.md`, `tv-show.service.ts`

---

## 1. Abstract

This specification details the logic for assigning `seasonNumber` and `episodeNumber` to media files and folders. This logic is encapsulated in the **Centralized TV Show Service (`tv-show.service.ts`)** and is used to maintain structural integrity across the library.

### Trigger Architecture

Unlike previous versions which relied on scanner heuristics, TV structural parsing is now **triggered** by definitive type information:
1.  **Scanner Trigger (Phase 1)**: If a folder is already identified as `mediaType: 'tv'`, the scanner calls the TV Show Service to ensure children are synced.
2.  **Metadata Trigger (Phase 2)**: Immediately after an item is identified as a TV show (via TMDB), the Metadata Service calls the TV Show Service to perform a structural re-sync.

This "Triggered" approach ensures that TV shows are correctly parsed in a single scan cycle without the need for manual rescans or duplicated logic.

## 2. Problem Statement / Motivation

TV shows have highly inconsistent file naming conventions across different sources (scene releases, fansubs, personal rips). A naive regex-per-file approach leads to:

- **Mismatches:** One file parsed as `S01E05`, another as `Episode 5`, causing duplicate or missing episodes.
- **False Positives:** Files like `video1080p.mkv` incorrectly parsed as episode 1080.
- **Ordering Failures:** Episodes displayed out of order when filenames don't follow any standard pattern.

## 3. Goals

- **Consensus-Based Parsing:** Use folder-level pattern analysis to avoid per-file inconsistencies.
- **Graceful Fallback:** When no pattern matches, fall back to alphabetic ordering rather than failing.
- **Special Folder Handling:** Explicitly ignore folders like `Extras`, `Specials`, `Featurettes`.
- **Season Inheritance:** Support both explicit season folders (`S01/`) and flat structures (no season folders).

## 4. Technical Design

### Ignored Folder Names

The following folder names are **skipped** during TV structure parsing. They are still added to the database as regular folders, but their children are not parsed for season/episode numbers:

- `Extras`, `Specials`, `Deleted Scenes`, `Featurettes`, `NC`, `Behind the Scenes`
- **Any folder containing a `.ignore` file.**

---

### Algorithm: Syncing TV Structure

The TV Show Service processes a folder identified as a TV show. Two strategies are available: **smart** (regex-first with fallback) and **alphabetic** (pure positional). The algorithm uses configurable strategies for both season and episode assignment.

**1. Filter subfolders.**

Collect all direct child folders, excluding those in the ignored list.

**2. Check for flat structure (no recognized Season subfolders).**

If the show folder contains video files **directly** AND no subfolders match the Season regex pattern (e.g., `S01`, `Season 2`):

- This is a "flat" TV show structure.
- Treat all direct video files as belonging to **Season 1**.
- Go to **Step 4** (Episode Assignment) with `seasonNumber = 1`.

> [!IMPORTANT]
> If ANY subfolder matches the Season regex, this step is SKIPPED. Video files in the show root are ignored for season assignment, and only the Season subfolders are processed.

**3. Assign Season Numbers to subfolders.**

**If `seasonStrategy = 'smart'`:**

1. Attempt to parse each subfolder name using the season regex:

   - Pattern: `/\b(?:Season\s*|S)(\d{1,2})\b/i`
   - Examples: `Season 1`, `S01`, `Season 02` → extracts the number

2. **If at least one folder matches the pattern:**

   - Assign `seasonNumber` to each matched folder.
   - Mark each as `mediaType = 'season'`.
   - **Process only the matched folders** (unmatched folders are ignored).
   - For each matched folder, go to **Step 4** (Episode Assignment).
   - **Return**.

3. **If no folders match the pattern:**
   - Fall through to alphabetic assignment (below).

**Alphabetic Assignment (fallback or explicit `seasonStrategy = 'alphabetic'`):**

1. Sort all subfolders alphabetically using **natural sort** (e.g., `Part 2` comes before `Part 10`).
2. Assign `seasonNumber` based on position: 1, 2, 3, ...
3. Mark each as `mediaType = 'season'`.
4. For each folder, go to **Step 4** (Episode Assignment).

**Example (arbitrary folder names):**

```text
/Anime Show/
├── First Arc/     → season=1 (alphabetically first)
├── Second Arc/    → season=2
└── Third Arc/     → season=3
```

---

**4. Assign Episode Numbers to video files.**

Collect all video files (`.mp4`, `.mkv`, `.avi`, `.mov`, `.wmv`, `.flv`, `.webm`) in the current folder.

**If `episodeStrategy = 'smart'`:**

1. **Attempt consensus-based pattern matching:**

   Try each regex pattern in priority order against **all** files:

   | Priority | Pattern      | Regex                                  | Extracts         |
   | -------- | ------------ | -------------------------------------- | ---------------- |
   | 1        | `SxxExx`     | `/\bS(\d{1,2})\s?\.?\s?E(\d{1,3})\b/i` | season + episode |
   | 2        | `Episode XX` | `/\bEpisode\s*(\d{1,2})\b/i`           | episode only     |
   | 3        | `Exx`        | `/\bE(\d{2})\b/i`                      | episode only     |

2. **Evaluate consensus for each pattern:**

   A pattern achieves **consensus** if:

   - It matches **all files** (perfect match), OR
   - It matches **≥3 files** with **≤2 mismatches**.

3. **If a pattern achieves consensus:**

   - Assign `episodeNumber` from the regex match to each matched file.
   - If pattern is `SxxExx`: also extract `seasonNumber` from filename (overrides parent).
   - If pattern is `Episode XX` or `Exx`: inherit `seasonNumber` from parent folder.
   - Mark each as `mediaType = 'episode'`.
   - **Return**.

4. **If no pattern achieves consensus:**
   - Fall through to alphabetic assignment (below).

**Alphabetic Assignment (fallback or explicit `episodeStrategy = 'alphabetic'`):**

1. Sort all video files alphabetically using **natural sort**.
2. Assign `episodeNumber` based on position: 1, 2, 3, ...
3. Inherit `seasonNumber` from the parent folder.
4. Mark each as `mediaType = 'episode'`.

**Example (non-standard filenames):**

```text
/Anime Show/First Arc/
├── [SubGroup] Show - 01 [720p].mkv  → episode=1
├── [SubGroup] Show - 02 [720p].mkv  → episode=2
└── [SubGroup] Show - 03 [720p].mkv  → episode=3
```

---

**5. Interaction with Locks (Decoupled Architecture Rule)**

Before writing the calculated `seasonNumber` or `episodeNumber` to the DB:

1.  Check the `lockedFields` metadata for the item.
2.  If `seasonNumber` is locked: **Ignore** the parsed season. **Keep** the existing DB value.
3.  If `episodeNumber` is locked: **Ignore** the parsed episode. **Keep** the existing DB value.
4.  **Write:** Upsert the values only if unlocked.

---

### Reference: Regex Patterns

#### Episode Patterns (Priority Order)

| Priority | Name         | Regex                                  | Example                   | Extracted |
| -------- | ------------ | -------------------------------------- | ------------------------- | --------- |
| 1        | `SxxExx`     | `/\bS(\d{1,2})\s?\.?\s?E(\d{1,3})\b/i` | `Breaking.Bad.S01E05.mkv` | s=1, e=5  |
| 2        | `Episode XX` | `/\bEpisode\s*(\d{1,2})\b/i`           | `Episode 12 - Title.mkv`  | e=12      |
| 3        | `Exx`        | `/\bE(\d{2})\b/i`                      | `e05.mkv`                 | e=5       |

**Notes:**

- Word boundaries (`\b`) prevent false positives like `video1080p.mkv`.
- `SxxExx` extracts both season and episode; others extract episode only.

#### Season Folder Pattern

| Regex                              | Examples                       | Extracted |
| ---------------------------------- | ------------------------------ | --------- |
| `/\b(?:Season\s*\|S)(\d{1,2})\b/i` | `Season 1`, `S01`, `Season 02` | season=N  |

## 6. Edge Cases & Unresolved Questions

- **Multi-Episode Files:** Files like `S01E01-E03.mkv` (containing multiple episodes) are not currently handled. The TV Show Service will assign only the first episode number.
  - **Decision:** Deferred. Users should split multi-episode files.
- **Anime Absolute Numbering:** Some anime use absolute episode numbers (e.g., `Episode 150`) instead of season-relative.
  - **Decision:** Deferred. The server assumes TMDB's season-based structure.
- **Ambiguous Patterns:** A file named `E01E02.mkv` may match incorrectly.
  - **Decision:** The first match wins. Users should rename ambiguous files.
- **Non-Video Files in Episode Folders:** Subtitle files (`.srt`, `.ass`) are not parsed for episode numbers.
  - **Decision:** Correct. Only video files are assigned episode metadata.
