/**
 * Virtual Folders Service — Integration Tests
 *
 * Tests the write→read round-trip through real service functions
 * against an in-memory SQLite DB. No mocking — the same code paths
 * that run in production run here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { applyGrouping, removeGrouping, createUserVirtualFolder, deleteVirtualFolder, syncVirtualSeasonFolders } from './virtualFolders.service'
import { find } from './repository.service'
import { compileFilter } from '../database/query-builder'
import { ensureHomeVirtualFolder, HOME_FOLDER_ID } from '../database/repositories/filesystem.repo'
import { getItemById } from './repository.service'
import type { MediaFolder } from '@shared/types'

let ctx: ServiceTestContext

beforeEach(() => {
  ctx = createServiceTestContext()
})

afterEach(() => {
  ctx.cleanup()
})

// =================================================================
// applyGrouping → getChildren round-trip
// =================================================================

describe('applyGrouping', () => {
  beforeEach(() => {
    ctx.seedEntities([
      { id: 'e-movies', mediaType: 'movie' },
      { id: 'e1', mediaType: 'movie', year: 2023 },
      { id: 'e2', mediaType: 'movie', year: 2023 },
      { id: 'e3', mediaType: 'movie', year: 2024 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder', entityId: 'e-movies' },
      { id: 'film1', parentId: 'movies', path: 'movies/film1', entityId: 'e1' },
      { id: 'film2', parentId: 'movies', path: 'movies/film2', entityId: 'e2' },
      { id: 'film3', parentId: 'movies', path: 'movies/film3', entityId: 'e3' },
    ])
  })

  it('creates grouping virtual folders with correct filters', () => {
    applyGrouping('movies', 'year')

    // Should have created two grouping folders under 'movies'
    const groupingFolders = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'grouping'`],
    })

    expect(groupingFolders).toHaveLength(2)
    const names = groupingFolders.map((f) => f.name).sort()
    expect(names).toEqual(['2023', '2024'])

    // Each folder should be virtual — use getItemById to get full row including filter
    for (const folder of groupingFolders) {
      expect(folder.isVirtual).toBe(true)
      const full = getItemById(folder.id) as MediaFolder
      expect(full.filter).toBeTruthy()
    }
  })

  it('grouping folder filter resolves to correct real children', () => {
    applyGrouping('movies', 'year')

    const groupingFolders = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'grouping'`],
    })

    const folder2023Raw = groupingFolders.find((f) => f.name === '2023')
    expect(folder2023Raw).toBeTruthy()

    // Use getItemById to get the full row including filter_json
    const folder2023 = getItemById(folder2023Raw!.id) as MediaFolder
    const compiled = compileFilter(folder2023.filter!)
    const children = find(compiled)

    expect(children).toHaveLength(2)
    const ids = children.map((c) => c.id).sort()
    expect(ids).toEqual(['film1', 'film2'])
  })

  it('sets appliedGrouping on the parent folder', () => {
    applyGrouping('movies', 'year')

    const moviesFolder = getItemById('movies') as MediaFolder
    expect(moviesFolder.viewSettings?.appliedGrouping).toBe('year')
  })

  it('rebuilds grouping atomically when called again', () => {
    applyGrouping('movies', 'year')
    applyGrouping('movies', 'year')

    // Should still have exactly 2 (not 4)
    const groupingFolders = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'grouping'`],
    })
    expect(groupingFolders).toHaveLength(2)
  })
})

// =================================================================
// applyGrouping — complex scenarios
// =================================================================

describe('applyGrouping — complex', () => {
  beforeEach(() => {
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie', year: 2023 },
      { id: 'e2', mediaType: 'movie', year: 2024 },
      { id: 'e3', mediaType: 'movie' }, // no year
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder' },
      { id: 'film1', parentId: 'movies', path: 'movies/film1', entityId: 'e1' },
      { id: 'film2', parentId: 'movies', path: 'movies/film2', entityId: 'e2' },
      { id: 'film3', parentId: 'movies', path: 'movies/film3', entityId: 'e3' },
    ])
  })

  it('creates an Uncategorized bucket for items missing the grouping key', () => {
    applyGrouping('movies', 'year')

    const groupingFolders = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'grouping'`],
    })

    const names = groupingFolders.map((f) => f.name).sort()
    expect(names).toEqual(['2023', '2024', 'Uncategorized'])
  })

  it('Uncategorized folder filter resolves to items missing the key', () => {
    applyGrouping('movies', 'year')

    const groupingFolders = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'grouping'`],
    })
    const uncatRaw = groupingFolders.find((f) => f.name === 'Uncategorized')!
    const uncat = getItemById(uncatRaw.id) as MediaFolder

    expect(uncat.filter).toBeTruthy()
    expect(uncat.filter!.conditions![0].op).toBe('isNull')

    const children = find(compileFilter(uncat.filter!))
    expect(children).toHaveLength(1)
    expect(children[0].id).toBe('film3')
  })

  it('groups by virtual tags (vt.* prefix)', () => {
    ctx.seedVirtualTags('e1', { is_anime: 'Yes' })
    ctx.seedVirtualTags('e2', { is_anime: 'No' })
    // e3 has no virtual tag → Uncategorized

    applyGrouping('movies', 'vt.is_anime')

    const groupingFolders = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'grouping'`],
    })
    const names = groupingFolders.map((f) => f.name).sort()
    expect(names).toEqual(['No', 'Uncategorized', 'Yes'])

    // Verify Yes folder resolves to film1
    const yesRaw = groupingFolders.find((f) => f.name === 'Yes')!
    const yes = getItemById(yesRaw.id) as MediaFolder
    const children = find(compileFilter(yes.filter!))
    expect(children).toHaveLength(1)
    expect(children[0].id).toBe('film1')
  })

  it('groups by genres (multi-value field — one item in multiple groups)', () => {
    ctx.seedGenres('e1', ['Action', 'Sci-Fi'])
    ctx.seedGenres('e2', ['Action', 'Drama'])
    // e3 has no genres → Uncategorized

    applyGrouping('movies', 'genres')

    const groupingFolders = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'grouping'`],
    })
    const names = groupingFolders.map((f) => f.name).sort()
    expect(names).toEqual(['Action', 'Drama', 'Sci-Fi', 'Uncategorized'])

    // Action folder should contain both film1 and film2
    const actionRaw = groupingFolders.find((f) => f.name === 'Action')!
    const action = getItemById(actionRaw.id) as MediaFolder
    const actionChildren = find(compileFilter(action.filter!))
    expect(actionChildren).toHaveLength(2)
    expect(actionChildren.map((c) => c.id).sort()).toEqual(['film1', 'film2'])

    // Sci-Fi folder should contain only film1
    const scifiRaw = groupingFolders.find((f) => f.name === 'Sci-Fi')!
    const scifi = getItemById(scifiRaw.id) as MediaFolder
    const scifiChildren = find(compileFilter(scifi.filter!))
    expect(scifiChildren).toHaveLength(1)
    expect(scifiChildren[0].id).toBe('film1')

    // Uncategorized should contain film3 (no genres)
    const uncatRaw = groupingFolders.find((f) => f.name === 'Uncategorized')!
    const uncat = getItemById(uncatRaw.id) as MediaFolder
    const uncatChildren = find(compileFilter(uncat.filter!))
    expect(uncatChildren).toHaveLength(1)
    expect(uncatChildren[0].id).toBe('film3')
  })

  it('switching grouping key replaces old grouping folders', () => {
    applyGrouping('movies', 'year')
    const beforeNames = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'grouping'`],
    }).map((f) => f.name).sort()
    expect(beforeNames).toContain('2023')

    // Now switch to a different key
    ctx.seedVirtualTags('e1', { quality: '4K' })
    ctx.seedVirtualTags('e2', { quality: '1080p' })
    applyGrouping('movies', 'vt.quality')

    const afterFolders = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'grouping'`],
    })
    const afterNames = afterFolders.map((f) => f.name).sort()
    // Old year-based folders should be gone, replaced by quality-based ones
    expect(afterNames).not.toContain('2023')
    expect(afterNames).toContain('4K')
    expect(afterNames).toContain('1080p')

    const moviesFolder = getItemById('movies') as MediaFolder
    expect(moviesFolder.viewSettings?.appliedGrouping).toBe('vt.quality')
  })
})

// =================================================================
// applyGrouping on virtual folders
// =================================================================

describe('applyGrouping on virtual folders', () => {
  beforeEach(() => {
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie', year: 2023 },
      { id: 'e2', mediaType: 'tv', year: 2024 },
      { id: 'e3', mediaType: 'movie', year: 2024 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'film1', parentId: 'root', path: 'film1', type: 'folder', entityId: 'e1' },
      { id: 'show1', parentId: 'root', path: 'show1', type: 'folder', entityId: 'e2' },
      { id: 'film2', parentId: 'root', path: 'film2', type: 'folder', entityId: 'e3' },
    ])
    ensureHomeVirtualFolder('root')
  })

  it('groups the home virtual folder by mediaType', () => {
    applyGrouping(HOME_FOLDER_ID, 'mediaType')

    const groupingFolders = find({
      where: { parentId: HOME_FOLDER_ID },
      rawConditions: [`i.virtual_type = 'grouping'`],
    })
    expect(groupingFolders).toHaveLength(2)
    expect(groupingFolders.map((f) => f.name).sort()).toEqual(['movie', 'tv'])
  })

  it('grouping folder filters scope to the virtual folder pool, not the virtual folder ID', () => {
    applyGrouping(HOME_FOLDER_ID, 'mediaType')

    const movieFolder = find({
      where: { parentId: HOME_FOLDER_ID },
      rawConditions: [`i.virtual_type = 'grouping'`],
    }).find((f) => f.name === 'movie')!

    const full = getItemById(movieFolder.id) as MediaFolder
    const children = find(compileFilter(full.filter!))

    // Should find both movies (film1, film2) — scoped to root's children, not virtual-home's
    expect(children).toHaveLength(2)
    expect(children.map((c) => c.id).sort()).toEqual(['film1', 'film2'])
  })

  it('groups home by genre (singular alias key)', () => {
    ctx.seedGenres('e1', ['Action', 'Sci-Fi'])
    ctx.seedGenres('e2', ['Drama'])
    ctx.seedGenres('e3', ['Action'])

    // Frontend sends 'genre' (singular) via the groupBy keys list,
    // but the schema field is 'genres' (plural).
    applyGrouping(HOME_FOLDER_ID, 'genre')

    const groupingFolders = find({
      where: { parentId: HOME_FOLDER_ID },
      rawConditions: [`i.virtual_type = 'grouping'`],
    })
    const names = groupingFolders.map((f) => f.name).sort()
    expect(names).toEqual(['Action', 'Drama', 'Sci-Fi'])

    // Action should contain film1 and film2
    const actionRaw = groupingFolders.find((f) => f.name === 'Action')!
    const action = getItemById(actionRaw.id) as MediaFolder
    const actionChildren = find(compileFilter(action.filter!))
    expect(actionChildren).toHaveLength(2)
    expect(actionChildren.map((c) => c.id).sort()).toEqual(['film1', 'film2'])
  })

  it('applyGrouping with unresolved alias "home" throws (must resolve to real ID first)', () => {
    // Reproduces the real bug: the PATCH endpoint was passing 'home' (alias)
    // instead of 'virtual-home' (the real DB id). The FK constraint catches this.
    expect(() => applyGrouping('home', 'mediaType')).toThrow()
  })

  it('grouping folder filters resolve correctly for tv mediaType', () => {
    applyGrouping(HOME_FOLDER_ID, 'mediaType')

    const tvFolder = find({
      where: { parentId: HOME_FOLDER_ID },
      rawConditions: [`i.virtual_type = 'grouping'`],
    }).find((f) => f.name === 'tv')!

    const full = getItemById(tvFolder.id) as MediaFolder
    const children = find(compileFilter(full.filter!))

    expect(children).toHaveLength(1)
    expect(children[0].id).toBe('show1')
  })
})

// =================================================================
// removeGrouping
// =================================================================

describe('removeGrouping', () => {
  beforeEach(() => {
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie', year: 2023 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder' },
      { id: 'film1', parentId: 'movies', path: 'movies/film1', entityId: 'e1' },
    ])
  })

  it('deletes grouping folders and clears appliedGrouping', () => {
    applyGrouping('movies', 'year')
    removeGrouping('movies')

    const groupingFolders = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'grouping'`],
    })
    expect(groupingFolders).toHaveLength(0)

    const moviesFolder = getItemById('movies') as MediaFolder
    expect(moviesFolder.viewSettings?.appliedGrouping).toBeFalsy()
  })

  it('preserves user virtual folders when removing grouping', () => {
    ctx.seedItems([
      { id: 'user-vf', parentId: 'movies', path: 'virtual://user-vf', type: 'folder', isVirtual: 1, virtualType: 'user' },
    ])

    applyGrouping('movies', 'year')
    removeGrouping('movies')

    const userFolders = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'user'`],
    })
    expect(userFolders).toHaveLength(1)
    expect(userFolders[0].id).toBe('user-vf')
  })
})

// =================================================================
// createUserVirtualFolder / deleteVirtualFolder
// =================================================================

describe('createUserVirtualFolder', () => {
  beforeEach(() => {
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder' },
    ])
  })

  it('creates a user virtual folder and returns its id', () => {
    const id = createUserVirtualFolder('movies', 'My Collection', {
      scope: { parentId: 'movies' },
      conditions: [{ field: 'year', op: 'eq', value: 2024 }],
    })

    const item = getItemById(id) as MediaFolder
    expect(item).toBeTruthy()
    expect(item.name).toBe('My Collection')
    expect(item.isVirtual).toBe(true)
    expect(item.virtualType).toBe('user')
    expect(item.filter?.scope?.parentId).toBe('movies')
  })

  it('deleteVirtualFolder removes it', () => {
    const id = createUserVirtualFolder('movies', 'Temp')
    deleteVirtualFolder(id)
    expect(getItemById(id)).toBeNull()
  })

  it('deleteVirtualFolder rejects non-user virtual folders', () => {
    applyGrouping('movies', 'year')
    const groupingFolders = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'grouping'`],
    })

    // Need at least one item for grouping to work — seed it
    ctx.seedEntities([{ id: 'e1', mediaType: 'movie', year: 2023 }])
    ctx.seedItems([{ id: 'film1', parentId: 'movies', path: 'movies/film1', entityId: 'e1' }])
    applyGrouping('movies', 'year')

    const folders = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'grouping'`],
    })
    if (folders.length > 0) {
      expect(() => deleteVirtualFolder(folders[0].id)).toThrow()
    }
  })
})

// =================================================================
// ensureHomeVirtualFolder
// =================================================================

describe('ensureHomeVirtualFolder', () => {
  beforeEach(() => {
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
    ])
  })

  it('creates a home folder with the constant ID', () => {
    ensureHomeVirtualFolder('root')

    const home = getItemById(HOME_FOLDER_ID) as MediaFolder
    expect(home).toBeTruthy()
    expect(home.name).toBe('__home__')
    expect(home.isVirtual).toBe(true)
    expect(home.virtualType).toBe('home')
    expect(home.filter?.scope?.parentId).toBe('root')
  })

  it('is idempotent — calling twice does not error or duplicate', () => {
    ensureHomeVirtualFolder('root')
    ensureHomeVirtualFolder('root')

    const rows = ctx.db.prepare(`SELECT * FROM items WHERE virtual_type = 'home'`).all()
    expect(rows).toHaveLength(1)
  })

  it('home folder filter resolves to root children', () => {
    ctx.seedItems([
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder' },
      { id: 'tv', parentId: 'root', path: 'tv', type: 'folder' },
    ])

    ensureHomeVirtualFolder('root')
    const home = getItemById(HOME_FOLDER_ID) as MediaFolder
    const compiled = compileFilter(home.filter!)
    const children = find({ ...compiled, includeHidden: true, includeIgnored: true })

    expect(children).toHaveLength(2)
    const ids = children.map((c) => c.id).sort()
    expect(ids).toEqual(['movies', 'tv'])
  })
})

// =================================================================
// syncVirtualSeasonFolders
// =================================================================

describe('syncVirtualSeasonFolders', () => {
  beforeEach(() => {
    ctx.seedEntities([
      { id: 'e-show1', mediaType: 'tv' },
      { id: 'e-ep1', mediaType: 'episode', seasonNumber: 1 },
      { id: 'e-ep2', mediaType: 'episode', seasonNumber: 1 },
      { id: 'e-ep3', mediaType: 'episode', seasonNumber: 2 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'show1', parentId: 'root', path: 'show1', type: 'folder', entityId: 'e-show1' },
      { id: 'ep1', parentId: 'show1', path: 'show1/s01e01.mkv', entityId: 'e-ep1' },
      { id: 'ep2', parentId: 'show1', path: 'show1/s01e02.mkv', entityId: 'e-ep2' },
      { id: 'ep3', parentId: 'show1', path: 'show1/s02e01.mkv', entityId: 'e-ep3' },
    ])
  })

  it('creates virtual season folders with deterministic IDs', () => {
    syncVirtualSeasonFolders('show1')

    const seasonFolders = find({
      where: { parentId: 'show1' },
      rawConditions: [`i.virtual_type = 'season'`],
    })

    expect(seasonFolders).toHaveLength(2)
    const names = seasonFolders.map((f) => f.name).sort()
    expect(names).toEqual(['Season 1', 'Season 2'])
  })

  it('is idempotent — deterministic IDs prevent duplicates', () => {
    syncVirtualSeasonFolders('show1')
    syncVirtualSeasonFolders('show1')

    const seasonFolders = find({
      where: { parentId: 'show1' },
      rawConditions: [`i.virtual_type = 'season'`],
    })
    expect(seasonFolders).toHaveLength(2)
  })

  it('season folder filter resolves to correct episodes', () => {
    syncVirtualSeasonFolders('show1')

    const seasonFolders = find({
      where: { parentId: 'show1' },
      rawConditions: [`i.virtual_type = 'season'`],
    })
    const s1Raw = seasonFolders.find((f) => f.name === 'Season 1')
    expect(s1Raw).toBeTruthy()

    const s1 = getItemById(s1Raw!.id) as MediaFolder
    const compiled = compileFilter(s1.filter!)
    const episodes = find(compiled)

    expect(episodes).toHaveLength(2)
    const ids = episodes.map((c) => c.id).sort()
    expect(ids).toEqual(['ep1', 'ep2'])
  })

  it('cleans up orphaned season folders', () => {
    syncVirtualSeasonFolders('show1')

    // Remove all season 2 episodes
    ctx.db.prepare(`UPDATE media_entities SET season_number = 1 WHERE id = 'e-ep3'`).run()

    syncVirtualSeasonFolders('show1')

    const seasonFolders = find({
      where: { parentId: 'show1' },
      rawConditions: [`i.virtual_type = 'season'`],
    })
    expect(seasonFolders).toHaveLength(1)
    expect(seasonFolders[0].name).toBe('Season 1')
  })

  it('sets appliedGrouping = seasonNumber', () => {
    syncVirtualSeasonFolders('show1')

    const show = getItemById('show1') as MediaFolder
    expect(show.viewSettings?.appliedGrouping).toBe('seasonNumber')
  })
})
