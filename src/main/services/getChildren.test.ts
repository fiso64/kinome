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
import { getChildren, resolveViewHierarchy } from './grouping.service'
import { applyGrouping, createUserVirtualFolder, syncVirtualSeasonFolders } from './virtualFolders.service'
import { mergeSettings } from '../database/repositories/settings.repo'
import { ensureHomeVirtualFolder, HOME_FOLDER_ID } from '../database/repositories/filesystem.repo'
import { getItemById, find } from './repository.service'
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
  it('tabs parent embeds children for grid-layout child folders', async () => {
    // Simulates: TV show (tabs) → physical Season folders (grid) → episodes
    ctx.seedEntities([
      { id: 'e-show', mediaType: 'tv' },
      { id: 'e-s1', mediaType: 'season', seasonNumber: 1 },
      { id: 'e-ep1', mediaType: 'episode', seasonNumber: 1, episodeNumber: 1 },
      { id: 'e-ep2', mediaType: 'episode', seasonNumber: 1, episodeNumber: 2 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'show', parentId: 'root', path: 'show', type: 'folder', entityId: 'e-show' },
      { id: 's1', parentId: 'show', path: 'show/s1', type: 'folder', entityId: 'e-s1' },
      { id: 'ep1', parentId: 's1', path: 'show/s1/ep1', entityId: 'e-ep1' },
      { id: 'ep2', parentId: 's1', path: 'show/s1/ep2', entityId: 'e-ep2' },
    ])
    // show gets tabs layout via TV default; season children get grid
    mockSettings = {
      ...mockSettings,
      defaultLayouts: {
        _default: { layout: 'grid', clickAction: 'detail' },
        tv: { layout: 'tabs', clickAction: 'navigate' },
      },
    }

    const result = await getChildren('show', {})
    const items = expectItems(result)

    const s1Item = items.find((i) => i.id === 's1') as MediaFolder
    expect(s1Item).toBeTruthy()
    expect(Array.isArray(s1Item.children)).toBe(true)
    expect(s1Item.children).toHaveLength(2)
    expect(s1Item.children!.map((c: any) => c.id).sort()).toEqual(['ep1', 'ep2'])
  })

  it('sections parent embeds children for child folders', async () => {
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
    // Apply grouping so movies has virtual grouping children
    applyGrouping('movies', 'year')
    mockSettings = {
      ...mockSettings,
      defaultLayouts: {
        _default: { layout: 'sections', clickAction: 'detail' },
      },
    }

    const result = await getChildren('root', {})
    const items = expectItems(result)

    const moviesItem = items.find((i) => i.id === 'movies') as MediaFolder
    expect(moviesItem).toBeTruthy()
    expect(Array.isArray(moviesItem.children)).toBe(true)
  })

  it('grid parent does NOT embed children', async () => {
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'sub', parentId: 'root', path: 'sub', type: 'folder' },
      { id: 'child', parentId: 'sub', path: 'sub/child' },
    ])
    mockSettings = {
      ...mockSettings,
      defaultLayouts: {
        _default: { layout: 'grid', clickAction: 'detail' },
      },
    }

    const result = await getChildren('root', {})
    const items = expectItems(result)

    const subItem = items.find((i) => i.id === 'sub') as MediaFolder
    expect(subItem).toBeTruthy()
    expect(subItem.children).toBeNull()
  })

  it('embedding recurses for nested container layouts', async () => {
    // root (tabs) → section-folder (sections) → inner-folder (grid) → items
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'section-folder', parentId: 'root', path: 'sf', type: 'folder' },
      { id: 'inner-folder', parentId: 'section-folder', path: 'sf/inner', type: 'folder' },
      { id: 'item1', parentId: 'inner-folder', path: 'sf/inner/item1' },
    ])
    // section-folder explicitly uses sections layout
    ctx.seedFolderSettings([
      { itemId: 'section-folder', viewSettings: { layout: 'sections' } },
    ])
    mockSettings = {
      ...mockSettings,
      defaultLayouts: {
        _default: { layout: 'tabs', clickAction: 'detail' },
      },
    }

    const result = await getChildren('root', {})
    const items = expectItems(result)

    // root is tabs → section-folder gets children embedded
    const sf = items.find((i) => i.id === 'section-folder') as MediaFolder
    expect(sf).toBeTruthy()
    expect(Array.isArray(sf.children)).toBe(true)
    expect(sf.children).toHaveLength(1)

    // section-folder is sections → inner-folder gets children embedded too
    const inner = sf.children![0] as MediaFolder
    expect(inner.id).toBe('inner-folder')
    expect(Array.isArray(inner.children)).toBe(true)
    expect(inner.children).toHaveLength(1)
    expect(inner.children![0].id).toBe('item1')
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

  it('full cycle: home with grouping → returns grouping virtual folders, not raw pool items', async () => {
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie' },
      { id: 'e2', mediaType: 'tv' },
      { id: 'e3', mediaType: 'movie' },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'film1', parentId: 'root', path: 'film1', type: 'folder', entityId: 'e1' },
      { id: 'show1', parentId: 'root', path: 'show1', type: 'folder', entityId: 'e2' },
      { id: 'film2', parentId: 'root', path: 'film2', type: 'folder', entityId: 'e3' },
    ])
    ensureHomeVirtualFolder('root')

    // Apply grouping by mediaType on the home virtual folder
    applyGrouping(HOME_FOLDER_ID, 'mediaType')

    // getChildren('home') should return grouping virtual folders (movie, tv),
    // NOT the raw pool items (film1, show1, film2)
    const result = await getChildren('home', {})
    const items = expectItems(result)

    expect(items).toHaveLength(2)
    const names = items.map((i) => i.name).sort()
    expect(names).toEqual(['movie', 'tv'])
    for (const item of items) {
      expect(item.isVirtual).toBe(true)
      expect(item.virtualType).toBe('grouping')
    }
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

// =================================================================
// Nested grouping propagation (childViewSettings → sub-groupings)
// =================================================================

describe('getChildren — nested grouping via childViewSettings', () => {
  beforeEach(() => {
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie', title: 'Spirited Away' },
      { id: 'e2', mediaType: 'movie', title: 'Rocky' },
      { id: 'e3', mediaType: 'tv', title: 'Death Note' },
      { id: 'e4', mediaType: 'tv', title: 'Breaking Bad' },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'f1', parentId: 'root', path: 'f1', entityId: 'e1' },
      { id: 'f2', parentId: 'root', path: 'f2', entityId: 'e2' },
      { id: 'f3', parentId: 'root', path: 'f3', entityId: 'e3' },
      { id: 'f4', parentId: 'root', path: 'f4', entityId: 'e4' },
    ])
    ctx.seedGenres('e1', ['Animation'])
    ctx.seedGenres('e2', ['Action'])
    ctx.seedGenres('e3', ['Animation'])
    ctx.seedGenres('e4', ['Action'])

    // Configure: root → sections by genre, child layout → sections by mediaType
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

  it('grouping folders inherit childViewSettings.groupBy as sub-groupings', async () => {
    // 1. Set childViewSettings on root: each genre folder should group by mediaType
    mergeSettings('root', {
      viewSettings: {
        layout: 'sections',
        groupBy: 'genre',
        childViewSettings: {
          layout: 'sections',
          groupBy: 'mediaType',
        },
      },
    })

    // 2. Apply genre grouping on root (reads parent's childViewSettings and propagates)
    applyGrouping('root', 'genre')

    // 3. Get genre grouping folders
    const genreFolders = find({
      where: { parentId: 'root' },
      rawConditions: ['i.is_virtual = 1 AND i.virtual_type = \'grouping\''],
      fields: ['id', 'name'],
    })
    expect(genreFolders.length).toBe(2)

    // 4. Each genre folder should have sub-grouping folders by mediaType
    for (const genreFolder of genreFolders) {
      const children = expectItems(await getChildren(genreFolder.id, {}))
      const subFolders = children.filter((c: any) => c.isVirtual && c.virtualType === 'grouping')
      expect(subFolders.length).toBeGreaterThan(0)

      const subNames = subFolders.map((f: any) => f.name).sort()
      // Each genre has both a movie and a tv item, so should have both mediaType sub-groups
      expect(subNames).toEqual(['movie', 'tv'])
    }

    // 5. The sub-grouping folders should actually contain the right items
    //    e.g., Animation > Movies should contain only animated movies
    const animationFolder = genreFolders.find((f: any) => f.name === 'Animation')!
    const animSubFolders = expectItems(await getChildren(animationFolder.id, {}))
    const animMovies = animSubFolders.find((f: any) => f.name === 'movie')!
    const animMovieChildren = expectItems(await getChildren(animMovies.id, {}))
    expect(animMovieChildren.length).toBe(1)
    expect(animMovieChildren[0].id).toBe('f1') // Spirited Away (Animation + movie)
  })

  it('getChildren embeds children through nested grouping folders', async () => {
    // Configure root as sections by genre, children as sections by mediaType
    mergeSettings('root', {
      viewSettings: {
        layout: 'sections',
        groupBy: 'genre',
        childViewSettings: {
          layout: 'sections',
          groupBy: 'mediaType',
        },
      },
    })
    applyGrouping('root', 'genre')

    // Fetch root's children (the genre grouping folders)
    // Since root is sections layout, embedChildrenForContainers should run.
    // Each genre folder has appliedGrouping → its children (mediaType folders)
    // should also have their children embedded.
    const rootChildren = expectItems(await getChildren('root', {}))
    const animation = rootChildren.find((c: any) => c.name === 'Animation')! as MediaFolder
    expect(animation.children).toBeDefined()
    expect(animation.children).not.toBeNull()
    expect(animation.children!.length).toBe(2) // Movies, TV Shows

    const movies = animation.children!.find((c: any) => c.name === 'movie')! as MediaFolder
    expect(movies.children).toBeDefined()
    expect(movies.children).not.toBeNull()
    expect(movies.children!.length).toBe(1)
    expect(movies.children![0].id).toBe('f1') // Spirited Away
  })

  it('syncAllGroupings propagates childViewSettings set after initial grouping', async () => {
    // 1. Apply genre grouping FIRST (no childViewSettings yet)
    applyGrouping('root', 'genre')

    // Verify: no sub-grouping folders yet
    const genreFolders = find({
      where: { parentId: 'root' },
      rawConditions: ['i.is_virtual = 1 AND i.virtual_type = \'grouping\''],
      fields: ['id', 'name'],
    })
    for (const gf of genreFolders) {
      const subs = find({
        where: { parentId: gf.id },
        rawConditions: ['i.is_virtual = 1'],
        fields: ['id'],
      })
      expect(subs.length).toBe(0)
    }

    // 2. NOW set childViewSettings
    mergeSettings('root', {
      viewSettings: {
        childViewSettings: {
          layout: 'sections',
          groupBy: 'mediaType',
        },
      },
    })

    // 3. Re-sync (triggered by updateIfChangedAndBroadcast in production)
    const { syncAllGroupings } = await import('./virtualFolders.service')
    syncAllGroupings()

    // 4. Sub-grouping folders should now exist
    for (const gf of genreFolders) {
      const subs = find({
        where: { parentId: gf.id },
        rawConditions: ['i.is_virtual = 1 AND i.virtual_type = \'grouping\''],
        fields: ['id', 'name'],
      })
      const subNames = subs.map((s: any) => s.name).sort()
      expect(subNames).toEqual(['movie', 'tv'])
    }
  })

  it('resolveViewHierarchy propagates childViewSettings to grouping folders', async () => {
    applyGrouping('root', 'genre')
    mergeSettings('root', {
      viewSettings: {
        layout: 'sections',
        groupBy: 'genre',
        childViewSettings: {
          layout: 'sections',
          groupBy: 'mediaType',
        },
      },
    })

    const hierarchy = await resolveViewHierarchy('root')
    expect(hierarchy).not.toBeNull()
    expect(hierarchy!.effective.layout).toBe('sections')

    // Each genre child node should inherit sections by mediaType
    const childNodes = Object.values(hierarchy!.children ?? {})
    expect(childNodes.length).toBe(2)

    for (const childNode of childNodes) {
      expect(childNode.effective.layout).toBe('sections')
      expect(childNode.effective.groupBy).toBe('mediaType')
    }
  })
})

// =================================================================
// Invariants I1 & I2 — View Isolation and Inline Inheritance
// =================================================================

describe('Invariants I1 & I2 — resolveViewHierarchy', () => {
  beforeEach(() => {
    ctx = createServiceTestContext()

    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie', title: 'Film A' },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'child-folder', parentId: 'root', path: 'child', type: 'folder' },
      { id: 'f1', parentId: 'child-folder', path: 'child/f1', entityId: 'e1' },
    ])

    // Parent says: children should use list layout
    mergeSettings('root', {
      viewSettings: {
        layout: 'sections',
        childViewSettings: { layout: 'list' },
      },
    })

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

  afterEach(() => {
    ctx.cleanup()
  })

  it('I1: direct navigation resolves in a vacuum (no parent inheritance)', async () => {
    // Resolving child-folder at the top level (as if the user navigated to it).
    // It has no own viewSettings → should fall back to global default (grid),
    // NOT inherit parent's childViewSettings (list).
    const hierarchy = await resolveViewHierarchy('child-folder', false)
    expect(hierarchy).not.toBeNull()
    expect(hierarchy!.effective.layout).toBe('grid')
  })

  it('I2: inline rendering inherits parent childViewSettings', async () => {
    // Resolving from root (sections layout) → child-folder is rendered inline.
    // It should inherit root's childViewSettings (list).
    const hierarchy = await resolveViewHierarchy('root')
    expect(hierarchy).not.toBeNull()
    expect(hierarchy!.effective.layout).toBe('sections')

    const childNode = hierarchy!.children?.['child-folder']
    expect(childNode).toBeDefined()
    expect(childNode!.effective.layout).toBe('list')
  })
})
