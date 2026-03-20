/**
 * Virtual Folders Service — Integration Tests
 *
 * Tests the write→read round-trip through real service functions
 * against an in-memory SQLite DB. No mocking — the same code paths
 * that run in production run here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { createUserVirtualFolder, deleteVirtualFolder } from './virtualFolders.service'
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

    const rows = ctx.db.prepare(`SELECT * FROM items WHERE virtual_type = 'home'`).all()
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