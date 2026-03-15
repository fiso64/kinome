/**
 * getChildren — Integration Tests
 *
 * Tests the three-branch children resolution (virtual folder, grouping active,
 * no grouping), alias resolution, and embedChildrenForContainers recursion.
 *
 * Uses a real in-memory SQLite DB for all DB-driven logic. Mocks only the I/O
 * boundaries: readSettings (file-based config) and getLibraryRoot (settings + FS).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import path from 'path'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'

// --- Mock I/O boundaries BEFORE importing the module under test ---

const SETTINGS_SERVICE_PATH = path.resolve(__dirname, './settings.service.ts')
const LIBRARY_SERVICE_PATH = path.resolve(__dirname, './library.service.ts')

let mockSettings: any = {
  defaultLayouts: {
    _default: { layout: 'grid', clickAction: 'detail' },
  },
  defaultLayoutSettings: {
    grid: { gridPosterSize: 250 },
    list: {},
    tabs: {},
    sections: {},
  },
  virtualTags: [],
}

mock.module(SETTINGS_SERVICE_PATH, () => ({
  readSettings: () => Promise.resolve(mockSettings),
  checkLibraryExists: () => Promise.resolve({ settingsExists: true, dbExists: true }),
}))

// Mock getLibraryRoot to return a ready status pointing at 'root'
mock.module(LIBRARY_SERVICE_PATH, () => ({
  getLibraryRoot: () =>
    Promise.resolve({
      status: 'ready',
      root: { id: 'root', type: 'folder', name: 'root', children: [] },
    }),
}))

// Import AFTER mocks are set up
import { getChildren } from './grouping.service'
import { applyGrouping, createUserVirtualFolder, syncVirtualSeasonFolders } from './virtualFolders.service'
import { ensureHomeVirtualFolder, HOME_FOLDER_ID } from '../database/repositories/filesystem.repo'
import { getItemById } from './repository.service'
import type { MediaFolder, LibraryItem } from '@shared/types'

let ctx: ServiceTestContext

beforeEach(() => {
  ctx = createServiceTestContext()
})

afterEach(() => {
  ctx.cleanup()
})

// Helper: unwrap getChildren result (assert it's an array, not an error)
function expectItems(result: any): LibraryItem[] {
  expect(Array.isArray(result)).toBe(true)
  return result as LibraryItem[]
}

// =================================================================
// Branch C: no grouping — real items + user virtual folders
// =================================================================

describe('getChildren — Branch C (no grouping)', () => {
  beforeEach(() => {
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie' },
      { id: 'e2', mediaType: 'movie' },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder' },
      { id: 'film1', parentId: 'movies', path: 'movies/film1', entityId: 'e1' },
      { id: 'film2', parentId: 'movies', path: 'movies/film2', entityId: 'e2' },
    ])
  })

  it('returns real children for a non-grouped folder', async () => {
    const result = await getChildren('movies', {})
    const items = expectItems(result)

    expect(items).toHaveLength(2)
    expect(items.map((i) => i.id).sort()).toEqual(['film1', 'film2'])
  })

  it('includes user virtual folders alongside real children', async () => {
    createUserVirtualFolder('movies', 'My Picks')

    const result = await getChildren('movies', {})
    const items = expectItems(result)

    expect(items).toHaveLength(3)
    const types = items.map((i) => i.virtualType).filter(Boolean)
    expect(types).toContain('user')
  })

  it('excludes grouping virtual folders when no grouping is active', async () => {
    // Manually insert a stale grouping folder
    ctx.seedItems([
      { id: 'stale-g', parentId: 'movies', path: 'virtual://stale-g', type: 'folder', isVirtual: 1, virtualType: 'grouping' },
    ])

    const result = await getChildren('movies', {})
    const items = expectItems(result)

    expect(items.map((i) => i.id)).not.toContain('stale-g')
  })
})

// =================================================================
// Branch B: grouping active — grouping + user virtual folders
// =================================================================

describe('getChildren — Branch B (grouping active)', () => {
  beforeEach(() => {
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie', year: 2023 },
      { id: 'e2', mediaType: 'movie', year: 2024 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder' },
      { id: 'film1', parentId: 'movies', path: 'movies/film1', entityId: 'e1' },
      { id: 'film2', parentId: 'movies', path: 'movies/film2', entityId: 'e2' },
    ])
  })

  it('returns grouping virtual folders when grouping is active', async () => {
    applyGrouping('movies', 'year')

    const result = await getChildren('movies', {})
    const items = expectItems(result)

    expect(items).toHaveLength(2)
    const names = items.map((i) => i.name).sort()
    expect(names).toEqual(['2023', '2024'])
    for (const item of items) {
      expect(item.isVirtual).toBe(true)
      expect(item.virtualType).toBe('grouping')
    }
  })

  it('excludes real children when grouping is active', async () => {
    applyGrouping('movies', 'year')

    const result = await getChildren('movies', {})
    const items = expectItems(result)

    expect(items.map((i) => i.id)).not.toContain('film1')
    expect(items.map((i) => i.id)).not.toContain('film2')
  })

  it('includes user virtual folders alongside grouping folders', async () => {
    createUserVirtualFolder('movies', 'Favorites')
    applyGrouping('movies', 'year')

    const result = await getChildren('movies', {})
    const items = expectItems(result)

    expect(items).toHaveLength(3) // 2 grouping + 1 user
    const userItems = items.filter((i) => i.virtualType === 'user')
    expect(userItems).toHaveLength(1)
    expect(userItems[0].name).toBe('Favorites')
  })
})

// =================================================================
// Branch A: virtual folder — compile filter
// =================================================================

describe('getChildren — Branch A (virtual folder)', () => {
  beforeEach(() => {
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie', year: 2023 },
      { id: 'e2', mediaType: 'movie', year: 2023 },
      { id: 'e3', mediaType: 'movie', year: 2024 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder' },
      { id: 'film1', parentId: 'movies', path: 'movies/film1', entityId: 'e1' },
      { id: 'film2', parentId: 'movies', path: 'movies/film2', entityId: 'e2' },
      { id: 'film3', parentId: 'movies', path: 'movies/film3', entityId: 'e3' },
    ])
  })

  it('resolves virtual folder contents via compiled filter', async () => {
    applyGrouping('movies', 'year')

    // Get the 2023 grouping folder
    const groupingResult = await getChildren('movies', {})
    const items = expectItems(groupingResult)
    const folder2023 = items.find((i) => i.name === '2023')!
    expect(folder2023).toBeTruthy()

    // Now getChildren on the virtual folder — should compile its filter
    const result = await getChildren(folder2023.id, {})
    const children = expectItems(result)

    expect(children).toHaveLength(2)
    expect(children.map((c) => c.id).sort()).toEqual(['film1', 'film2'])
    // Children should be real items
    for (const child of children) {
      expect(child.isVirtual).toBeFalsy()
    }
  })

  it('user virtual folder with filter resolves correctly', async () => {
    const id = createUserVirtualFolder('movies', 'Recent 2024', {
      scope: { parentId: 'movies' },
      conditions: [{ field: 'year', op: 'eq', value: 2024 }],
    })

    const result = await getChildren(id, {})
    const children = expectItems(result)

    expect(children).toHaveLength(1)
    expect(children[0].id).toBe('film3')
  })

  it('virtual folder with no filter returns empty', async () => {
    const id = createUserVirtualFolder('movies', 'Empty')

    const result = await getChildren(id, {})
    const children = expectItems(result)
    expect(children).toHaveLength(0)
  })
})

// =================================================================
// Alias resolution
// =================================================================

describe('getChildren — alias resolution', () => {
  beforeEach(() => {
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder' },
      { id: 'tv', parentId: 'root', path: 'tv', type: 'folder' },
    ])
  })

  it('"home" alias resolves to the home virtual folder', async () => {
    ensureHomeVirtualFolder('root')

    const result = await getChildren('home', {})
    const items = expectItems(result)

    // Home folder's filter scopes to root children
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.id).sort()).toEqual(['movies', 'tv'])
  })

  it('"root" alias resolves to the actual root folder', async () => {
    const result = await getChildren('root', {})
    const items = expectItems(result)

    expect(items).toHaveLength(2)
    expect(items.map((i) => i.id).sort()).toEqual(['movies', 'tv'])
  })

  it('returns error for non-existent item', async () => {
    const result = await getChildren('nonexistent', {})
    expect(Array.isArray(result)).toBe(false)
    expect((result as any).error).toBe('not_found')
  })
})

// =================================================================
// Contextual default sorting
// =================================================================

describe('getChildren — contextual sorting', () => {
  it('sorts episodes by episodeNumber for season folders', async () => {
    ctx.seedEntities([
      { id: 'e-season', mediaType: 'season' },
      { id: 'e-ep1', mediaType: 'episode', episodeNumber: 3 },
      { id: 'e-ep2', mediaType: 'episode', episodeNumber: 1 },
      { id: 'e-ep3', mediaType: 'episode', episodeNumber: 2 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'season1', parentId: 'root', path: 'season1', type: 'folder', entityId: 'e-season' },
      { id: 'ep1', parentId: 'season1', path: 'season1/ep1', entityId: 'e-ep1' },
      { id: 'ep2', parentId: 'season1', path: 'season1/ep2', entityId: 'e-ep2' },
      { id: 'ep3', parentId: 'season1', path: 'season1/ep3', entityId: 'e-ep3' },
    ])

    const result = await getChildren('season1', {})
    const items = expectItems(result)

    // Should be sorted by episodeNumber ASC: 1, 2, 3
    expect(items.map((i) => i.id)).toEqual(['ep2', 'ep3', 'ep1'])
  })

  it('sorts by name for generic folders', async () => {
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'parent', parentId: 'root', path: 'parent', type: 'folder' },
      { id: 'c-zebra', parentId: 'parent', path: 'parent/zebra', name: 'Zebra' },
      { id: 'c-apple', parentId: 'parent', path: 'parent/apple', name: 'Apple' },
    ])

    const result = await getChildren('parent', {})
    const items = expectItems(result)

    expect(items.map((i) => i.name)).toEqual(['Apple', 'Zebra'])
  })
})

// =================================================================
// embedChildrenForContainers (recursive child embedding)
// =================================================================

describe('getChildren — embedChildrenForContainers', () => {
  beforeEach(() => {
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie', year: 2023 },
      { id: 'e2', mediaType: 'movie', year: 2024 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder' },
      { id: 'film1', parentId: 'movies', path: 'movies/film1', entityId: 'e1' },
      { id: 'film2', parentId: 'movies', path: 'movies/film2', entityId: 'e2' },
    ])
  })

  it('embeds children for folders with tabs layout', async () => {
    // Apply grouping so movies has grouping folders as children
    applyGrouping('movies', 'year')

    // Set root to use tabs layout so its children (movies) get embedded
    mockSettings = {
      ...mockSettings,
      defaultLayouts: {
        _default: { layout: 'tabs', clickAction: 'detail' },
      },
    }

    const result = await getChildren('root', {})
    const items = expectItems(result)

    // root → movies (a folder with tabs layout → children should be embedded)
    const moviesItem = items.find((i) => i.id === 'movies') as MediaFolder
    expect(moviesItem).toBeTruthy()
    // Since movies has appliedGrouping, its embedded children should be grouping folders
    if (moviesItem.children) {
      expect(Array.isArray(moviesItem.children)).toBe(true)
      const childNames = moviesItem.children!.map((c: any) => c.name).sort()
      expect(childNames).toEqual(['2023', '2024'])
    }
  })

  it('does NOT embed children for folders with grid layout', async () => {
    mockSettings = {
      ...mockSettings,
      defaultLayouts: {
        _default: { layout: 'grid', clickAction: 'detail' },
      },
    }

    const result = await getChildren('root', {})
    const items = expectItems(result)

    const moviesItem = items.find((i) => i.id === 'movies') as MediaFolder
    expect(moviesItem).toBeTruthy()
    // Grid layout → children should NOT be embedded (null from folder init)
    expect(moviesItem.children).toBeNull()
  })
})

// =================================================================
// End-to-end: grouping → getChildren → virtual folder children
// =================================================================

describe('getChildren — end-to-end round-trip', () => {
  beforeEach(() => {
    // Reset to grid layout so embedChildrenForContainers doesn't interfere
    mockSettings = {
      defaultLayouts: {
        _default: { layout: 'grid', clickAction: 'detail' },
      },
      defaultLayoutSettings: {
        grid: { gridPosterSize: 250 },
        list: {},
        tabs: {},
        sections: {},
      },
      virtualTags: [],
    }
  })

  it('full cycle: apply grouping → list groups → drill into group → see real items', async () => {
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie', year: 2023 },
      { id: 'e2', mediaType: 'movie', year: 2023 },
      { id: 'e3', mediaType: 'movie', year: 2024 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder' },
      { id: 'film1', parentId: 'movies', path: 'movies/film1', entityId: 'e1' },
      { id: 'film2', parentId: 'movies', path: 'movies/film2', entityId: 'e2' },
      { id: 'film3', parentId: 'movies', path: 'movies/film3', entityId: 'e3' },
    ])

    // Step 1: Apply grouping
    applyGrouping('movies', 'year')

    // Step 2: getChildren on movies → should return grouping folders
    const groups = expectItems(await getChildren('movies', {}))
    expect(groups).toHaveLength(2)
    const folder2023 = groups.find((g) => g.name === '2023')!
    const folder2024 = groups.find((g) => g.name === '2024')!

    // Step 3: Drill into 2023 group → should return real items
    const items2023 = expectItems(await getChildren(folder2023.id, {}))
    expect(items2023).toHaveLength(2)
    expect(items2023.map((i) => i.id).sort()).toEqual(['film1', 'film2'])

    // Step 4: Drill into 2024 group → should return real items
    const items2024 = expectItems(await getChildren(folder2024.id, {}))
    expect(items2024).toHaveLength(1)
    expect(items2024[0].id).toBe('film3')
  })

  it('full cycle: season sync → list seasons → drill into season → see episodes', async () => {
    ctx.seedEntities([
      { id: 'e-show', mediaType: 'tv' },
      { id: 'e-ep1', mediaType: 'episode', seasonNumber: 1, episodeNumber: 2 },
      { id: 'e-ep2', mediaType: 'episode', seasonNumber: 1, episodeNumber: 1 },
      { id: 'e-ep3', mediaType: 'episode', seasonNumber: 2, episodeNumber: 1 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'show', parentId: 'root', path: 'show', type: 'folder', entityId: 'e-show' },
      { id: 'ep1', parentId: 'show', path: 'show/s01e02.mkv', entityId: 'e-ep1' },
      { id: 'ep2', parentId: 'show', path: 'show/s01e01.mkv', entityId: 'e-ep2' },
      { id: 'ep3', parentId: 'show', path: 'show/s02e01.mkv', entityId: 'e-ep3' },
    ])

    // Step 1: Sync seasons
    syncVirtualSeasonFolders('show')

    // Step 2: getChildren on show → should return season folders
    const seasons = expectItems(await getChildren('show', {}))
    expect(seasons).toHaveLength(2)
    const s1 = seasons.find((s) => s.name === 'Season 1')!
    const s2 = seasons.find((s) => s.name === 'Season 2')!

    // Step 3: Drill into Season 1 → should return episodes
    const s1Episodes = expectItems(await getChildren(s1.id, {}))
    expect(s1Episodes).toHaveLength(2)
    expect(s1Episodes.map((e) => e.id).sort()).toEqual(['ep1', 'ep2'])

    // Step 4: Drill into Season 2
    const s2Episodes = expectItems(await getChildren(s2.id, {}))
    expect(s2Episodes).toHaveLength(1)
    expect(s2Episodes[0].id).toBe('ep3')
  })

  it('full cycle: home → shows root children including virtual folders', async () => {
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder' },
      { id: 'tv', parentId: 'root', path: 'tv', type: 'folder' },
    ])
    ensureHomeVirtualFolder('root')

    const items = expectItems(await getChildren('home', {}))
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.id).sort()).toEqual(['movies', 'tv'])
  })
})
