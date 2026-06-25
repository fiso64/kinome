/**
 * TV Show Phase 2 Enrichment — End-to-End Regression Test
 *
 * Regression: After the multi-account refactor, Phase 2 metadata enrichment
 * crashed for all TV shows with:
 *   "_updateItem: userId required when updating user state fields"
 *
 * Root cause: 'watched' is in CORE_FIELDS, so items fetched via getChildren()
 * without a userId have watched=null (from the 1=0 user_state JOIN). When
 * updateIfChangedAndBroadcast passes those items to _updateItem, it sees
 * null !== undefined and incorrectly throws the userId guard.
 *
 * This test simulates a realistic scan + Phase 2 enrichment scenario:
 * a TV show folder with a season is identified (tmdbId set), enrichment
 * is triggered, and we assert the show gets its metadata persisted to DB.
 */
import { mock } from 'bun:test'
import path from 'path'

// ─── Mock I/O boundaries BEFORE importing the modules under test ─────────────

const RETRIEVER_PATH = path.resolve(__dirname, './retriever.service.ts')
const SETTINGS_PATH = path.resolve(__dirname, './settings.service.ts')

mock.module(RETRIEVER_PATH, () => ({
  search: async () => [],
  getDetails: async (tmdbId: number, type: string) => {
    if (type === 'tv') {
      return {
        id: tmdbId,
        name: 'Smiling Friends',
        overview: 'A chaotic cartoon show.',
        seasons: [{ season_number: 1, name: 'Season 1', overview: 'First season.', poster_path: null }]
      }
    }
    if (type === 'movie') {
      return {
        id: tmdbId,
        title: 'Perfect Blue',
        overview: 'A pop singer becomes an actress.',
        release_date: '1998-02-28',
        runtime: 82,
        genres: [],
        poster_path: null,
        backdrop_path: null
      }
    }
    return null
  },
  getCredits: async () => ({ cast: [], crew: [] }),
  getSeasonDetails: async () => null,    // no episode detail fetching needed
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

// ─── Imports AFTER mocks ─────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { fetchAndApplyMetadata } from './metadata.service'
import { getItemById } from './repository.service'
import type { MediaFolder } from '@shared/types'

let ctx: ServiceTestContext

beforeEach(() => {
  ctx = createServiceTestContext()
})

afterEach(() => {
  ctx.cleanup()
})

describe('TV show Phase 2 enrichment (end-to-end)', () => {
  it('persists show metadata and season structure after enrichment, without crashing on user-state fields', async () => {
    // Seed a TV show whose tmdbId was already identified (e.g., user did a manual match,
    // or a previous partial scan set it). lastRefreshedAt is null so enrichment runs again.
    ctx.seedEntities([{ id: 'e-show', tmdbId: 12345, mediaType: 'tv', title: null }])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      // TV show folder — dirty (no title, lastRefreshedAt=null in entity)
      { id: 'show-1', parentId: 'root', type: 'folder', entityId: 'e-show', name: 'Smiling Friends' },
      // Season subfolder — no entity, no mediaType yet (will be assigned by syncTvShowStructure)
      { id: 'season-1', parentId: 'show-1', type: 'folder', name: 'Season 01' }
    ])

    const show = getItemById('show-1') as MediaFolder

    // Simulate Phase 2 enrichment. Before the fix this threw:
    //   "_updateItem: userId required when updating user state fields"
    // because getChildren() returns items with watched=null (CORE_FIELDS + 1=0 JOIN).
    // The call must complete without throwing.
    const result = await fetchAndApplyMetadata(show, {})
    expect(result.length).toBeGreaterThan(0)

    // The show title must be persisted to the DB after enrichment
    const updatedShow = getItemById('show-1')
    expect(updatedShow?.title).toBe('Smiling Friends')

    // The season must be recognised and assigned mediaType='season' in the DB
    const updatedSeason = getItemById('season-1')
    expect(updatedSeason?.mediaType).toBe('season')
  })
})

describe('Movie Phase 2 enrichment (end-to-end)', () => {
  it('persists TMDB runtime for movies', async () => {
    ctx.seedEntities([{ id: 'e-movie', tmdbId: 10494, mediaType: 'movie', title: null }])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'movie-1', parentId: 'root', type: 'file', entityId: 'e-movie', name: 'Perfect Blue.mkv' }
    ])

    const movie = getItemById('movie-1')!
    const result = await fetchAndApplyMetadata(movie, {})

    expect(result.length).toBeGreaterThan(0)

    const updatedMovie = getItemById('movie-1')
    expect(updatedMovie?.title).toBe('Perfect Blue')
    expect(updatedMovie?.year).toBe(1998)
    expect(updatedMovie?.tmdbRuntime).toBe(82)
  })
})
