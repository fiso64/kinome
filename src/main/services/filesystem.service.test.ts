/**
 * Filesystem Service Tests
 *
 * Integration tests for filesystem scan entry points and their invariants.
 * Uses an in-memory SQLite DB via createServiceTestContext().
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import {
  HOME_FOLDER_ID,
  HOME_CATEGORIES_ID,
  HOME_RECENTLY_ADDED_ID,
  HOME_GENRES_ID,
  HOME_ALL_MEDIA_ID,
  generateId,
  getAllFolderPathsInSource,
  getNonEmptyFolderPathsInSource
} from '../database/repositories/filesystem.repo'
import * as repositoryService from './repository.service'
import { LIBRARY_ROOT_ID } from '../database/repositories/filesystem.repo'
import { PREDEFINED_VTAGS } from './predefined-vtags'
import { cleanupMissingForSource, scanDirectory } from './filesystem.service'

const TEST_SOURCE = { id: 'test-source-uuid', path: '/media/library', isRelative: false }

let ctx: ServiceTestContext

beforeEach(() => {
  ctx = createServiceTestContext()
})

afterEach(() => {
  ctx.cleanup()
})

function itemIdForLocation(sourceId: string, relativePath: string): string | null {
  const row = ctx.db.prepare(`
    SELECT item_id
    FROM media_locations
    WHERE source_id = ? AND relative_path = ?
  `).get(sourceId, relativePath) as { item_id: string } | undefined
  return row?.item_id ?? null
}

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

    const row = ctx.db.prepare('SELECT filter_json FROM media_items WHERE id = ?').get(HOME_FOLDER_ID) as any
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

    const sourceRoots = ctx.db.prepare("SELECT * FROM media_locations WHERE source_id = ? AND relative_path = '.'").all(TEST_SOURCE.id)
    expect(sourceRoots).toHaveLength(1)

    const homes = ctx.db.prepare("SELECT * FROM media_items WHERE id = ?").all(HOME_FOLDER_ID)
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
      ctx.db.prepare('SELECT filter_json FROM media_items WHERE id = ?').get(id) as any

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
      const rows = ctx.db.prepare('SELECT * FROM media_items WHERE id = ?').all(id)
      expect(rows).toHaveLength(1)
    }
  })

  it('sets home view settings with sections layout and _home_category grouping', () => {
    repositoryService.ensureSourceRoot(TEST_SOURCE, '/media/library')

    const row = ctx.db.prepare('SELECT view_settings_json, applied_grouping FROM folder_settings WHERE item_id = ?').get(HOME_FOLDER_ID) as any
    const vs = JSON.parse(row.view_settings_json)

    expect(vs.layout).toBe('sections')
    expect(row.applied_grouping).toBe('vt._home_category')
    expect(vs.appliedGrouping).toBeUndefined() // must not be in the JSON blob
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

    const homes = ctx.db.prepare('SELECT * FROM media_items WHERE id = ?').all(HOME_FOLDER_ID)
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

    const rows = ctx.db.prepare("SELECT * FROM media_locations WHERE relative_path = 'film.mkv'").all()
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

  it('reuses a stable item ID when a folder moves between sources before cleanup', async () => {
    const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-move-a-'))
    const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-move-b-'))

    try {
      const sourceA = { ...SOURCE_A, path: tmpA }
      const sourceB = { ...SOURCE_B, path: tmpB }

      await fs.mkdir(path.join(tmpA, 'Shows', 'Foo'), { recursive: true })
      await fs.writeFile(path.join(tmpA, 'Shows', 'Foo', 'episode.mkv'), 'episode')

      await scanDirectory(sourceA, tmpA)

      const originalLocation = ctx.db.prepare(`
        SELECT item_id
        FROM media_locations
        WHERE source_id = ? AND relative_path = 'Shows/Foo'
      `).get(SOURCE_A.id) as { item_id: string } | undefined
      expect(originalLocation).toBeDefined()

      const originalId = originalLocation!.item_id
      ctx.db.prepare(`
        INSERT INTO folder_settings (item_id, view_settings_json)
        VALUES (?, ?)
      `).run(originalId, JSON.stringify({ layout: 'grid' }))

      await fs.mkdir(path.join(tmpB, 'Shows'), { recursive: true })
      await fs.rename(path.join(tmpA, 'Shows', 'Foo'), path.join(tmpB, 'Shows', 'Foo'))

      let foundA = new Set<string>()
      let foundB = new Set<string>()

      await scanDirectory(sourceA, tmpA, {
        cleanupMissing: false,
        onFoundLocationPaths: (found) => {
          foundA = found
        }
      })
      await scanDirectory(sourceB, tmpB, {
        cleanupMissing: false,
        onFoundLocationPaths: (found) => {
          foundB = found
        }
      })

      cleanupMissingForSource(SOURCE_A.id, '.', foundA, true)
      cleanupMissingForSource(SOURCE_B.id, '.', foundB, true)

      const movedLocation = ctx.db.prepare(`
        SELECT item_id, source_id, relative_path
        FROM media_locations
        WHERE source_id = ? AND relative_path = 'Shows/Foo'
      `).get(SOURCE_B.id) as { item_id: string; source_id: string; relative_path: string } | undefined

      expect(movedLocation).toEqual({
        item_id: originalId,
        source_id: SOURCE_B.id,
        relative_path: 'Shows/Foo'
      })
      expect(repositoryService.getItemById(originalId)?.sourceId).toBe(SOURCE_B.id)

      const oldLocationCount = ctx.db.prepare(`
        SELECT COUNT(*) AS count
        FROM media_locations
        WHERE source_id = ? AND relative_path = 'Shows/Foo'
      `).get(SOURCE_A.id) as { count: number }
      expect(oldLocationCount.count).toBe(0)

      const settings = ctx.db.prepare(`
        SELECT view_settings_json
        FROM folder_settings
        WHERE item_id = ?
      `).get(originalId) as { view_settings_json: string } | undefined
      expect(JSON.parse(settings!.view_settings_json)).toEqual({ layout: 'grid' })
    } finally {
      await fs.rm(tmpA, { recursive: true, force: true })
      await fs.rm(tmpB, { recursive: true, force: true })
    }
  })

  it('does not cleanup a source when the scan root cannot be read', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-offline-source-'))
    const source = { ...SOURCE_A, path: tmp }

    await fs.writeFile(path.join(tmp, 'movie.mkv'), 'movie')
    await scanDirectory(source, tmp)

    const itemId = itemIdForLocation(SOURCE_A.id, 'movie.mkv')
    expect(itemId).not.toBeNull()

    await fs.rm(tmp, { recursive: true, force: true })

    let scanSucceeded = true
    await scanDirectory(source, tmp, {
      onScanSucceeded: (success) => {
        scanSucceeded = success
      }
    })

    expect(scanSucceeded).toBe(false)
    expect(repositoryService.getItemById(itemId!)).not.toBeNull()
    const location = ctx.db.prepare(`
      SELECT is_present
      FROM media_locations
      WHERE source_id = ? AND relative_path = 'movie.mkv'
    `).get(SOURCE_A.id) as { is_present: number } | undefined
    expect(location?.is_present).toBe(1)
  })

  it('preserves episode metadata and watched state when a flat TV show is reorganized into season folders', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-tv-reorg-'))
    const source = { id: 'tv-reorg-source', path: tmp, isRelative: false }
    const showPath = path.join(tmp, 'Shows', 'Example Show')
    const flatEp1 = path.join(showPath, 'Example.Show.S01E01.mkv')
    const flatEp2 = path.join(showPath, 'Example.Show.S01E02.mkv')
    const seasonPath = path.join(showPath, 'Season 01')
    const seasonEp1 = path.join(seasonPath, 'Example Show - S01E01 - Pilot.mkv')
    const seasonEp2 = path.join(seasonPath, 'Example Show - S01E02 - Second.mkv')

    try {
      await fs.mkdir(showPath, { recursive: true })
      await fs.writeFile(flatEp1, 'episode-1')
      await fs.writeFile(flatEp2, 'episode-2')

      await scanDirectory(source, tmp)

      const showId = itemIdForLocation(source.id, 'Shows/Example Show')
      const ep1Id = itemIdForLocation(source.id, 'Shows/Example Show/Example.Show.S01E01.mkv')
      const ep2Id = itemIdForLocation(source.id, 'Shows/Example Show/Example.Show.S01E02.mkv')
      expect(showId).not.toBeNull()
      expect(ep1Id).not.toBeNull()
      expect(ep2Id).not.toBeNull()

      ctx.db.prepare(`
        INSERT INTO media_entities (id, tmdb_id, media_type, title, season_number, episode_number, last_refreshed_at)
        VALUES
          ('entity-show', 123, 'tv', 'Example Show', NULL, NULL, 1000),
          ('entity-ep-1', 123, 'episode', 'Pilot', 1, 1, 2000),
          ('entity-ep-2', 123, 'episode', 'Second', 1, 2, 3000)
      `).run()
      ctx.db.prepare(`
        UPDATE media_items
        SET entity_id = 'entity-show',
            media_kind = 'tv'
        WHERE id = ?
      `).run(showId)
      ctx.db.prepare(`
        UPDATE media_items
        SET entity_id = 'entity-ep-1',
            media_kind = 'episode'
        WHERE id = ?
      `).run(ep1Id)
      ctx.db.prepare(`
        UPDATE media_items
        SET entity_id = 'entity-ep-2',
            media_kind = 'episode'
        WHERE id = ?
      `).run(ep2Id)
      ctx.db.prepare(`
        INSERT INTO user_state (item_id, user_id, watched, last_watched_at)
        VALUES (?, 'default', 1, 5555)
      `).run(ep1Id)

      await fs.mkdir(seasonPath, { recursive: true })
      await fs.rename(flatEp1, seasonEp1)
      await fs.rename(flatEp2, seasonEp2)

      await scanDirectory(source, tmp)

      expect(itemIdForLocation(source.id, 'Shows/Example Show/Season 01/Example Show - S01E01 - Pilot.mkv')).toBe(ep1Id)
      expect(itemIdForLocation(source.id, 'Shows/Example Show/Season 01/Example Show - S01E02 - Second.mkv')).toBe(ep2Id)
      expect(itemIdForLocation(source.id, 'Shows/Example Show/Example.Show.S01E01.mkv')).toBeNull()
      expect(itemIdForLocation(source.id, 'Shows/Example Show/Example.Show.S01E02.mkv')).toBeNull()

      const seasonId = itemIdForLocation(source.id, 'Shows/Example Show/Season 01')
      expect(seasonId).not.toBeNull()

      const ep1 = ctx.db.prepare(`
        SELECT mi.parent_item_id, mi.entity_id, mi.media_kind, ml.relative_path, ml.name,
               e.title, e.season_number, e.episode_number, e.last_refreshed_at
        FROM media_items mi
        JOIN media_locations ml ON ml.item_id = mi.id
        JOIN media_entities e ON e.id = mi.entity_id
        WHERE mi.id = ?
      `).get(ep1Id) as any
      expect(ep1).toEqual({
        parent_item_id: seasonId,
        entity_id: 'entity-ep-1',
        media_kind: 'episode',
        relative_path: 'Shows/Example Show/Season 01/Example Show - S01E01 - Pilot.mkv',
        name: 'Example Show - S01E01 - Pilot.mkv',
        title: 'Pilot',
        season_number: 1,
        episode_number: 1,
        last_refreshed_at: 2000
      })

      const ep2 = ctx.db.prepare(`
        SELECT mi.parent_item_id, mi.entity_id, mi.media_kind,
               e.title, e.season_number, e.episode_number, e.last_refreshed_at
        FROM media_items mi
        JOIN media_entities e ON e.id = mi.entity_id
        WHERE mi.id = ?
      `).get(ep2Id) as any
      expect(ep2).toEqual({
        parent_item_id: seasonId,
        entity_id: 'entity-ep-2',
        media_kind: 'episode',
        title: 'Second',
        season_number: 1,
        episode_number: 2,
        last_refreshed_at: 3000
      })

      const watchedState = ctx.db.prepare(`
        SELECT watched, last_watched_at
        FROM user_state
        WHERE item_id = ? AND user_id = 'default'
      `).get(ep1Id) as { watched: number; last_watched_at: number } | undefined
      expect(watchedState).toEqual({ watched: 1, last_watched_at: 5555 })
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('shadowing', () => {
  const SOURCE_A = { id: 'shadow-source-a', path: '/tmp/a', isRelative: false }
  const SOURCE_B = { id: 'shadow-source-b', path: '/tmp/b', isRelative: false }

  let tmpA: string
  let tmpB: string

  beforeEach(async () => {
    tmpA = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-shadow-a-'))
    tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-shadow-b-'))
  })

  afterEach(async () => {
    await fs.rm(tmpA, { recursive: true, force: true })
    await fs.rm(tmpB, { recursive: true, force: true })
  })

  it('getAllFolderPathsInSource returns folder paths for that source only', () => {
    const { upsertLibraryItems } = require('../database/repositories/filesystem.repo')
    repositoryService.ensureSourceRoot(SOURCE_A, tmpA)
    repositoryService.ensureSourceRoot(SOURCE_B, tmpB)

    const rootAId = generateId(SOURCE_A.id, '.')
    const rootBId = generateId(SOURCE_B.id, '.')
    const moviesAId = generateId(SOURCE_A.id, 'Movies')
    const moviesBId = generateId(SOURCE_B.id, 'Movies')

    upsertLibraryItems([
      { '@id': moviesAId, '@parentId': rootAId, '@path': 'Movies', '@name': 'Movies', '@type': 'folder', '@sourceId': SOURCE_A.id, '@size': 0, '@mtime': 0, '@birthtime': 0, '@inode': 1, '@deviceId': 1, '@isIgnored': 0, '@isHidden': 0 },
      { '@id': moviesBId, '@parentId': rootBId, '@path': 'Movies', '@name': 'Movies', '@type': 'folder', '@sourceId': SOURCE_B.id, '@size': 0, '@mtime': 0, '@birthtime': 0, '@inode': 2, '@deviceId': 1, '@isIgnored': 0, '@isHidden': 0 },
    ])

    const pathsA = getAllFolderPathsInSource(SOURCE_A.id)
    expect(pathsA.has('.')).toBe(true)
    expect(pathsA.has('Movies')).toBe(true)
    expect(pathsA.size).toBe(2) // only source A items

    const pathsB = getAllFolderPathsInSource(SOURCE_B.id)
    expect(pathsB.has('.')).toBe(true)
    expect(pathsB.has('Movies')).toBe(true)
    expect(pathsB.size).toBe(2) // only source B items
  })

  it('getNonEmptyFolderPathsInSource excludes empty folders', async () => {
    await fs.mkdir(path.join(tmpA, 'Movies'))
    await fs.mkdir(path.join(tmpA, 'Shows'))
    await fs.writeFile(path.join(tmpA, 'Shows', 'episode.mkv'), '')

    await scanDirectory({ ...SOURCE_A, path: tmpA }, tmpA)

    const paths = getNonEmptyFolderPathsInSource(SOURCE_A.id)
    expect(paths.has('.')).toBe(true)
    expect(paths.has('Movies')).toBe(false)
    expect(paths.has('Shows')).toBe(true)
  })

  it('skips overlapping folders (and their children) from lower-priority source', async () => {
    // Source A: Movies/ActionFilm/
    await fs.mkdir(path.join(tmpA, 'Movies'))
    await fs.mkdir(path.join(tmpA, 'Movies', 'ActionFilm'))
    await fs.writeFile(path.join(tmpA, 'Movies', 'ActionFilm', 'action.mkv'), '')

    // Source B mirrors Movies/ but also has SciFiFilm/
    await fs.mkdir(path.join(tmpB, 'Movies'))
    await fs.mkdir(path.join(tmpB, 'Movies', 'SciFiFilm'))
    await fs.writeFile(path.join(tmpB, 'Movies', 'SciFiFilm', 'scifi.mkv'), '')

    await scanDirectory({ ...SOURCE_A, path: tmpA }, tmpA)

    const higherPriorityPaths = getNonEmptyFolderPathsInSource(SOURCE_A.id)
    // higherPriorityPaths = { '.', 'Movies', 'Movies/ActionFilm' }

    await scanDirectory({ ...SOURCE_B, path: tmpB }, tmpB, { higherPriorityPaths, shadowMinDepth: 1 })

    // 'Movies' is in higherPriorityPaths at depth 1 >= minDepth 1 → skipped
    // 'Movies/SciFiFilm' is never reached because 'Movies' was not recursed into,
    // but the shadowed Movies folder location is still recorded.
    const scifiBId = itemIdForLocation(SOURCE_B.id, 'Movies/SciFiFilm')
    expect(scifiBId).toBeNull()

    // Source A is unaffected
    const moviesAId = itemIdForLocation(SOURCE_A.id, 'Movies')
    expect(moviesAId).not.toBeNull()
    expect(repositoryService.getItemById(moviesAId!)).not.toBeNull()

    const shadowedLocation = ctx.db.prepare(`
      SELECT item_id, is_shadowed
      FROM media_locations
      WHERE source_id = ? AND relative_path = 'Movies'
    `).get(SOURCE_B.id) as { item_id: string; is_shadowed: number } | undefined
    expect(shadowedLocation).toEqual({ item_id: moviesAId!, is_shadowed: 1 })
  })

  it('prefers a populated lower-priority folder over an empty high-priority folder', async () => {
    await fs.mkdir(path.join(tmpA, 'Movies'))

    await fs.mkdir(path.join(tmpB, 'Movies'))
    await fs.mkdir(path.join(tmpB, 'Movies', 'SciFiFilm'))
    await fs.writeFile(path.join(tmpB, 'Movies', 'SciFiFilm', 'scifi.mkv'), '')

    await scanDirectory({ ...SOURCE_A, path: tmpA }, tmpA)

    const higherPriorityPaths = getNonEmptyFolderPathsInSource(SOURCE_A.id)
    expect(higherPriorityPaths.has('Movies')).toBe(false)

    await scanDirectory({ ...SOURCE_B, path: tmpB }, tmpB, { higherPriorityPaths, shadowMinDepth: 1 })

    const moviesBId = itemIdForLocation(SOURCE_B.id, 'Movies')
    const scifiBId = itemIdForLocation(SOURCE_B.id, 'Movies/SciFiFilm')
    expect(moviesBId).not.toBeNull()
    expect(scifiBId).not.toBeNull()
    expect(repositoryService.getItemById(moviesBId!)).not.toBeNull()
    expect(repositoryService.getItemById(scifiBId!)).not.toBeNull()
  })

  it('respects shadowMinDepth — structural top-level folders are not skipped', async () => {
    // Both sources have Movies/ActionFilm/ (perfect mirror)
    await fs.mkdir(path.join(tmpA, 'Movies'))
    await fs.mkdir(path.join(tmpA, 'Movies', 'ActionFilm'))
    await fs.writeFile(path.join(tmpA, 'Movies', 'ActionFilm', 'action.mkv'), '')

    await fs.mkdir(path.join(tmpB, 'Movies'))
    await fs.mkdir(path.join(tmpB, 'Movies', 'ActionFilm'))
    await fs.writeFile(path.join(tmpB, 'Movies', 'ActionFilm', 'action.mkv'), '')

    await scanDirectory({ ...SOURCE_A, path: tmpA }, tmpA)

    const higherPriorityPaths = getNonEmptyFolderPathsInSource(SOURCE_A.id)
    // higherPriorityPaths = { '.', 'Movies', 'Movies/ActionFilm' }

    // minDepth=2: 'Movies' (depth 1) is below threshold → not skipped
    //             'Movies/ActionFilm' (depth 2) IS at threshold and in the set → skipped
    await scanDirectory({ ...SOURCE_B, path: tmpB }, tmpB, { higherPriorityPaths, shadowMinDepth: 2 })

    const moviesBId = itemIdForLocation(SOURCE_B.id, 'Movies')
    const actionFilmBId = itemIdForLocation(SOURCE_B.id, 'Movies/ActionFilm')

    expect(moviesBId).not.toBeNull()
    expect(repositoryService.getItemById(moviesBId!)).not.toBeNull()   // depth 1 < 2 -> present
    const actionFilmAId = itemIdForLocation(SOURCE_A.id, 'Movies/ActionFilm')
    expect(actionFilmAId).not.toBeNull()
    expect(actionFilmBId).toBe(actionFilmAId)   // depth 2 >= 2, in set -> shadowed to source A's item
    const shadowedLocation = ctx.db.prepare(`
      SELECT is_shadowed
      FROM media_locations
      WHERE source_id = ? AND relative_path = 'Movies/ActionFilm'
    `).get(SOURCE_B.id) as { is_shadowed: number } | undefined
    expect(shadowedLocation?.is_shadowed).toBe(1)
  })

  it('non-overlapping folders in lower-priority source are never skipped', async () => {
    // Source A: Movies/; Source B: Shows/ (no overlap)
    await fs.mkdir(path.join(tmpA, 'Movies'))
    await fs.mkdir(path.join(tmpB, 'Shows'))
    await fs.mkdir(path.join(tmpB, 'Shows', 'BreakingBad'))

    await scanDirectory({ ...SOURCE_A, path: tmpA }, tmpA)

    const higherPriorityPaths = getNonEmptyFolderPathsInSource(SOURCE_A.id)
    // higherPriorityPaths = { '.' }

    await scanDirectory({ ...SOURCE_B, path: tmpB }, tmpB, { higherPriorityPaths, shadowMinDepth: 1 })

    // 'Shows' and 'Shows/BreakingBad' are not in source A's paths → both present in B
    const showsBId = itemIdForLocation(SOURCE_B.id, 'Shows')
    const breakingBadBId = itemIdForLocation(SOURCE_B.id, 'Shows/BreakingBad')
    expect(showsBId).not.toBeNull()
    expect(breakingBadBId).not.toBeNull()
    expect(repositoryService.getItemById(showsBId!)).not.toBeNull()
    expect(repositoryService.getItemById(breakingBadBId!)).not.toBeNull()
  })

  it('without higherPriorityPaths all folders are included', async () => {
    await fs.mkdir(path.join(tmpB, 'Movies'))
    await fs.mkdir(path.join(tmpB, 'Movies', 'SciFiFilm'))

    await scanDirectory({ ...SOURCE_B, path: tmpB }, tmpB)

    const moviesBId = itemIdForLocation(SOURCE_B.id, 'Movies')
    const scifiBId = itemIdForLocation(SOURCE_B.id, 'Movies/SciFiFilm')
    expect(moviesBId).not.toBeNull()
    expect(scifiBId).not.toBeNull()
    expect(repositoryService.getItemById(moviesBId!)).not.toBeNull()
    expect(repositoryService.getItemById(scifiBId!)).not.toBeNull()
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
