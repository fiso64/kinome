/**
 * User-State Isolation Integration Tests
 *
 * Tests the full pipeline of per-user watched state:
 *   - buildFindQuery correctly scopes user_state to the requesting user
 *   - find() with/without userId returns correct watched values
 *   - updateIfChangedAndBroadcast with userId writes only to that user's row
 *   - Two users working on the same library items have fully independent state
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from './test-helpers'
import { find } from '../services/repository.service'
import { updateIfChangedAndBroadcast } from '../services/item-update.service'
import { updateUserState } from './repositories/user.repo'
import type { LibraryItem, Settings } from '@shared/types'

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    playerCommands: [],
    customActions: [],
    tmdbApiKey: '',
    useLogos: true,
    creditsDisplay: 'tab',
    grayOutWatched: true,
    showContinueWatching: true,
    showNextUp: true,
    virtualTags: [],
    libraryLocation: '',
    mediaSourcePath: '',
    mediaSourcePathIsRelative: false,
    defaultLayoutSettings: {} as any,
    defaultLayouts: {} as any,
    searchResultView: {} as any,
    searchPopupView: {} as any,
    itemDetailBackdropSize: 'small',
    itemDetailBackdropBlur: 4,
    serverPort: 3000,
    serverHost: '::',
    ...overrides
  } as Settings
}

const SETTINGS = makeSettings()

describe('user-state isolation', () => {
  let ctx: ServiceTestContext

  beforeEach(() => {
    ctx = createServiceTestContext()

    // Seed a small library
    ctx.seedEntities([{ id: 'e1', mediaType: 'movie' }])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'movie-1', parentId: 'root', type: 'file', entityId: 'e1' },
      { id: 'movie-2', parentId: 'root', type: 'file', entityId: 'e1' }
    ])
  })

  afterEach(() => {
    ctx.cleanup()
  })

  // ─── buildFindQuery / find() with userId ─────────────────────────────────────

  describe('find() user_state scoping', () => {
    it('returns undefined watched when no userId is provided', () => {
      updateUserState('movie-1', 'user-a', { watched: true })
      const items = find({ where: { parentId: 'root' }, fields: ['watched'] })
      // Without userId the JOIN resolves to NULL → undefined/falsy
      for (const item of items) {
        expect(item.watched).toBeFalsy()
      }
    })

    it('returns the correct user watched state when userId is provided', () => {
      updateUserState('movie-1', 'user-a', { watched: true })
      updateUserState('movie-1', 'user-b', { watched: false })

      const itemsA = find({ where: { id: 'movie-1' }, fields: ['watched'], userId: 'user-a' })
      const itemsB = find({ where: { id: 'movie-1' }, fields: ['watched'], userId: 'user-b' })

      expect(itemsA[0].watched).toBe(true)
      expect(!!itemsB[0].watched).toBe(false)
    })

    it('user-b does not see user-a watched state', () => {
      // Only user-a has a state row for movie-1
      updateUserState('movie-1', 'user-a', { watched: true })

      const itemsB = find({ where: { id: 'movie-1' }, fields: ['watched'], userId: 'user-b' })
      expect(itemsB[0].watched).toBeFalsy()
    })

    it('items without a user_state row still appear in results (LEFT JOIN)', () => {
      // user-a only has state for movie-1, not movie-2
      updateUserState('movie-1', 'user-a', { watched: true })

      const items = find({ where: { parentId: 'root' }, fields: ['watched'], userId: 'user-a' })
      expect(items).toHaveLength(2)
      const m2 = items.find((i) => i.id === 'movie-2')
      expect(m2).toBeDefined()
      expect(m2!.watched).toBeFalsy()
    })
  })

  // ─── updateIfChangedAndBroadcast with userId ─────────────────────────────────

  describe('updateIfChangedAndBroadcast user_state writes', () => {
    it('writes watched state to user_state for the correct user', async () => {
      await updateIfChangedAndBroadcast(
        { id: 'movie-1', watched: true } as LibraryItem,
        { settings: SETTINGS, userId: 'user-a' }
      )

      const row = ctx.db
        .prepare('SELECT watched FROM user_state WHERE item_id = ? AND user_id = ?')
        .get('movie-1', 'user-a') as any
      expect(row).not.toBeNull()
      expect(row.watched).toBe(1)
    })

    it('does not create a user_state row for other users', async () => {
      await updateIfChangedAndBroadcast(
        { id: 'movie-1', watched: true } as LibraryItem,
        { settings: SETTINGS, userId: 'user-a' }
      )

      const rowB = ctx.db
        .prepare('SELECT * FROM user_state WHERE item_id = ? AND user_id = ?')
        .get('movie-1', 'user-b') as any
      expect(rowB).toBeNull()
    })

    it('two independent updates do not cross-contaminate watched state', async () => {
      await updateIfChangedAndBroadcast(
        { id: 'movie-1', watched: true } as LibraryItem,
        { settings: SETTINGS, userId: 'user-a' }
      )
      await updateIfChangedAndBroadcast(
        { id: 'movie-1', watched: false } as LibraryItem,
        { settings: SETTINGS, userId: 'user-b' }
      )

      const rowA = ctx.db
        .prepare('SELECT watched FROM user_state WHERE item_id = ? AND user_id = ?')
        .get('movie-1', 'user-a') as any
      const rowB = ctx.db
        .prepare('SELECT watched FROM user_state WHERE item_id = ? AND user_id = ?')
        .get('movie-1', 'user-b') as any

      expect(rowA.watched).toBe(1)
      expect(rowB.watched).toBe(0)
    })

    it('metadata updates (non user-state fields) do not require userId', async () => {
      // Metadata changes like title should succeed without a userId
      await expect(
        updateIfChangedAndBroadcast(
          { id: 'movie-1', title: 'Updated Title' } as LibraryItem,
          { settings: SETTINGS }
        )
      ).resolves.toBeUndefined()
    })

    it('throws when user-state fields are present but no userId provided', async () => {
      await expect(
        updateIfChangedAndBroadcast(
          { id: 'movie-1', watched: true } as LibraryItem,
          { settings: SETTINGS } // no userId
        )
      ).rejects.toThrow()
    })
  })

  // ─── find() orderBy lastWatched is per-user ───────────────────────────────────

  describe('ordering by lastWatched is scoped to requesting user', () => {
    it('user-a order is independent of user-b timestamps', () => {
      // user-a: watched movie-2 more recently
      updateUserState('movie-1', 'user-a', { watched: true, lastWatchedAt: 1000 })
      updateUserState('movie-2', 'user-a', { watched: true, lastWatchedAt: 2000 })
      // user-b: watched movie-1 more recently
      updateUserState('movie-1', 'user-b', { watched: true, lastWatchedAt: 3000 })
      updateUserState('movie-2', 'user-b', { watched: true, lastWatchedAt: 500 })

      const itemsA = find({ where: { parentId: 'root' }, fields: ['lastWatched'], orderBy: { field: 'lastWatched', direction: 'DESC' }, userId: 'user-a' })
      const itemsB = find({ where: { parentId: 'root' }, fields: ['lastWatched'], orderBy: { field: 'lastWatched', direction: 'DESC' }, userId: 'user-b' })

      // user-a: movie-2 first (lastWatched=2000)
      expect(itemsA[0].id).toBe('movie-2')
      // user-b: movie-1 first (lastWatched=3000)
      expect(itemsB[0].id).toBe('movie-1')
    })
  })
})
