/**
 * Continue Watching Business Logic Tests
 *
 * Tests the pure decision logic from continue_watching.md.
 * These functions have zero external dependencies.
 *
 * SPEC: continue_watching.md §4
 */
import { describe, it, expect } from 'bun:test'
import {
    findNextUpEpisode,
    getComparable,
    applyContinueWatchingDismissal,
    applyNextUpDismissal,
    checkAutoUndismissal,
    type EpisodeInfo,
    type DismissalState,
} from './continue-watching'

// =================================================================
// getComparable
// =================================================================

describe('getComparable', () => {
    it('converts S01E01 to 10001', () => {
        expect(getComparable({ id: 'a', seasonNumber: 1, episodeNumber: 1 })).toBe(10001)
    })

    it('converts S02E05 to 20005', () => {
        expect(getComparable({ id: 'a', seasonNumber: 2, episodeNumber: 5 })).toBe(20005)
    })

    it('treats null season as 0', () => {
        expect(getComparable({ id: 'a', seasonNumber: null, episodeNumber: 5 })).toBe(5)
    })

    it('treats null episode as 0', () => {
        expect(getComparable({ id: 'a', seasonNumber: 1, episodeNumber: null })).toBe(10000)
    })
})

// =================================================================
// findNextUpEpisode
// SPEC Rule 1: Next Episode Calculation
//
// 1. If no episodes are watched → null
// 2. Otherwise → First unwatched episode AFTER the highest watched
// 3. If all episodes are watched → null
// =================================================================

describe('findNextUpEpisode', () => {
    const ep = (id: string, s: number, e: number, watched = false): EpisodeInfo => ({
        id, seasonNumber: s, episodeNumber: e, watched,
    })

    it('returns undefined when no episodes exist', () => {
        expect(findNextUpEpisode([])).toBeUndefined()
    })

    it('returns undefined when no episodes are watched (Rule 1: no progress)', () => {
        const episodes = [ep('e1', 1, 1), ep('e2', 1, 2), ep('e3', 1, 3)]
        expect(findNextUpEpisode(episodes)).toBeUndefined()
    })

    it('returns the next unwatched episode after the highest watched (Rule 2)', () => {
        const episodes = [
            ep('e1', 1, 1, true),
            ep('e2', 1, 2, false),
            ep('e3', 1, 3, false),
        ]
        expect(findNextUpEpisode(episodes)?.id).toBe('e2')
    })

    it('returns undefined when all episodes are watched (Rule 3: fully watched)', () => {
        const episodes = [
            ep('e1', 1, 1, true),
            ep('e2', 1, 2, true),
            ep('e3', 1, 3, true),
        ]
        expect(findNextUpEpisode(episodes)).toBeUndefined()
    })

    // SPEC Rule 1 Point 2: Skipping holes
    // "First unwatched episode AFTER the highest watched"
    // If S02E01 is watched, the next up is S02E02, even if S01E05 was skipped.
    it('skips earlier unwatched episodes when a later one is watched', () => {
        const episodes = [
            ep('e1', 1, 5, false),   // unwatched, but before the highest watched
            ep('e2', 2, 1, true),    // highest watched
            ep('e3', 2, 2, false),   // first unwatched AFTER highest
        ]
        expect(findNextUpEpisode(episodes)?.id).toBe('e3')
    })

    it('handles unsorted input (sorts by season/episode internally)', () => {
        const episodes = [
            ep('e3', 1, 3, false),
            ep('e1', 1, 1, true),
            ep('e2', 1, 2, false),
        ]
        expect(findNextUpEpisode(episodes)?.id).toBe('e2')
    })

    it('handles multi-season shows correctly', () => {
        const episodes = [
            ep('e1', 1, 1, true),
            ep('e2', 1, 2, true),
            ep('e3', 2, 1, false),
            ep('e4', 2, 2, false),
        ]
        expect(findNextUpEpisode(episodes)?.id).toBe('e3')
    })

    it('handles a single watched episode', () => {
        const episodes = [
            ep('e1', 1, 1, true),
            ep('e2', 1, 2, false),
        ]
        expect(findNextUpEpisode(episodes)?.id).toBe('e2')
    })
})

// =================================================================
// Dismissal Logic
// SPEC Rule 2: One-Way Dismissal
//
// Dismiss "Next Up" (detail)      → Also dismiss "Continue Watching" ✓
// Dismiss "Continue Watching"     → Does NOT affect "Next Up"        ✓
// =================================================================

describe('one-way dismissal rule', () => {
    it('applyContinueWatchingDismissal: sets ONLY continueWatchingDismissed', () => {
        const state: DismissalState = { continueWatchingDismissed: false, nextUpDismissed: false }
        const result = applyContinueWatchingDismissal(state)

        expect(result.continueWatchingDismissed).toBe(true)
        expect(result.nextUpDismissed).toBe(false) // NOT changed
    })

    it('applyContinueWatchingDismissal: preserves existing nextUpDismissed', () => {
        const state: DismissalState = { continueWatchingDismissed: false, nextUpDismissed: true }
        const result = applyContinueWatchingDismissal(state)

        expect(result.continueWatchingDismissed).toBe(true)
        expect(result.nextUpDismissed).toBe(true) // preserved
    })

    it('applyNextUpDismissal: sets BOTH flags (one-way rule)', () => {
        const state: DismissalState = { continueWatchingDismissed: false, nextUpDismissed: false }
        const result = applyNextUpDismissal(state)

        expect(result.continueWatchingDismissed).toBe(true) // one-way rule!
        expect(result.nextUpDismissed).toBe(true)
    })

    // SPEC Edge Case 5: Idempotent double-dismiss
    it('applyNextUpDismissal is idempotent', () => {
        const state: DismissalState = { continueWatchingDismissed: true, nextUpDismissed: true }
        const result = applyNextUpDismissal(state)

        expect(result.continueWatchingDismissed).toBe(true)
        expect(result.nextUpDismissed).toBe(true)
    })

    // SPEC Scenario 2: Dismiss from Home only
    it('dismissing from Home does NOT affect Next Up banner', () => {
        const state: DismissalState = { continueWatchingDismissed: false, nextUpDismissed: false }
        const result = applyContinueWatchingDismissal(state)

        // Show should still display Next Up banner on Detail page
        expect(result.nextUpDismissed).toBe(false)
        expect(result.continueWatchingDismissed).toBe(true)
    })

    // SPEC Scenario 3: Dismiss from Detail
    it('dismissing from Detail hides show from BOTH locations', () => {
        const state: DismissalState = { continueWatchingDismissed: false, nextUpDismissed: false }
        const result = applyNextUpDismissal(state)

        // Show should disappear from both Home and Detail
        expect(result.continueWatchingDismissed).toBe(true)
        expect(result.nextUpDismissed).toBe(true)
    })
})

// =================================================================
// Auto-Undismissal
// SPEC Rule 3: When a user watches a NEW episode that is the LATEST,
// clear BOTH dismissal flags.
//
// Does NOT trigger if:
// - Re-watching an old episode
// - Watching an episode "in the middle"
// =================================================================

describe('checkAutoUndismissal', () => {
    const ep = (id: string, s: number, e: number, watched = false): EpisodeInfo => ({
        id, seasonNumber: s, episodeNumber: e, watched,
    })

    it('un-dismisses when new episode is the latest watched', () => {
        const state: DismissalState = { continueWatchingDismissed: true, nextUpDismissed: true }
        const allEpisodes = [
            ep('e1', 1, 1, true),
            ep('e2', 1, 2, true),   // newly watched AND the latest
            ep('e3', 1, 3, false),
        ]
        const newlyWatched = [ep('e2', 1, 2, true)]

        const result = checkAutoUndismissal(state, allEpisodes, newlyWatched)

        expect(result).not.toBeNull()
        expect(result!.continueWatchingDismissed).toBe(false)
        expect(result!.nextUpDismissed).toBe(false)
    })

    it('does NOT un-dismiss when re-watching an old episode', () => {
        const state: DismissalState = { continueWatchingDismissed: true, nextUpDismissed: true }
        const allEpisodes = [
            ep('e1', 1, 1, true),   // re-watched, but e2 is still the latest
            ep('e2', 1, 2, true),
            ep('e3', 1, 3, false),
        ]
        const newlyWatched = [ep('e1', 1, 1, true)]

        const result = checkAutoUndismissal(state, allEpisodes, newlyWatched)

        expect(result).toBeNull() // No change
    })

    it('does NOT un-dismiss when watching a middle episode', () => {
        const state: DismissalState = { continueWatchingDismissed: true, nextUpDismissed: true }
        const allEpisodes = [
            ep('e1', 1, 1, true),
            ep('e2', 1, 2, true),   // newly watched
            ep('e3', 1, 3, true),   // but e3 is already watched and is greater
        ]
        const newlyWatched = [ep('e2', 1, 2, true)]

        const result = checkAutoUndismissal(state, allEpisodes, newlyWatched)

        expect(result).toBeNull() // e2 < e3, so no undismissal
    })

    it('returns null when not dismissed (nothing to undo)', () => {
        const state: DismissalState = { continueWatchingDismissed: false, nextUpDismissed: false }
        const allEpisodes = [ep('e1', 1, 1, true)]
        const newlyWatched = [ep('e1', 1, 1, true)]

        const result = checkAutoUndismissal(state, allEpisodes, newlyWatched)
        expect(result).toBeNull()
    })

    it('returns null when no new episodes are watched', () => {
        const state: DismissalState = { continueWatchingDismissed: true, nextUpDismissed: true }
        const allEpisodes = [ep('e1', 1, 1, true)]
        const newlyWatched: EpisodeInfo[] = []

        const result = checkAutoUndismissal(state, allEpisodes, newlyWatched)
        expect(result).toBeNull()
    })

    // SPEC Edge Case 1: User dismisses from Home, then watches new episode
    it('un-dismisses after Home dismissal + new episode', () => {
        const state: DismissalState = { continueWatchingDismissed: true, nextUpDismissed: false }
        const allEpisodes = [
            ep('e1', 1, 1, true),
            ep('e2', 1, 2, true),   // newly watched, is the latest
            ep('e3', 1, 3, false),
        ]
        const newlyWatched = [ep('e2', 1, 2, true)]

        const result = checkAutoUndismissal(state, allEpisodes, newlyWatched)

        expect(result).not.toBeNull()
        expect(result!.continueWatchingDismissed).toBe(false)
        expect(result!.nextUpDismissed).toBe(false)
    })
})
