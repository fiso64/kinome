/**
 * User Repository Tests
 *
 * Tests for per-user watched state storage and isolation.
 * Covers the core contract: each userId has independent state
 * for the same item, with no cross-contamination.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SCHEMA_SQL } from '../schema'
import { _setDbForTesting, _clearDbForTesting } from '../client'
import {
  updateUserState,
  bulkSetWatched,
  fetchUserState,
  fetchUserStateMap,
  overlayUserState
} from './user.repo'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  _setDbForTesting(db)

  // Seed a couple of items so the FK constraints are satisfied
  db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, NULL, '.', 'root', 'folder')`).run('root')
  db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, 'f1', 'file1', 'file')`).run('item-1', 'root')
  db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, 'f2', 'file2', 'file')`).run('item-2', 'root')
  db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, 'f3', 'file3', 'file')`).run('item-3', 'root')
})

afterEach(() => {
  db.close()
  _clearDbForTesting()
})

// ─── updateUserState ─────────────────────────────────────────────────────────

describe('updateUserState', () => {
  it('creates a new row when none exists', () => {
    updateUserState('item-1', 'user-a', { watched: true })
    const row = fetchUserState('item-1', 'user-a')
    expect(row).not.toBeNull()
    expect(row.watched).toBe(1)
  })

  it('updates existing row on conflict', () => {
    updateUserState('item-1', 'user-a', { watched: false })
    updateUserState('item-1', 'user-a', { watched: true, lastWatchedAt: 1000 })
    const row = fetchUserState('item-1', 'user-a')
    expect(row.watched).toBe(1)
    expect(row.last_watched_at).toBe(1000)
  })

  it('partial update preserves existing fields', () => {
    // First set lastWatchedAt
    updateUserState('item-1', 'user-a', { watched: true, lastWatchedAt: 9999 })
    // Now update only continueWatchingDismissed
    updateUserState('item-1', 'user-a', { continueWatchingDismissed: true })
    const row = fetchUserState('item-1', 'user-a')
    expect(row.last_watched_at).toBe(9999) // preserved
    expect(row.continue_watching_dismissed).toBe(1)
    expect(row.watched).toBe(1) // preserved
  })

  it('two users can have independent states for the same item', () => {
    updateUserState('item-1', 'user-a', { watched: true })
    updateUserState('item-1', 'user-b', { watched: false })

    const rowA = fetchUserState('item-1', 'user-a')
    const rowB = fetchUserState('item-1', 'user-b')

    expect(rowA.watched).toBe(1)
    expect(rowB.watched).toBe(0)
  })

  it('updating one user does not affect the other', () => {
    updateUserState('item-1', 'user-a', { watched: true })
    updateUserState('item-1', 'user-b', { watched: false })

    // Re-mark user-a as unwatched
    updateUserState('item-1', 'user-a', { watched: false })

    const rowA = fetchUserState('item-1', 'user-a')
    const rowB = fetchUserState('item-1', 'user-b')
    expect(rowA.watched).toBe(0)
    expect(rowB.watched).toBe(0)
  })

  it('stores nextUpEpisodeId', () => {
    updateUserState('item-1', 'user-a', { nextUpEpisodeId: 'ep-42' })
    const row = fetchUserState('item-1', 'user-a')
    expect(row.next_up_episode_id).toBe('ep-42')
  })

  it('can clear nextUpEpisodeId to null', () => {
    updateUserState('item-1', 'user-a', { nextUpEpisodeId: 'ep-42' })
    updateUserState('item-1', 'user-a', { nextUpEpisodeId: null })
    const row = fetchUserState('item-1', 'user-a')
    expect(row.next_up_episode_id).toBeNull()
  })
})

// ─── bulkSetWatched ──────────────────────────────────────────────────────────

describe('bulkSetWatched', () => {
  it('marks multiple items as watched for one user', () => {
    bulkSetWatched(['item-1', 'item-2', 'item-3'], 'user-a', true, 5000)

    for (const id of ['item-1', 'item-2', 'item-3']) {
      const row = fetchUserState(id, 'user-a')
      expect(row.watched).toBe(1)
      expect(row.last_watched_at).toBe(5000)
    }
  })

  it('marks multiple items as unwatched', () => {
    bulkSetWatched(['item-1', 'item-2'], 'user-a', true, 1000)
    bulkSetWatched(['item-1', 'item-2'], 'user-a', false, 2000)
    expect(fetchUserState('item-1', 'user-a').watched).toBe(0)
    expect(fetchUserState('item-2', 'user-a').watched).toBe(0)
  })

  it('does not affect other users', () => {
    updateUserState('item-1', 'user-b', { watched: false })
    bulkSetWatched(['item-1'], 'user-a', true, 1000)

    expect(fetchUserState('item-1', 'user-a').watched).toBe(1)
    expect(fetchUserState('item-1', 'user-b').watched).toBe(0)
  })

  it('is a no-op for an empty array', () => {
    expect(() => bulkSetWatched([], 'user-a', true, 1000)).not.toThrow()
  })
})

// ─── fetchUserStateMap ───────────────────────────────────────────────────────

describe('fetchUserStateMap', () => {
  it('returns an empty map when no user state exists', () => {
    const map = fetchUserStateMap(['item-1', 'item-2'], 'user-a')
    expect(map.size).toBe(0)
  })

  it('returns only entries for the specified user', () => {
    updateUserState('item-1', 'user-a', { watched: true })
    updateUserState('item-1', 'user-b', { watched: false })
    updateUserState('item-2', 'user-a', { watched: true })

    const map = fetchUserStateMap(['item-1', 'item-2'], 'user-a')
    expect(map.size).toBe(2)
    expect(map.get('item-1')!.watched).toBe(1)
    expect(map.get('item-2')!.watched).toBe(1)
    // user-b's item-1 entry must not appear
    expect(map.get('item-1')!.user_id).toBe('user-a')
  })

  it('is keyed by item_id', () => {
    updateUserState('item-1', 'user-a', { watched: true })
    updateUserState('item-2', 'user-a', { watched: false })
    const map = fetchUserStateMap(['item-1', 'item-2'], 'user-a')
    expect(map.has('item-1')).toBe(true)
    expect(map.has('item-2')).toBe(true)
  })

  it('returns an empty map for an empty id list', () => {
    const map = fetchUserStateMap([], 'user-a')
    expect(map.size).toBe(0)
  })
})

// ─── overlayUserState ────────────────────────────────────────────────────────

describe('overlayUserState', () => {
  it('mutates items with the correct user state', () => {
    updateUserState('item-1', 'user-a', { watched: true, lastWatchedAt: 12345 })

    const items: any[] = [{ id: 'item-1' }]
    overlayUserState(items, 'user-a')

    expect(items[0].watched).toBe(true)
    expect(items[0].lastWatched).toBe(12345)
  })

  it('does not overlay state from a different user', () => {
    updateUserState('item-1', 'user-b', { watched: true })

    const items: any[] = [{ id: 'item-1' }]
    overlayUserState(items, 'user-a')

    // user-a has no state for item-1, so watched should not be set
    expect(items[0].watched).toBeUndefined()
  })

  it('leaves items with no state row unchanged', () => {
    const items: any[] = [{ id: 'item-1', someOtherField: 'keep-me' }]
    overlayUserState(items, 'user-a')

    expect(items[0].someOtherField).toBe('keep-me')
    expect(items[0].watched).toBeUndefined()
  })

  it('correctly overlays multiple items from one batch call', () => {
    updateUserState('item-1', 'user-a', { watched: true })
    updateUserState('item-2', 'user-a', { watched: false })
    // item-3 has no row for user-a

    const items: any[] = [
      { id: 'item-1' },
      { id: 'item-2' },
      { id: 'item-3' }
    ]
    overlayUserState(items, 'user-a')

    expect(items[0].watched).toBe(true)
    expect(items[1].watched).toBe(false)
    expect(items[2].watched).toBeUndefined()
  })

  it('overlays continueWatchingDismissed and nextUpDismissed', () => {
    updateUserState('item-1', 'user-a', {
      continueWatchingDismissed: true,
      nextUpDismissed: true
    })

    const items: any[] = [{ id: 'item-1' }]
    overlayUserState(items, 'user-a')

    expect(items[0].continueWatchingDismissed).toBe(true)
    expect(items[0].nextUpDismissed).toBe(true)
  })

  it('two users get independent overlays on the same item list', () => {
    updateUserState('item-1', 'user-a', { watched: true })
    updateUserState('item-1', 'user-b', { watched: false })

    const itemsForA: any[] = [{ id: 'item-1' }]
    const itemsForB: any[] = [{ id: 'item-1' }]

    overlayUserState(itemsForA, 'user-a')
    overlayUserState(itemsForB, 'user-b')

    expect(itemsForA[0].watched).toBe(true)
    expect(itemsForB[0].watched).toBe(false)
  })
})
