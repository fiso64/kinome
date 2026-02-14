/**
 * Continue Watching — Pure Business Logic
 *
 * Extracted from library.service.ts so the core rules from
 * continue_watching.md can be tested without database dependencies.
 *
 * SPEC: continue_watching.md §4
 */

export interface EpisodeInfo {
    id: string
    seasonNumber?: number | null
    episodeNumber?: number | null
    watched?: boolean
}

export interface DismissalState {
    continueWatchingDismissed: boolean
    nextUpDismissed: boolean
}

/**
 * Converts season+episode to a single comparable integer.
 * S01E01 → 10001, S02E05 → 20005, etc.
 */
export function getComparable(ep: EpisodeInfo): number {
    return (ep.seasonNumber ?? 0) * 10000 + (ep.episodeNumber ?? 0)
}

/**
 * SPEC Rule 1: Next Episode Calculation
 *
 * 1. If no episodes are watched → null
 * 2. Otherwise → First unwatched episode AFTER the highest watched episode
 * 3. If all episodes are watched → null
 */
export function findNextUpEpisode(episodes: EpisodeInfo[]): EpisodeInfo | undefined {
    if (episodes.length === 0) return undefined

    const watchedEpisodes = episodes.filter((e) => e.watched)
    if (watchedEpisodes.length === 0) return undefined

    const sortedEpisodes = [...episodes].sort((a, b) => getComparable(a) - getComparable(b))

    let maxWatchedVal = -1
    for (const ep of watchedEpisodes) {
        maxWatchedVal = Math.max(maxWatchedVal, getComparable(ep))
    }

    return sortedEpisodes.find((ep) => !ep.watched && getComparable(ep) > maxWatchedVal)
}

/**
 * SPEC Rule 2: One-Way Dismissal Logic
 *
 * - Dismiss "Continue Watching" (home) → sets ONLY continueWatchingDismissed
 * - Dismiss "Next Up" (detail)         → sets BOTH flags
 */
export function applyContinueWatchingDismissal(state: DismissalState): DismissalState {
    return {
        ...state,
        continueWatchingDismissed: true,
        // nextUpDismissed is NOT changed — this is the independent direction
    }
}

export function applyNextUpDismissal(state: DismissalState): DismissalState {
    return {
        continueWatchingDismissed: true, // One-way rule
        nextUpDismissed: true,
    }
}

/**
 * SPEC Rule 3: Auto-Undismissal
 *
 * When a user watches a NEW episode that becomes the LATEST watched episode,
 * clear BOTH dismissal flags.
 *
 * Does NOT trigger if:
 * - Re-watching an already-watched episode
 * - Watching an episode "in the middle" (not the latest progress point)
 *
 * Returns the new dismissal state, or null if no change was needed.
 */
export function checkAutoUndismissal(
    state: DismissalState,
    allEpisodes: EpisodeInfo[],
    newlyWatchedEpisodes: EpisodeInfo[]
): DismissalState | null {
    // If not dismissed, nothing to undo
    if (!state.nextUpDismissed && !state.continueWatchingDismissed) return null

    // Must be a NEW watch
    if (newlyWatchedEpisodes.length === 0) return null

    // Find the max comparable of the NEWLY watched episodes
    const maxNewVal = newlyWatchedEpisodes.reduce((max, curr) => {
        return Math.max(max, getComparable(curr))
    }, 0)

    // Find the max comparable of ALL watched episodes
    const maxWatchedVal = allEpisodes.reduce((max, curr) => {
        if (!curr.watched) return max
        return Math.max(max, getComparable(curr))
    }, 0)

    // If the new episode is the greatest (or tied for greatest), un-dismiss
    if (maxNewVal >= maxWatchedVal || maxWatchedVal === 0) {
        return {
            continueWatchingDismissed: false,
            nextUpDismissed: false,
        }
    }

    return null
}
