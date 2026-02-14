/**
 * USER REPOSITORY (User Interaction State)
 * Owns the 'user_state' table. Handles watched markers, progress, and dismissals.
 */
import { getDb } from '../client'

/**
 * Updates user state (watched status, etc.)
 */
export function updateUserState(
    itemId: string,
    state: {
        watched?: boolean
        lastWatchedAt?: number
        continueWatchingDismissed?: boolean
        nextUpDismissed?: boolean
        nextUpEpisodeId?: string | null
    }
): void {
    const db = getDb()
    const current = db.prepare('SELECT * FROM user_state WHERE item_id = ?').get(itemId) as any

    const watched = state.watched !== undefined ? (state.watched ? 1 : 0) : current?.watched ?? 0
    const lastWatchedAt = state.lastWatchedAt !== undefined ? state.lastWatchedAt : current?.last_watched_at
    const continueWatchingDismissed =
        state.continueWatchingDismissed !== undefined
            ? state.continueWatchingDismissed
                ? 1
                : 0
            : current?.continue_watching_dismissed ?? 0
    const nextUpDismissed =
        state.nextUpDismissed !== undefined ? (state.nextUpDismissed ? 1 : 0) : current?.next_up_dismissed ?? 0
    const nextUpEpisodeId =
        state.nextUpEpisodeId !== undefined ? state.nextUpEpisodeId : current?.next_up_episode_id

    db.prepare(
        `
    INSERT INTO user_state (
      item_id, watched, last_watched_at, continue_watching_dismissed, next_up_dismissed, next_up_episode_id
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id, user_id) DO UPDATE SET
      watched = excluded.watched,
      last_watched_at = excluded.last_watched_at,
      continue_watching_dismissed = excluded.continue_watching_dismissed,
      next_up_dismissed = excluded.next_up_dismissed,
      next_up_episode_id = excluded.next_up_episode_id
  `
    ).run(itemId, watched, lastWatchedAt, continueWatchingDismissed, nextUpDismissed, nextUpEpisodeId)
}

/**
 * Fetches user state for a single item.
 */
export function fetchUserState(itemId: string): any {
    const db = getDb()
    return db.prepare('SELECT * FROM user_state WHERE item_id = ?').get(itemId)
}
