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
import { PREDEFINED_VTAGS } from './predefined-vtags'

let ctx: ServiceTestContext

beforeEach(() => {
  ctx = createServiceTestContext()
})

afterEach(() => {
  ctx.cleanup()
})

describe('ensureRootExists', () => {
  it('creates the root item', () => {
    repositoryService.ensureRootExists('/media/library')

    const root = repositoryService.getRoot()
    expect(root).not.toBeNull()
    expect(root!.path).toBe('.')
    expect(root!.type).toBe('folder')
  })

  it('creates the home virtual folder alongside root', () => {
    repositoryService.ensureRootExists('/media/library')

    const home = repositoryService.getItemById(HOME_FOLDER_ID)
    expect(home).not.toBeNull()
    expect(home!.isVirtual).toBe(true)
    expect(home!.type).toBe('folder')
  })

  it('home virtual folder is parented to root', () => {
    repositoryService.ensureRootExists('/media/library')

    const root = repositoryService.getRoot()
    const home = repositoryService.getItemById(HOME_FOLDER_ID)
    expect(home!.parentId).toBe(root!.id)
  })

  it('home virtual folder has a filter with parent.retrieveChildrenMetadata and mediaType conditions', () => {
    repositoryService.ensureRootExists('/media/library')

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
    repositoryService.ensureRootExists('/media/library')
    repositoryService.ensureRootExists('/media/library')

    const roots = ctx.db.prepare("SELECT * FROM items WHERE parent_id IS NULL AND is_virtual = 0").all()
    expect(roots).toHaveLength(1)

    const homes = ctx.db.prepare("SELECT * FROM items WHERE id = ?").all(HOME_FOLDER_ID)
    expect(homes).toHaveLength(1)
  })

  it('creates Categories, Recently Added, Genres, and All Media subfolders under home', () => {
    repositoryService.ensureRootExists('/media/library')

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
    repositoryService.ensureRootExists('/media/library')

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
    repositoryService.ensureRootExists('/media/library')
    repositoryService.ensureRootExists('/media/library')

    for (const id of [HOME_CATEGORIES_ID, HOME_RECENTLY_ADDED_ID, HOME_GENRES_ID, HOME_ALL_MEDIA_ID]) {
      const rows = ctx.db.prepare('SELECT * FROM items WHERE id = ?').all(id)
      expect(rows).toHaveLength(1)
    }
  })

  it('sets home view settings with sections layout and _home_category grouping', () => {
    repositoryService.ensureRootExists('/media/library')

    const row = ctx.db.prepare('SELECT view_settings_json FROM folder_settings WHERE item_id = ?').get(HOME_FOLDER_ID) as any
    const vs = JSON.parse(row.view_settings_json)

    expect(vs.layout).toBe('sections')
    expect(vs.appliedGrouping).toBe('vt._home_category')
    expect(vs.childViewSettings?.layout).toBe('horizontal-grid')
    expect(vs.sortTop).toEqual([HOME_CATEGORIES_ID, HOME_RECENTLY_ADDED_ID])
    expect(vs.sortBottom).toEqual([HOME_GENRES_ID])
    expect(vs.childViewSettings?.overrides?.[HOME_CATEGORIES_ID]).toMatchObject({ layout: 'button-grid', gridPosterSize: 250, scrollHorizontally: true })
    expect(vs.childViewSettings?.overrides?.[HOME_GENRES_ID]).toMatchObject({ layout: 'button-grid', gridPosterSize: 180, scrollHorizontally: false })
  })

  it('home view settings init is idempotent — user changes are not overwritten', () => {
    repositoryService.ensureRootExists('/media/library')

    // Simulate user changing home layout to 'grid'
    ctx.db.prepare("UPDATE folder_settings SET view_settings_json = ? WHERE item_id = ?")
      .run(JSON.stringify({ layout: 'grid' }), HOME_FOLDER_ID)

    repositoryService.ensureRootExists('/media/library')

    const row = ctx.db.prepare('SELECT view_settings_json FROM folder_settings WHERE item_id = ?').get(HOME_FOLDER_ID) as any
    const vs = JSON.parse(row.view_settings_json)
    expect(vs.layout).toBe('grid') // user change preserved
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
