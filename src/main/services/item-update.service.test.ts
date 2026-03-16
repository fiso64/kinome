/**
 * Item Update Service Tests
 *
 * Integration tests for updateIfChangedAndBroadcast — the central function
 * that persists item changes, re-evaluates virtual tags, syncs groupings,
 * and broadcasts updates.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { updateIfChangedAndBroadcast, isItemDataSame } from './item-update.service'
import { applyGrouping } from './virtualFolders.service'
import { getItemById, find } from './repository.service'
import type { LibraryItem, Settings } from '@shared/types'

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    playerCommands: [],
    customActions: [],
    tmdbApiKey: '',
    useLogos: true,
    creditsDisplay: 'tab',
    grayOutWatched: true,
    showContinueWatching: true,
    showNextUp: true,
    virtualTags: [],
    libraryLocation: '',
    mediaSourcePath: '',
    mediaSourcePathIsRelative: false,
    defaultLayoutSettings: {} as any,
    defaultLayouts: {} as any,
    searchResultView: {} as any,
    searchPopupView: {} as any,
    itemDetailBackdropSize: 'small',
    itemDetailBackdropBlur: 4,
    allowUnauthenticated: false,
    serverPort: 3000,
    serverHost: '::',
    ...overrides
  } as Settings
}

const DEFAULT_SETTINGS = makeSettings()

describe('updateIfChangedAndBroadcast', () => {
  let ctx: ServiceTestContext

  beforeEach(() => {
    ctx = createServiceTestContext()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  it('persists a metadata change to the DB', async () => {
    ctx.seedEntities([{ id: 'e1', mediaType: 'movie', title: 'Old Title' }])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'movie1', parentId: 'root', type: 'file', entityId: 'e1' }
    ])

    await updateIfChangedAndBroadcast(
      { id: 'movie1', title: 'New Title' } as LibraryItem,
      { settings: DEFAULT_SETTINGS }
    )

    const item = getItemById('movie1')
    expect(item?.title).toBe('New Title')
  })

  it('does not update _v when data is unchanged', async () => {
    ctx.seedEntities([{ id: 'e1', mediaType: 'movie', title: 'Same Title' }])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'movie1', parentId: 'root', type: 'file', entityId: 'e1' }
    ])

    // First update to set initial _v
    await updateIfChangedAndBroadcast(
      { id: 'movie1', title: 'Same Title', mediaType: 'movie' } as LibraryItem,
      { settings: DEFAULT_SETTINGS }
    )

    const afterFirst = getItemById('movie1')
    const firstV = afterFirst?._v

    // Second update with same data — _v should not change
    await updateIfChangedAndBroadcast(
      { id: 'movie1', title: 'Same Title', mediaType: 'movie' } as LibraryItem,
      { settings: DEFAULT_SETTINGS }
    )

    const afterSecond = getItemById('movie1')
    expect(afterSecond?._v).toBe(firstV)
  })

  it('re-evaluates virtual tags when item metadata changes', async () => {
    const settings = makeSettings({
      virtualTags: [{
        id: 'vt-animated',
        name: 'is_animated',
        cases: [
          {
            filter: {
              conditions: [{ field: 'genre', op: 'eq' as any, value: 'Animation' }]
            },
            result: 'yes'
          }
        ],
        defaultResult: 'no'
      }]
    })

    ctx.seedEntities([{ id: 'e1', mediaType: 'movie', title: 'Spirited Away' }])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'movie1', parentId: 'root', type: 'file', entityId: 'e1' }
    ])
    ctx.seedGenres('e1', ['Animation', 'Fantasy'])

    await updateIfChangedAndBroadcast(
      { id: 'movie1', title: 'Spirited Away', genres: ['Animation', 'Fantasy'] } as LibraryItem,
      { settings }
    )

    // Check entity_virtual_tags table was populated
    const vtags = ctx.db.prepare(
      `SELECT key, value FROM entity_virtual_tags WHERE entity_id = ?`
    ).all('e1') as { key: string; value: string }[]

    expect(vtags).toContainEqual({ key: 'is_animated', value: 'yes' })
  })

  it('syncs grouping virtual folders after metadata change', async () => {
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie', title: 'Action Movie', year: 2020 },
      { id: 'e2', mediaType: 'movie', title: 'Drama Movie', year: 2021 }
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'movie1', parentId: 'root', type: 'file', entityId: 'e1' },
      { id: 'movie2', parentId: 'root', type: 'file', entityId: 'e2' }
    ])
    ctx.seedGenres('e1', ['Action'])
    ctx.seedGenres('e2', ['Drama'])

    // Apply genre grouping on root
    applyGrouping('root', 'genre')

    // Verify initial grouping folders
    const initialGroups = find({
      where: { parentId: 'root' },
      rawConditions: ['i.is_virtual = 1'],
      fields: ['id', 'name']
    })
    expect(initialGroups.length).toBe(2) // Action, Drama

    // Now add Comedy to movie1 via the update pipeline (no manual DB seed)
    await updateIfChangedAndBroadcast(
      { id: 'movie1', genres: ['Action', 'Comedy'] } as LibraryItem,
      { settings: DEFAULT_SETTINGS }
    )

    // Grouping should now have 3 folders: Action, Comedy, Drama
    const updatedGroups = find({
      where: { parentId: 'root' },
      rawConditions: ['i.is_virtual = 1'],
      fields: ['id', 'name']
    })
    const groupNames = updatedGroups.map((g: any) => g.name).sort()
    expect(groupNames).toEqual(['Action', 'Comedy', 'Drama'])
  })

  it('skips virtual items during DB persistence', async () => {
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' }
    ])

    // Updating a virtual item should not crash
    await updateIfChangedAndBroadcast(
      { id: 'virtual-item', isVirtual: true, name: 'Virtual' } as any,
      { settings: DEFAULT_SETTINGS }
    )

    // Virtual item should NOT be in the items table
    const item = getItemById('virtual-item')
    expect(item).toBeNull()
  })
})

describe('isItemDataSame', () => {
  it('returns true for identical items', () => {
    const item = { id: '1', name: 'test', type: 'file' as const } as LibraryItem
    expect(isItemDataSame(item, { ...item })).toBe(true)
  })

  it('returns false when a field differs', () => {
    const a = { id: '1', name: 'test', title: 'A' } as LibraryItem
    const b = { id: '1', name: 'test', title: 'B' } as LibraryItem
    expect(isItemDataSame(a, b)).toBe(false)
  })

  it('ignores volatile fields (_v, _internalId, children, ancestorIds, isVirtual)', () => {
    const a = { id: '1', name: 'test', _v: 1, _internalId: 10, children: [{}], ancestorIds: ['x'], isVirtual: false } as any
    const b = { id: '1', name: 'test', _v: 2, _internalId: 20, children: [{}], ancestorIds: ['y'], isVirtual: true } as any
    expect(isItemDataSame(a, b)).toBe(true)
  })
})
