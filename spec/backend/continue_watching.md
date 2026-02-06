# Spec: Continue Watching & Next Up

**Version:** 1.0  
**Status:** Implemented  
**Related:** `api_rewrite.md`, `scan_architecture.md`

---

## 1. Abstract

The Continue Watching feature allows users to quickly resume watching TV shows by displaying a list of shows with unwatched episodes on the Home view, and a "Next Up" banner on individual show detail pages. The system tracks watch progress per show and automatically calculates the next episode to watch based on viewing history.

## 2. Problem Statement / Motivation

Users need an efficient way to:
- Resume watching TV shows where they left off
- See a centralized list of all shows they're currently watching
- Know which episode to watch next without manual tracking
- Dismiss shows they're no longer interested in from recommendations

**User Stories:**
- As a user, I want to see a "Continue Watching" row on the home screen showing all TV shows I'm currently watching.
- As a user, when I view a TV show's detail page, I want to see a "Next Up" banner showing the next episode I should watch.

## 3. Goals and Non-Goals

### Goals

- Automatically track which episode a user should watch next for each TV show
- Display a Continue Watching row on the Home view with shows actively being watched
- Display a Next Up banner on TV show detail pages showing the next episode
- Support independent dismissal of Continue Watching (home) vs Next Up (detail)
- Automatically recalculate next episode when episodes are watched/unwatched
- Persist dismissal state across sessions

### Non-Goals

- Percentage-based progress tracking (we only track watched/unwatched for now)
- Recommendations based on viewing history (this is a progress tracker, not a recommendation engine)

## 4. Proposed Solution & Technical Design

### Data Model

Each TV show maintains the following state:
- **`nextUpEpisodeId`**: ID of the next unwatched episode (null if no progress or fully watched)
- **`continueWatchingDismissed`**: User dismissed show from Home "Continue Watching" list
- **`nextUpDismissed`**: User dismissed "Next Up" banner from show's detail page

### Core Behavioral Rules

#### Rule 1: Next Episode Calculation

The "next episode" is determined by:
1. If no episodes are watched → Next episode is `null`
2. Otherwise → First unwatched episode that comes AFTER the highest watched episode (by season/episode number)
3. If all episodes are watched → Next episode is `null`

**Example:** If S02E01 is watched but S01E05 is not, next up is S01E05 (not S02E02).

#### Rule 2: Dismissal Logic (THE ONE-WAY RULE)

**CRITICAL: There is a one-way relationship between the two dismissal flags:**

```
Dismiss "Next Up" (detail page)        →  Also dismiss "Continue Watching" (home)  ✓
Dismiss "Continue Watching" (home)     →  Does NOT affect "Next Up" (detail)      ✓
```

**Rationale:**
- **Dismissing from Detail** = "I don't want to see this show anywhere" (strong dismissal)
- **Dismissing from Home** = "Clean up my home screen" (weak dismissal, might still want the detail banner)

**Summary:**
- `setNextUpDismissed()` sets BOTH flags to `true`
- `setContinueWatchingDismissed()` sets ONLY `continueWatchingDismissed` to `true`

#### Rule 3: Auto-Undismissal

When a user watches a **new** episode (not re-watching) that becomes the **latest** watched episode:
- Clear BOTH dismissal flags (`nextUpDismissed = false`, `continueWatchingDismissed = false`)
- Rationale: Watching a new episode signals renewed interest

**Does NOT trigger if:**
- Re-watching an old episode that's already been watched
- Watching an episode "in the middle" (not the latest progress point)

### API Contracts

**Querying Continue Watching:**
- `GET /api/continue-watching-items` - Returns all shows with progress (for Home view)
- `GET /api/continue-watching-for-show/:showId` - Returns next up info for a specific show (for Detail view)

**Dismissal Actions:**
- `POST /api/dismiss-continue-watching` - Dismisses show from Home only
- `POST /api/dismiss-next-up` - Dismisses show from both Home and Detail (one-way rule)

**Progress Tracking:**
- `POST /api/mark-watched` - Marks episode(s) as watched, recalculates next episode
- `POST /api/mark-unwatched` - Marks episode(s) as unwatched, recalculates next episode

### Display Logic

**Home View "Continue Watching" Row:**
- Shows: All TV shows where `nextUpEpisodeId IS NOT NULL AND continueWatchingDismissed = false`
- Order: By `lastWatched` descending (most recently watched first)

**Detail View "Next Up" Banner:**
- Shows: If `nextUpEpisodeId IS NOT NULL AND nextUpDismissed = false`
- Displays: Episode poster, title, season/episode number, and overview

## 5. Edge Cases & Decisions

### Edge Case 1: What if a user dismisses from Home, then watches a new episode?

**Decision:** The show is **un-dismissed** and appears on both Home and Detail again, because watching a new episode signals renewed interest.

### Edge Case 2: What if a user marks all episodes as unwatched?

**Decision:** The `nextUpEpisodeId` is set to `null` and the show disappears from Continue Watching (no progress = nothing to continue).

### Edge Case 3: What if a user watches episodes out of order (e.g., S02E01 before S01E05)?

**Decision:** The next episode is always calculated as the first unwatched episode AFTER the highest watched episode by season/episode number. So if S02E01 is watched but S01E05 is not, Next Up = S01E05.

### Edge Case 4: What if the next episode file is missing or deleted?

**Decision:** When fetching Continue Watching data, if the `nextUpEpisodeId` points to a non-existent episode, the system automatically recalculates and updates the pointer.

### Edge Case 5: What if a user dismisses Next Up from Detail, then dismisses from Home?

**Decision:**
- After dismissing Next Up: Both flags are `true`
- Dismissing from Home again: Both flags stay `true` (no change)
- This is idempotent and safe
- This shouldn't be possible in the UI anyways.

### Edge Case 6: Can a show appear in Continue Watching with `nextUpEpisodeId = null`?

**Decision:** NO. The `getContinueWatchingItems` query filters shows to only those where `nextUpEpisodeId IS NOT NULL`. If a show has no next episode, it's not in "Continue Watching" state.

## 6. Performance Considerations

### Denormalization Strategy

We denormalize `nextUpEpisodeId` directly on the TV show item instead of calculating it on every query. This means:

**Pros:**
- Extremely fast queries (simple SQL filter: `WHERE next_up_episode_id IS NOT NULL`)
- No expensive joins or calculations at query time
- Scales linearly with library size

**Cons:**
- Must recalculate pointer whenever episodes are watched/unwatched
- Pointer can become stale if episodes are added/removed outside the app

**Recalculation Triggers:**
- `markAsWatched` → Always recalculates for affected show
- `markAsUnwatched` → Always recalculates for affected show
- `recordPlayback` → Marks episode as watched, triggers recalculation
- Episode metadata fetch → No recalculation (pointer remains valid)

### Query Performance

- **Home Continue Watching:** Single query returning ~10-20 shows (fast)
- **Detail Next Up:** Single query for one show (instant)
- **Dismissal:** Single update + broadcast (instant)

## 7. Alternatives Considered

### Alternative A: Calculate Next Episode On-Demand

Instead of storing `nextUpEpisodeId`, calculate it every time the user requests Continue Watching data.

**Rejected because:**
- Much slower (requires loading all episodes for every show on every query)
- Doesn't scale with large libraries
- Complex SQL or multiple database roundtrips

### Alternative C: Single Dismissal Flag

Use only one flag that dismisses the show everywhere.

**Rejected because:**
- Users want different behaviors for Home vs Detail
- Dismissing from Home shouldn't prevent the banner from showing in Detail
- Less flexible UX

## 8. Example Scenarios

### Scenario 1: Starting to Watch a Show

**Initial State:** Show has 2 unwatched episodes, no progress

**Action:** User watches Episode 1

**Result:**
- Episode 1 marked as watched
- Show's `nextUpEpisodeId` points to Episode 2
- Show appears in Home "Continue Watching"
- Show displays "Next Up: Episode 2" banner on Detail page

---

### Scenario 2: Dismissing from Home

**Initial State:** Show appears in both Home Continue Watching and Detail Next Up

**Action:** User dismisses from Home Continue Watching

**Result:**
- `continueWatchingDismissed = true`
- `nextUpDismissed` remains unchanged
- Show disappears from Home Continue Watching
- Show **STILL** displays Next Up banner on Detail page ✓

---

### Scenario 3: Dismissing from Detail

**Initial State:** Show appears in both Home Continue Watching and Detail Next Up

**Action:** User dismisses from Detail Next Up banner

**Result:**
- `nextUpDismissed = true`
- `continueWatchingDismissed = true` (one-way rule!)
- Show disappears from Home Continue Watching ✓
- Show hides Next Up banner on Detail page ✓

---

### Scenario 4: Unwatching All Episodes

**Initial State:** Episode 1 watched, Episode 2 unwatched, show has progress

**Action:** User marks Episode 1 as unwatched

**Result:**
- Episode 1 marked as unwatched
- Show's `nextUpEpisodeId` becomes `null` (no watched episodes = no progress)
- Show disappears from Continue Watching
- Show hides Next Up banner
