/**
 * fetchAndApplyEpisodeData — Change Detection Tests
 *
 * Regression: fetchAndApplyEpisodeData unconditionally pushed every episode
 * to its modifiedItems list, even when nothing changed. Combined with
 * lastRefreshedAt = Date.now() on the season folder, this caused unnecessary
 * broadcasts on every enrichment run.
 *
 * These tests assert that only actually-changed items are returned.
 */
import { mock } from 'bun:test'
import path from 'path'

// ─── Mock I/O boundaries BEFORE importing modules under test ────────────────

const RETRIEVER_PATH = path.resolve(__dirname, './retriever.service.ts')
const PATHS_PATH = path.resolve(__dirname, './paths.service.ts')

mock.module(RETRIEVER_PATH, () => ({
  search: async () => [],
  getDetails: async () => null,
  getCredits: async () => ({ cast: [], crew: [] }),
  getSeasonDetails: async (_showId: number, _seasonNum: number) => ({
    episodes: [
      { episode_number: 1, name: 'Pilot', overview: 'The first episode.', still_path: null },
      { episode_number: 2, name: 'Second', overview: 'The second episode.', still_path: null }
    ]
  }),
  cacheGenreLists: async () => {}
}))

mock.module(PATHS_PATH, () => ({
  getLibraryDataPath: () => '/tmp/kinome-test',
  isRemoteLibrary: () => false,
  resolveAssetPath: () => null,
  setLibraryDataPath: () => {},
  setUserDataPath: () => {}
}))

// ─── Imports AFTER mocks ────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { fetchAndApplyEpisodeData } from './metadata-processing.service'
import { updateIfChangedAndBroadcast } from './item-update.service'
import { getItemById } from './repository.service'
import type { MediaFolder, TmdbSeason } from '@shared/types'

let ctx: ServiceTestContext

beforeEach(() => {
  ctx = createServiceTestContext()
})

afterEach(() => {
  ctx.cleanup()
})

const TMDB_SEASONS: TmdbSeason[] = [
  { season_number: 1, name: 'Season 1', overview: 'First.', poster_path: null } as TmdbSeason
]

function seedSeason() {
  ctx.seedEntities([
    { id: 'e-season', mediaType: 'season', seasonNumber: 1 },
    { id: 'e-ep1', mediaType: 'episode', seasonNumber: 1, episodeNumber: 1 },
    { id: 'e-ep2', mediaType: 'episode', seasonNumber: 1, episodeNumber: 2 },
    // ep3 has no TMDB match (only 2 episodes in mock)
    { id: 'e-ep3', mediaType: 'episode', seasonNumber: 1, episodeNumber: 3 }
  ])
  ctx.seedItems([
    { id: 'root', parentId: null, type: 'folder' },
    { id: 'season', parentId: 'root', type: 'folder', entityId: 'e-season' },
    { id: 'ep1', parentId: 'season', type: 'file', entityId: 'e-ep1' },
    { id: 'ep2', parentId: 'season', type: 'file', entityId: 'e-ep2' },
    { id: 'ep3', parentId: 'season', type: 'file', entityId: 'e-ep3' }
  ])
}

describe('fetchAndApplyEpisodeData', () => {
  it('returns modified items on first run (episodes get titles)', async () => {
    seedSeason()
    const season = getItemById('season') as MediaFolder

    const modified = await fetchAndApplyEpisodeData(
      season, 1429, 'fake-key', '/tmp', TMDB_SEASONS
    )

    // Season folder + ep1 + ep2 should be modified (got titles).
    // ep3 has no TMDB match so it shouldn't be modified (nothing to clear if already empty).
    const modifiedIds = modified.map(m => m.id)
    expect(modifiedIds).toContain('season') // season got tmdbEpisodes cached
    expect(modifiedIds).toContain('ep1')
    expect(modifiedIds).toContain('ep2')
  })

  it('returns empty list when called again with no changes', async () => {
    seedSeason()
    const season = getItemById('season') as MediaFolder

    // First run — applies metadata, then persist to DB
    const firstRun = await fetchAndApplyEpisodeData(season, 1429, 'fake-key', '/tmp', TMDB_SEASONS)
    await updateIfChangedAndBroadcast(firstRun)

    // Second run — nothing should have changed
    const seasonAgain = getItemById('season') as MediaFolder
    const modified = await fetchAndApplyEpisodeData(
      seasonAgain, 1429, 'fake-key', '/tmp', TMDB_SEASONS
    )

    expect(modified).toHaveLength(0)
  })
})
