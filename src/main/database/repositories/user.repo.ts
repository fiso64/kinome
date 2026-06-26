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
    userId: string,
    state: {
        watched?: boolean
        lastWatchedAt?: number
        continueWatchingDismissed?: boolean
        nextUpDismissed?: boolean
        nextUpEpisodeId?: string | null
    }
): void {
    const db = getDb()
    const current = db.prepare('SELECT * FROM user_state WHERE item_id = ? AND user_id = ?').get(itemId, userId) as any

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
      item_id, user_id, watched, last_watched_at, continue_watching_dismissed, next_up_dismissed, next_up_episode_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id, user_id) DO UPDATE SET
      watched = excluded.watched,
      last_watched_at = excluded.last_watched_at,
      continue_watching_dismissed = excluded.continue_watching_dismissed,
      next_up_dismissed = excluded.next_up_dismissed,
      next_up_episode_id = excluded.next_up_episode_id
  `
    ).run(itemId, userId, watched, lastWatchedAt, continueWatchingDismissed, nextUpDismissed, nextUpEpisodeId)
}

/**
 * Bulk-sets watched state for many items in a single SQL statement.
 * Use for folder mark-watched where every file gets the same value.
 */
export function bulkSetWatched(itemIds: string[], userId: string, watched: boolean, lastWatchedAt: number): void {
    if (itemIds.length === 0) return
    const db = getDb()
    const placeholders = itemIds.map(() => '?').join(', ')
    const watchedInt = watched ? 1 : 0
    db.prepare(`
        INSERT INTO user_state (item_id, user_id, watched, last_watched_at)
        SELECT id, ?, ?, ? FROM media_items WHERE id IN (${placeholders})
        ON CONFLICT(item_id, user_id) DO UPDATE SET
          watched = excluded.watched,
          last_watched_at = excluded.last_watched_at
    `).run(userId, watchedInt, lastWatchedAt, ...itemIds)
}

/**
 * Fetches user state for a single item.
 */
export function fetchUserState(itemId: string, userId: string): any {
    const db = getDb()
    return db.prepare('SELECT * FROM user_state WHERE item_id = ? AND user_id = ?').get(itemId, userId)
}

/**
 * Fetches user state rows for a batch of items, keyed by item_id.
 */
export function fetchUserStateMap(itemIds: string[], userId: string): Map<string, any> {
    if (itemIds.length === 0) return new Map()
    const db = getDb()
    const placeholders = itemIds.map(() => '?').join(', ')
    const rows = db.prepare(
        `SELECT * FROM user_state WHERE user_id = ? AND item_id IN (${placeholders})`
    ).all(userId, ...itemIds) as any[]
    return new Map(rows.map((r) => [r.item_id, r]))
}

/**
 * Returns all user IDs whose nextUpEpisodeId for a given show points to the specified episode.
 */
export function getUserIdsWithNextUp(showId: string, episodeId: string): string[] {
    const db = getDb()
    const rows = db.prepare(
        'SELECT user_id FROM user_state WHERE item_id = ? AND next_up_episode_id = ?'
    ).all(showId, episodeId) as { user_id: string }[]
    return rows.map((r) => r.user_id)
}

/**
 * Overlays user state onto an array of items in-place.
 * Items with no user state entry remain unchanged (watched/dismissed fields stay undefined).
 */
export function overlayUserState(items: any[], userId: string): void {
    const stateMap = fetchUserStateMap(items.map((i) => i.id), userId)
    for (const item of items) {
        const s = stateMap.get(item.id)
        if (!s) continue
        item.watched = !!s.watched
        item.lastWatched = s.last_watched_at ?? undefined
        item.continueWatchingDismissed = !!s.continue_watching_dismissed
        item.nextUpDismissed = !!s.next_up_dismissed
        item.nextUpEpisodeId = s.next_up_episode_id ?? undefined
    }
}
