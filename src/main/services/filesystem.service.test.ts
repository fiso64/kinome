/**
 * Filesystem Service Tests
 *
 * Integration tests for filesystem scan entry points and their invariants.
 * Uses an in-memory SQLite DB via createServiceTestContext().
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import {
  HOME_FOLDER_ID,
  HOME_CATEGORIES_ID,
  HOME_RECENTLY_ADDED_ID,
  HOME_GENRES_ID,
  HOME_ALL_MEDIA_ID
} from '../database/repositories/filesystem.repo'
import * as repositoryService from './repository.service'
import { LIBRARY_ROOT_ID } from '../database/repositories/filesystem.repo'
import { PREDEFINED_VTAGS } from './predefined-vtags'

const TEST_SOURCE = { id: 'test-source-uuid', path: '/media/library', isRelative: false }

let ctx: ServiceTestContext

beforeEach(() => {
  ctx = createServiceTestContext()
})

afterEach(() => {
  ctx.cleanup()
})

describe('ensureSourceRoot', () => {
  it('creates the library virtual root and a source root item', () => {
    repositoryService.ensureSourceRoot(TEST_SOURCE, '/media/library')

    const libRoot = repositoryService.getRoot()
    expect(libRoot).not.toBeNull()
    expect(libRoot!.id).toBe(LIBRARY_ROOT_ID)
    expect(libRoot!.isVirtual).toBe(true)

    const sourceRoot = repositoryService.getItemById(
      require('../database/repositories/filesystem.repo').generateId(TEST_SOURCE.id, '.')
    )
    expect(sourceRoot).not.toBeNull()
    expect(sourceRoot!.path).toBe('.')
    expect(sourceRoot!.type).toBe('folder')
    expect(sourceRoot!.parentId).toBe(LIBRARY_ROOT_ID)
  })

  it('creates the home virtual folder parented to the library root', () => {
    repositoryService.ensureSourceRoot(TEST_SOURCE, '/media/library')

    const home = repositoryService.getItemById(HOME_FOLDER_ID)
    expect(home).not.toBeNull()
    expect(home!.isVirtual).toBe(true)
    expect(home!.type).toBe('folder')
    expect(home!.parentId).toBe(LIBRARY_ROOT_ID)
  })

  it('home virtual folder has a filter with parent.retrieveChildrenMetadata and mediaType conditions', () => {
    repositoryService.ensureSourceRoot(TEST_SOURCE, '/media/library')

    const row = ctx.db.prepare('SELECT filter_json FROM items WHERE id = ?').get(HOME_FOLDER_ID) as any
    const filter = JSON.parse(row?.filter_json ?? 'null')
    expect(filter.conditionGroups).toHaveLength(3)
    expect(filter.conditionGroups[0]).toEqual([
      { field: 'parent.retrieveChildrenMetadata', op: 'eq', value: 1 },
    ])
    expect(filter.conditionGroups[1]).toEqual([
      { field: 'mediaType', op: 'eq', value: 'movie' },
    ])
    expect(filter.conditionGroups[2]).toEqual([
      { field: 'mediaType', op: 'eq', value: 'tv' },
    ])
  })

  it('is idempotent — calling twice does not duplicate', () => {
    repositoryService.ensureSourceRoot(TEST_SOURCE, '/media/library')
    repositoryService.ensureSourceRoot(TEST_SOURCE, '/media/library')

    const sourceRoots = ctx.db.prepare("SELECT * FROM items WHERE source_id = ? AND path = '.'").all(TEST_SOURCE.id)
    expect(sourceRoots).toHaveLength(1)

    const homes = ctx.db.prepare("SELECT * FROM items WHERE id = ?").all(HOME_FOLDER_ID)
    expect(homes).toHaveLength(1)
  })

  it('creates Categories, Recently Added, Genres, and All Media subfolders under home', () => {
    repositoryService.ensureSourceRoot(TEST_SOURCE, '/media/library')

    const categories = repositoryService.getItemById(HOME_CATEGORIES_ID)
    const recentlyAdded = repositoryService.getItemById(HOME_RECENTLY_ADDED_ID)
    const genres = repositoryService.getItemById(HOME_GENRES_ID)
    const allMedia = repositoryService.getItemById(HOME_ALL_MEDIA_ID)

    expect(categories).not.toBeNull()
    expect(recentlyAdded).not.toBeNull()
    expect(genres).not.toBeNull()
    expect(allMedia).not.toBeNull()

    expect(categories!.parentId).toBe(HOME_FOLDER_ID)
    expect(recentlyAdded!.parentId).toBe(HOME_FOLDER_ID)
    expect(genres!.parentId).toBe(HOME_FOLDER_ID)
    expect(allMedia!.parentId).toBe(HOME_CATEGORIES_ID)

    expect((categories as any).virtualType).toBe('user')
    expect((recentlyAdded as any).virtualType).toBe('user')
    expect((genres as any).virtualType).toBe('user')
    expect((allMedia as any).virtualType).toBe('user')
  })

  it('home subfolders have correct filters', () => {
    repositoryService.ensureSourceRoot(TEST_SOURCE, '/media/library')

    const row = (id: string) =>
      ctx.db.prepare('SELECT filter_json FROM items WHERE id = ?').get(id) as any

    const categoriesFilter = JSON.parse(row(HOME_CATEGORIES_ID).filter_json)
    expect(categoriesFilter.scope?.parentId).toBe(HOME_FOLDER_ID)
    expect(categoriesFilter.conditions).toBeUndefined()

    const recentlyAddedFilter = JSON.parse(row(HOME_RECENTLY_ADDED_ID).filter_json)
    expect(recentlyAddedFilter.scope?.parentId).toBe(HOME_FOLDER_ID)
    expect(recentlyAddedFilter.conditions).toEqual([
      { field: 'addedDaysAgo', op: 'lte', value: 14 }
    ])

    const genresFilter = JSON.parse(row(HOME_GENRES_ID).filter_json)
    expect(genresFilter.scope?.parentId).toBe(HOME_FOLDER_ID)
    expect(genresFilter.conditions).toBeUndefined()

    const allMediaFilter = JSON.parse(row(HOME_ALL_MEDIA_ID).filter_json)
    expect(allMediaFilter.scope?.parentId).toBe(HOME_FOLDER_ID)
    expect(allMediaFilter.conditions).toBeUndefined()
  })

  it('home subfolders creation is idempotent', () => {
    repositoryService.ensureSourceRoot(TEST_SOURCE, '/media/library')
    repositoryService.ensureSourceRoot(TEST_SOURCE, '/media/library')

    for (const id of [HOME_CATEGORIES_ID, HOME_RECENTLY_ADDED_ID, HOME_GENRES_ID, HOME_ALL_MEDIA_ID]) {
      const rows = ctx.db.prepare('SELECT * FROM items WHERE id = ?').all(id)
      expect(rows).toHaveLength(1)
    }
  })

  it('sets home view settings with sections layout and _home_category grouping', () => {
    repositoryService.ensureSourceRoot(TEST_SOURCE, '/media/library')

    const row = ctx.db.prepare('SELECT view_settings_json FROM folder_settings WHERE item_id = ?').get(HOME_FOLDER_ID) as any
    const vs = JSON.parse(row.view_settings_json)

    expect(vs.layout).toBe('sections')
    expect(vs.appliedGrouping).toBe('vt._home_category')
    expect(vs.childViewSettings?.layout).toBe('horizontal-grid')
    expect(vs.sortTop).toContain(HOME_CATEGORIES_ID)
    expect(vs.sortTop).toContain(HOME_RECENTLY_ADDED_ID)
    expect(vs.sortBottom).toContain(HOME_GENRES_ID)
    expect(vs.childViewSettings?.overrides?.[HOME_CATEGORIES_ID]).toMatchObject({ layout: 'button-grid', scrollHorizontally: true })
    expect(vs.childViewSettings?.overrides?.[HOME_GENRES_ID]).toMatchObject({ layout: 'button-grid', scrollHorizontally: false })
  })

  it('home view settings init is idempotent — user changes are not overwritten', () => {
    repositoryService.ensureSourceRoot(TEST_SOURCE, '/media/library')

    ctx.db.prepare("UPDATE folder_settings SET view_settings_json = ? WHERE item_id = ?")
      .run(JSON.stringify({ layout: 'grid' }), HOME_FOLDER_ID)

    repositoryService.ensureSourceRoot(TEST_SOURCE, '/media/library')

    const row = ctx.db.prepare('SELECT view_settings_json FROM folder_settings WHERE item_id = ?').get(HOME_FOLDER_ID) as any
    const vs = JSON.parse(row.view_settings_json)
    expect(vs.layout).toBe('grid')
  })
})

describe('multi-source', () => {
  const SOURCE_A = { id: 'source-a-uuid', path: '/media/movies', isRelative: false }
  const SOURCE_B = { id: 'source-b-uuid', path: '/media/shows', isRelative: false }

  it('two sources each get their own source root under LIBRARY_ROOT_ID', () => {
    repositoryService.ensureSourceRoot(SOURCE_A, '/media/movies')
    repositoryService.ensureSourceRoot(SOURCE_B, '/media/shows')

    const { generateId } = require('../database/repositories/filesystem.repo')
    const rootA = repositoryService.getItemById(generateId(SOURCE_A.id, '.'))
    const rootB = repositoryService.getItemById(generateId(SOURCE_B.id, '.'))

    expect(rootA).not.toBeNull()
    expect(rootB).not.toBeNull()
    expect(rootA!.id).not.toBe(rootB!.id)
    expect(rootA!.parentId).toBe(LIBRARY_ROOT_ID)
    expect(rootB!.parentId).toBe(LIBRARY_ROOT_ID)
  })

  it('home folder is created only once regardless of how many sources are added', () => {
    repositoryService.ensureSourceRoot(SOURCE_A, '/media/movies')
    repositoryService.ensureSourceRoot(SOURCE_B, '/media/shows')

    const homes = ctx.db.prepare('SELECT * FROM items WHERE id = ?').all(HOME_FOLDER_ID)
    expect(homes).toHaveLength(1)
  })

  it('same relative path in two sources produces different item IDs', () => {
    const { generateId } = require('../database/repositories/filesystem.repo')
    const idA = generateId(SOURCE_A.id, 'film.mkv')
    const idB = generateId(SOURCE_B.id, 'film.mkv')
    expect(idA).not.toBe(idB)
  })

  it('upsertLibraryItems allows same relative path across different sources', () => {
    const { generateId, upsertLibraryItems } = require('../database/repositories/filesystem.repo')
    repositoryService.ensureSourceRoot(SOURCE_A, '/media/movies')
    repositoryService.ensureSourceRoot(SOURCE_B, '/media/shows')

    const rootAId = generateId(SOURCE_A.id, '.')
    const rootBId = generateId(SOURCE_B.id, '.')
    const itemAId = generateId(SOURCE_A.id, 'film.mkv')
    const itemBId = generateId(SOURCE_B.id, 'film.mkv')

    // Note: upsertLibraryItems expects @-prefixed keys to match SQL named params
    upsertLibraryItems([
      { '@id': itemAId, '@parentId': rootAId, '@path': 'film.mkv', '@name': 'film.mkv', '@type': 'file', '@sourceId': SOURCE_A.id, '@size': 0, '@mtime': 0, '@birthtime': 0, '@inode': 1, '@deviceId': 1, '@isIgnored': 0, '@isHidden': 0 },
      { '@id': itemBId, '@parentId': rootBId, '@path': 'film.mkv', '@name': 'film.mkv', '@type': 'file', '@sourceId': SOURCE_B.id, '@size': 0, '@mtime': 0, '@birthtime': 0, '@inode': 2, '@deviceId': 1, '@isIgnored': 0, '@isHidden': 0 },
    ])

    const rows = ctx.db.prepare("SELECT * FROM items WHERE path = 'film.mkv' AND is_virtual = 0").all()
    expect(rows).toHaveLength(2)
  })

  it('getAllIdsInScope only returns items belonging to the queried source', () => {
    const { generateId, upsertLibraryItems, getAllIdsInScope } = require('../database/repositories/filesystem.repo')
    repositoryService.ensureSourceRoot(SOURCE_A, '/media/movies')
    repositoryService.ensureSourceRoot(SOURCE_B, '/media/shows')

    const rootAId = generateId(SOURCE_A.id, '.')
    const rootBId = generateId(SOURCE_B.id, '.')
    const itemAId = generateId(SOURCE_A.id, 'film.mkv')
    const itemBId = generateId(SOURCE_B.id, 'film.mkv')

    upsertLibraryItems([
      { '@id': itemAId, '@parentId': rootAId, '@path': 'film.mkv', '@name': 'film.mkv', '@type': 'file', '@sourceId': SOURCE_A.id, '@size': 0, '@mtime': 0, '@birthtime': 0, '@inode': 1, '@deviceId': 1, '@isIgnored': 0, '@isHidden': 0 },
      { '@id': itemBId, '@parentId': rootBId, '@path': 'film.mkv', '@name': 'film.mkv', '@type': 'file', '@sourceId': SOURCE_B.id, '@size': 0, '@mtime': 0, '@birthtime': 0, '@inode': 2, '@deviceId': 1, '@isIgnored': 0, '@isHidden': 0 },
    ])

    const idsA = getAllIdsInScope(SOURCE_A.id, '.')
    expect(idsA).toContain(itemAId)
    expect(idsA).not.toContain(itemBId)

    const idsB = getAllIdsInScope(SOURCE_B.id, '.')
    expect(idsB).toContain(itemBId)
    expect(idsB).not.toContain(itemAId)
  })

  it('getItemsForCleanup only returns items belonging to the queried source', () => {
    const { generateId, upsertLibraryItems, getItemsForCleanup } = require('../database/repositories/filesystem.repo')
    repositoryService.ensureSourceRoot(SOURCE_A, '/media/movies')
    repositoryService.ensureSourceRoot(SOURCE_B, '/media/shows')

    const rootAId = generateId(SOURCE_A.id, '.')
    const rootBId = generateId(SOURCE_B.id, '.')
    const itemAId = generateId(SOURCE_A.id, 'film.mkv')
    const itemBId = generateId(SOURCE_B.id, 'film.mkv')

    upsertLibraryItems([
      { '@id': itemAId, '@parentId': rootAId, '@path': 'film.mkv', '@name': 'film.mkv', '@type': 'file', '@sourceId': SOURCE_A.id, '@size': 0, '@mtime': 0, '@birthtime': 0, '@inode': 1, '@deviceId': 1, '@isIgnored': 0, '@isHidden': 0 },
      { '@id': itemBId, '@parentId': rootBId, '@path': 'film.mkv', '@name': 'film.mkv', '@type': 'file', '@sourceId': SOURCE_B.id, '@size': 0, '@mtime': 0, '@birthtime': 0, '@inode': 2, '@deviceId': 1, '@isIgnored': 0, '@isHidden': 0 },
    ])

    const cleanupA = getItemsForCleanup(SOURCE_A.id, '.')
    const idsA = cleanupA.map((r: any) => r.id)
    expect(idsA).toContain(itemAId)
    expect(idsA).not.toContain(itemBId)

    const cleanupB = getItemsForCleanup(SOURCE_B.id, '.')
    const idsB = cleanupB.map((r: any) => r.id)
    expect(idsB).toContain(itemBId)
    expect(idsB).not.toContain(itemAId)
  })
})

describe('PREDEFINED_VTAGS', () => {
  it('_home_category tag has correct case order (animated before live action)', () => {
    const homeCat = PREDEFINED_VTAGS.find((t) => t.id === '_home_category')
    expect(homeCat).toBeDefined()

    const results = homeCat!.cases.map((c) => c.result)
    expect(results.indexOf('Animated Movies')).toBeLessThan(results.indexOf('Movies'))
    expect(results.indexOf('Animated Shows')).toBeLessThan(results.indexOf('TV Shows'))
  })

  it('_home_category Movies case excludes Animation genre', () => {
    const homeCat = PREDEFINED_VTAGS.find((t) => t.id === '_home_category')!
    const moviesCase = homeCat.cases.find((c) => c.result === 'Movies')!
    const conditions = moviesCase.filter.conditionGroups!.flat()

    expect(conditions).toContainEqual({ field: 'mediaType', op: 'eq', value: 'movie' })
    expect(conditions).toContainEqual({ field: 'genre', op: 'notContains', value: 'Animation' })
  })

  it('_home_category has Uncategorized as defaultResult', () => {
    const homeCat = PREDEFINED_VTAGS.find((t) => t.id === '_home_category')!
    expect(homeCat.defaultResult).toBe('Uncategorized')
  })
})
