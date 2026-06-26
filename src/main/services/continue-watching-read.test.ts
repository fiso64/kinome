/**
 * getContinueWatchingItems — Pure Read Regression Test
 *
 * Regression: getContinueWatchingItems (a GET endpoint) had side effects that
 * caused an infinite loop:
 *   1. If an episode had no title, it fetched metadata from TMDB and broadcast
 *      updates, triggering a client refetch → infinite loop.
 *   2. If an episode was missing (dangling pointer), it recalculated nextUp
 *      and broadcast, also triggering refetches.
 *
 * This test asserts that getContinueWatchingItems is a pure read: it must
 * never call updateIfChangedAndBroadcast or trigger broadcasts.
 */
import { mock, spyOn } from 'bun:test'
import path from 'path'

// ─── Mock I/O boundaries BEFORE importing modules under test ────────────────

const RETRIEVER_PATH = path.resolve(__dirname, './retriever.service.ts')
const SETTINGS_PATH = path.resolve(__dirname, './settings.service.ts')

mock.module(RETRIEVER_PATH, () => ({
  search: async () => [],
  getDetails: async (tmdbId: number, type: string) => {
    if (type === 'tv') {
      return {
        id: tmdbId,
        name: 'Test Show',
        overview: 'A test show.',
        seasons: [{ season_number: 1, name: 'Season 1', overview: 'First.', poster_path: null }]
      }
    }
    return null
  },
  getCredits: async () => ({ cast: [], crew: [] }),
  getSeasonDetails: async (_showId: number, seasonNum: number) => ({
    episodes: [
      { episode_number: 1, name: 'Ep 1', overview: 'First ep.', still_path: null }
      // Note: only 1 episode in TMDB — ep2 has no match, title stays null
    ]
  }),
  cacheGenreLists: async () => {}
}))

mock.module(SETTINGS_PATH, () => ({
  readSettings: async () => ({
    tmdbApiKey: 'fake-key',
    virtualTags: [],
    playerCommands: [],
    customActions: [],
    useLogos: false,
    creditsDisplay: 'tab',
    grayOutWatched: false,
    showContinueWatching: false,
    showNextUp: false,
    libraryLocation: '',
    mediaSourcePath: '',
    mediaSourcePathIsRelative: false,
    defaultLayoutSettings: {},
    defaultLayouts: {},
    searchResultView: {},
    searchPopupView: {},
    itemDetailBackdropSize: 'small',
    itemDetailBackdropBlur: 0,
    serverPort: 3000,
    serverHost: '::'
  })
}))

// ─── Imports AFTER mocks ────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { getContinueWatchingItems, deleteItemFromDb } from './library.service'
import { updateUserState } from '../database/repositories/user.repo'
import { getItemById } from './repository.service'
import { getTransport } from '../transport.registry'

const USER_ID = 'user-a'

let ctx: ServiceTestContext

beforeEach(() => {
  ctx = createServiceTestContext()
})

afterEach(() => {
  ctx.cleanup()
})

/**
 * Seed a minimal TV show structure:
 *   root/
 *     show/     (tv, entity with tmdbId)
 *       season/ (season folder)
 *         ep1   (episode, has title)
 *         ep2   (episode, NO title — the trigger for the old bug)
 */
function seedShowWithEpisodes(opts: { ep2HasTitle: boolean } = { ep2HasTitle: true }) {
  ctx.seedEntities([
    { id: 'e-show', tmdbId: 1429, mediaType: 'tv', title: 'Test Show' },
    { id: 'e-season', mediaType: 'season', seasonNumber: 1 },
    { id: 'e-ep1', mediaType: 'episode', title: 'Episode 1', seasonNumber: 1, episodeNumber: 1 },
    {
      id: 'e-ep2',
      mediaType: 'episode',
      title: opts.ep2HasTitle ? 'Episode 2' : null,
      seasonNumber: 1,
      episodeNumber: 2
    }
  ])
  ctx.seedItems([
    { id: 'root', parentId: null, type: 'folder' },
    { id: 'show', parentId: 'root', type: 'folder', entityId: 'e-show' },
    { id: 'season', parentId: 'show', type: 'folder', entityId: 'e-season' },
    { id: 'ep1', parentId: 'season', type: 'file', entityId: 'e-ep1' },
    { id: 'ep2', parentId: 'season', type: 'file', entityId: 'e-ep2' }
  ])
  // Set ep1 as watched, nextUp points to ep2
  updateUserState('ep1', USER_ID, { watched: true })
  updateUserState('show', USER_ID, { nextUpEpisodeId: 'ep2', lastWatchedAt: Date.now() })
}

describe('getContinueWatchingItems', () => {
  it('returns the show and next episode', async () => {
    seedShowWithEpisodes({ ep2HasTitle: true })

    const results = await getContinueWatchingItems(USER_ID)

    expect(results).toHaveLength(1)
    expect(results[0].show.id).toBe('show')
    expect(results[0].nextEpisode.id).toBe('ep2')
  })

  it('returns episode without title and does not trigger side effects', async () => {
    seedShowWithEpisodes({ ep2HasTitle: false })

    const transport = getTransport()
    const spy = spyOn(transport, 'notifyLibraryItemsUpdated')

    const results = await getContinueWatchingItems(USER_ID)

    // Episode is still returned even without a title
    expect(results).toHaveLength(1)
    expect(results[0].nextEpisode.id).toBe('ep2')
    expect(results[0].nextEpisode.title).toBeFalsy()

    // Reading should not trigger any broadcasts (old bug: caused infinite loop)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('does not broadcast when nextUpEpisodeId points to a missing episode', async () => {
    seedShowWithEpisodes({ ep2HasTitle: true })
    // Delete ep2 to create a dangling pointer
    ctx.db.prepare('DELETE FROM media_items WHERE id = ?').run('ep2')

    const transport = getTransport()
    const spy = spyOn(transport, 'notifyLibraryItemsUpdated')

    const results = await getContinueWatchingItems(USER_ID)

    expect(results).toHaveLength(0) // ep2 is gone, show is skipped
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('deleteItemFromDb — nextUp recalculation', () => {
  it('recalculates nextUpEpisodeId when the pointed-to episode is deleted', async () => {
    // Seed show with 3 episodes: ep1 watched, nextUp=ep2, ep3 unwatched
    ctx.seedEntities([
      { id: 'e-show', tmdbId: 1429, mediaType: 'tv', title: 'Test Show' },
      { id: 'e-season', mediaType: 'season', seasonNumber: 1 },
      { id: 'e-ep1', mediaType: 'episode', title: 'Ep 1', seasonNumber: 1, episodeNumber: 1 },
      { id: 'e-ep2', mediaType: 'episode', title: 'Ep 2', seasonNumber: 1, episodeNumber: 2 },
      { id: 'e-ep3', mediaType: 'episode', title: 'Ep 3', seasonNumber: 1, episodeNumber: 3 }
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'show', parentId: 'root', type: 'folder', entityId: 'e-show' },
      { id: 'season', parentId: 'show', type: 'folder', entityId: 'e-season' },
      { id: 'ep1', parentId: 'season', type: 'file', entityId: 'e-ep1' },
      { id: 'ep2', parentId: 'season', type: 'file', entityId: 'e-ep2' },
      { id: 'ep3', parentId: 'season', type: 'file', entityId: 'e-ep3' }
    ])
    updateUserState('ep1', USER_ID, { watched: true })
    updateUserState('show', USER_ID, { nextUpEpisodeId: 'ep2', lastWatchedAt: Date.now() })

    // Verify initial state
    const before = await getContinueWatchingItems(USER_ID)
    expect(before).toHaveLength(1)
    expect(before[0].nextEpisode.id).toBe('ep2')

    // Delete ep2 — the episode that nextUp points to
    await deleteItemFromDb('ep2')

    // After deletion, nextUp should advance to ep3
    const after = await getContinueWatchingItems(USER_ID)
    expect(after).toHaveLength(1)
    expect(after[0].nextEpisode.id).toBe('ep3')
  })

  it('clears nextUpEpisodeId when the last unwatched episode is deleted', async () => {
    ctx.seedEntities([
      { id: 'e-show', tmdbId: 1429, mediaType: 'tv', title: 'Test Show' },
      { id: 'e-season', mediaType: 'season', seasonNumber: 1 },
      { id: 'e-ep1', mediaType: 'episode', title: 'Ep 1', seasonNumber: 1, episodeNumber: 1 },
      { id: 'e-ep2', mediaType: 'episode', title: 'Ep 2', seasonNumber: 1, episodeNumber: 2 }
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'show', parentId: 'root', type: 'folder', entityId: 'e-show' },
      { id: 'season', parentId: 'show', type: 'folder', entityId: 'e-season' },
      { id: 'ep1', parentId: 'season', type: 'file', entityId: 'e-ep1' },
      { id: 'ep2', parentId: 'season', type: 'file', entityId: 'e-ep2' }
    ])
    updateUserState('ep1', USER_ID, { watched: true })
    updateUserState('show', USER_ID, { nextUpEpisodeId: 'ep2', lastWatchedAt: Date.now() })

    // Delete ep2 — the only unwatched episode
    await deleteItemFromDb('ep2')

    // Show should no longer appear in continue watching (no next episode)
    const after = await getContinueWatchingItems(USER_ID)
    expect(after).toHaveLength(0)
  })
})
