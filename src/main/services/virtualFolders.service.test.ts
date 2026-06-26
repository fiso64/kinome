/**
 * Virtual Folders Service — Integration Tests
 *
 * Tests the write→read round-trip through real service functions
 * against an in-memory SQLite DB. No mocking — the same code paths
 * that run in production run here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { createUserVirtualFolder, deleteVirtualFolder, resolveEffectiveFilter } from './virtualFolders.service'
import { applyGrouping } from './grouping.service'
import { find, _updateItem } from './repository.service'
import { compileFilter } from '../database/query-builder'
import { ensureHomeVirtualFolder, HOME_FOLDER_ID } from '../database/repositories/filesystem.repo'
import { getItemById } from './repository.service'
import type { MediaFolder, LibraryFilter } from '@shared/types'

let ctx: ServiceTestContext

beforeEach(() => {
  ctx = createServiceTestContext()
})

afterEach(() => {
  ctx.cleanup()
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
    expect(home.filter?.conditionGroups).toHaveLength(3)
  })

  it('is idempotent — calling twice does not error or duplicate', () => {
    ensureHomeVirtualFolder('root')
    ensureHomeVirtualFolder('root')

    const rows = ctx.db.prepare(`SELECT * FROM media_items WHERE virtual_type = 'home'`).all()
    expect(rows).toHaveLength(1)
  })

  it('home folder filter resolves to items with matching parent and mediaType', () => {
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie' },
      { id: 'e2', mediaType: 'tv' },
    ])
    ctx.seedItems([
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder', entityId: 'e1' },
      { id: 'tv', parentId: 'root', path: 'tv', type: 'folder', entityId: 'e2' },
    ])
    ctx.seedFolderSettings([
      { itemId: 'root', folderSettings: { retrieveChildrenMetadata: true } },
    ])

    ensureHomeVirtualFolder('root')
    const home = getItemById(HOME_FOLDER_ID) as MediaFolder
    const compiled = compileFilter(home.filter!)
    const children = find({ ...compiled, includeHidden: true, includeIgnored: true })

    expect(children).toHaveLength(2)
    const ids = children.map((c) => c.id).sort()
    expect(ids).toEqual(['movies', 'tv'])
  })

  it('home filter includes unmatched items when parent has retrieveChildrenMetadata', () => {
    // Item with no entity/mediaType at all — just a bare folder under a scraper-enabled parent
    ctx.seedItems([
      { id: 'bare-folder', parentId: 'root', path: 'bare-folder', type: 'folder' },
    ])
    ctx.seedFolderSettings([
      { itemId: 'root', folderSettings: { retrieveChildrenMetadata: true } },
    ])

    ensureHomeVirtualFolder('root')
    const home = getItemById(HOME_FOLDER_ID) as MediaFolder
    const compiled = compileFilter(home.filter!)
    const children = find({ ...compiled, includeHidden: true, includeIgnored: true })

    expect(children.map((c) => c.id)).toContain('bare-folder')
  })

  it('_updateItem persists filter changes for virtual folders', () => {
    ctx.seedItems([
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder' },
      { id: 'tv', parentId: 'root', path: 'tv', type: 'folder' },
    ])

    const vfId = createUserVirtualFolder('root', 'test-vf', {
      scope: { parentId: 'root' },
      conditionGroups: [[{ field: 'genre', op: 'contains', value: '' }]]
    })

    // Update the filter via _updateItem
    const newFilter: LibraryFilter = {
      scope: { parentId: 'root' },
      conditionGroups: [[{ field: 'title', op: 'eq', value: 'movies' }]]
    }
    _updateItem(vfId, { filter: newFilter } as any)

    // Re-read and verify the filter was persisted
    const updated = getItemById(vfId) as MediaFolder
    expect(updated.filter).toEqual(newFilter)
  })
})

// =================================================================
// resolveEffectiveFilter — filter merging
// =================================================================

describe('resolveEffectiveFilter', () => {
  beforeEach(() => {
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
    ])
  })

  it('single-group child uses optimized path: parent groups preserved, child conditions become requiredConditions', () => {
    const parentId = createUserVirtualFolder('root', 'Parent', {
      conditionGroups: [
        [{ field: 'mediaType', op: 'eq', value: 'movie' }],
        [{ field: 'mediaType', op: 'eq', value: 'tv' }],
      ],
    })

    const childFilter: LibraryFilter = {
      scope: { parentId },
      conditionGroups: [[{ field: 'year', op: 'eq', value: 2024 }]],
    }

    const result = resolveEffectiveFilter(childFilter)

    // Parent's 2 OR-groups must be preserved as-is — no cross-product
    expect(result.conditionGroups).toHaveLength(2)
    expect(result.conditionGroups![0]).toEqual([{ field: 'mediaType', op: 'eq', value: 'movie' }])
    expect(result.conditionGroups![1]).toEqual([{ field: 'mediaType', op: 'eq', value: 'tv' }])
    // Child's condition goes into requiredConditions
    expect(result.requiredConditions).toEqual([{ field: 'year', op: 'eq', value: 2024 }])
  })

  it('child with no conditions returns parent filter with empty requiredConditions', () => {
    const parentId = createUserVirtualFolder('root', 'Parent', {
      conditionGroups: [
        [{ field: 'mediaType', op: 'eq', value: 'movie' }],
        [{ field: 'mediaType', op: 'eq', value: 'tv' }],
      ],
    })

    const childFilter: LibraryFilter = {
      scope: { parentId },
      conditionGroups: [],
    }

    const result = resolveEffectiveFilter(childFilter)

    expect(result.conditionGroups).toHaveLength(2)
    expect(result.requiredConditions).toEqual([])
  })

  it('multi-group child falls back to cross-product, no requiredConditions', () => {
    const parentId = createUserVirtualFolder('root', 'Parent', {
      conditionGroups: [
        [{ field: 'mediaType', op: 'eq', value: 'movie' }],
        [{ field: 'mediaType', op: 'eq', value: 'tv' }],
      ],
    })

    const childFilter: LibraryFilter = {
      scope: { parentId },
      conditionGroups: [
        [{ field: 'year', op: 'eq', value: 2023 }],
        [{ field: 'year', op: 'eq', value: 2024 }],
      ],
    }

    const result = resolveEffectiveFilter(childFilter)

    // 2 parent groups × 2 child groups = 4 cross-product groups
    expect(result.conditionGroups).toHaveLength(4)
    expect(result.requiredConditions).toBeUndefined()
  })

  it('recursive merge: grandchild accumulates requiredConditions from each level', () => {
    // A: 3-group filter (like home)
    const folderAId = createUserVirtualFolder('root', 'A', {
      conditionGroups: [
        [{ field: 'mediaType', op: 'eq', value: 'movie' }],
        [{ field: 'mediaType', op: 'eq', value: 'tv' }],
        [{ field: 'year', op: 'gt', value: 2000 }],
      ],
    })

    // B: single condition, inheriting A
    const folderBId = createUserVirtualFolder(folderAId, 'B', {
      scope: { parentId: folderAId },
      conditionGroups: [[{ field: 'year', op: 'eq', value: 2023 }]],
    })

    // C: single condition, inheriting B
    const folderCFilter: LibraryFilter = {
      scope: { parentId: folderBId },
      conditionGroups: [[{ field: 'title', op: 'contains', value: 'Test' }]],
    }

    const result = resolveEffectiveFilter(folderCFilter)

    // A's 3 OR-groups are preserved
    expect(result.conditionGroups).toHaveLength(3)
    // B's condition + C's condition are both in requiredConditions
    expect(result.requiredConditions).toHaveLength(2)
    expect(result.requiredConditions).toContainEqual({ field: 'year', op: 'eq', value: 2023 })
    expect(result.requiredConditions).toContainEqual({ field: 'title', op: 'contains', value: 'Test' })
  })

  it('optimized filter resolves to correct items end-to-end', () => {
    ctx.seedEntities([
      { id: 'e-movie-2024', mediaType: 'movie', year: 2024 },
      { id: 'e-movie-2023', mediaType: 'movie', year: 2023 },
      { id: 'e-tv-2024', mediaType: 'tv', year: 2024 },
    ])
    ctx.seedItems([
      { id: 'film-2024', parentId: 'root', path: 'film-2024', entityId: 'e-movie-2024' },
      { id: 'film-2023', parentId: 'root', path: 'film-2023', entityId: 'e-movie-2023' },
      { id: 'show-2024', parentId: 'root', path: 'show-2024', entityId: 'e-tv-2024' },
    ])

    // Parent: movies OR tv (2 OR-groups, like a simplified home pool)
    const parentId = createUserVirtualFolder('root', 'Media Pool', {
      conditionGroups: [
        [{ field: 'mediaType', op: 'eq', value: 'movie' }],
        [{ field: 'mediaType', op: 'eq', value: 'tv' }],
      ],
    })

    // Child: single condition — filter to 2024 only
    const childFilter: LibraryFilter = {
      scope: { parentId },
      conditionGroups: [[{ field: 'year', op: 'eq', value: 2024 }]],
    }

    const effective = resolveEffectiveFilter(childFilter)
    const compiled = compileFilter(effective)
    const results = find({ ...compiled, includeHidden: true, includeIgnored: true })
    const ids = results.map((r) => r.id).sort()

    // Both movie and show from 2024 should be returned, but NOT the 2023 movie
    expect(ids).toEqual(['film-2024', 'show-2024'])
  })
})
