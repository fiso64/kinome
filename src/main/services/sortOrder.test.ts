/**
 * Sort Order Tests
 *
 * Covers:
 * 1. buildSortOrder unit tests — correct clauses for each sortBy + descending combinations
 * 2. nullsLast query-builder integration — correct SQL emitted for ORDER BY with nullsLast
 * 3. settings cascade — sortBy/sortDescending resolved from item, inherited, and type layers
 * 4. getChildren integration — verifies actual DB ordering for each sort mode
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import path from 'path'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'

// --- Mock I/O boundaries ---
const SETTINGS_SERVICE_PATH = path.resolve(__dirname, './settings.service.ts')
const NAVIGATION_SERVICE_PATH = path.resolve(__dirname, './navigation.service.ts')

let mockSettings: any = {
  libraryLocation: 'mock_root',
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

mock.module(NAVIGATION_SERVICE_PATH, () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const original = require('./navigation.service')
  return {
    ...original,
    getLibraryRoot: () =>
      Promise.resolve({
        status: 'ready',
        root: { id: 'root', name: 'Root', type: 'folder', children: [] },
      }),
  }
})

import { buildSortOrder, getChildren } from './navigation.service'
import { buildFindQuery } from '../database/query-builder'
import { resolveViewSettings } from '@shared/settings-helpers'
import { mergeSettings } from '../database/repositories/settings.repo'
import type { LibraryItem } from '@shared/types'

let ctx: ServiceTestContext

beforeEach(() => {
  ctx = createServiceTestContext()
})

afterEach(() => {
  ctx.cleanup()
})

function expectItems(result: any): LibraryItem[] {
  expect(Array.isArray(result)).toBe(true)
  return result as LibraryItem[]
}

// =================================================================
// 1. buildSortOrder — unit tests
// =================================================================

describe('buildSortOrder', () => {
  describe('hybrid (default)', () => {
    it('generic folder: typeRank ASC + displayName ASC', () => {
      const clauses = buildSortOrder(undefined)
      expect(clauses).toEqual([
        { field: 'typeRank', direction: 'ASC' },
        { field: 'displayName', direction: 'ASC' },
      ])
    })

    it('tv folder: typeRank ASC + seasonNumber ASC + displayName ASC', () => {
      const clauses = buildSortOrder('tv')
      expect(clauses).toEqual([
        { field: 'typeRank', direction: 'ASC' },
        { field: 'seasonNumber', direction: 'ASC' },
        { field: 'displayName', direction: 'ASC' },
      ])
    })

    it('season folder: typeRank ASC + episodeNumber ASC', () => {
      const clauses = buildSortOrder('season')
      expect(clauses).toEqual([
        { field: 'typeRank', direction: 'ASC' },
        { field: 'episodeNumber', direction: 'ASC' },
      ])
    })

    it('hybrid descending: typeRank stays ASC, primary key flips to DESC', () => {
      expect(buildSortOrder('tv', 'hybrid', true)).toEqual([
        { field: 'typeRank', direction: 'ASC' },
        { field: 'seasonNumber', direction: 'DESC' },
        { field: 'displayName', direction: 'DESC' },
      ])
      expect(buildSortOrder('season', 'hybrid', true)).toEqual([
        { field: 'typeRank', direction: 'ASC' },
        { field: 'episodeNumber', direction: 'DESC' },
      ])
      expect(buildSortOrder(undefined, 'hybrid', true)).toEqual([
        { field: 'typeRank', direction: 'ASC' },
        { field: 'displayName', direction: 'DESC' },
      ])
    })
  })

  describe('alpha', () => {
    it('ASC: single displayName ASC clause', () => {
      expect(buildSortOrder(undefined, 'alpha')).toEqual([
        { field: 'displayName', direction: 'ASC' },
      ])
    })

    it('DESC: single displayName DESC clause', () => {
      expect(buildSortOrder(undefined, 'alpha', true)).toEqual([
        { field: 'displayName', direction: 'DESC' },
      ])
    })

    it('mediaType is irrelevant for alpha sort', () => {
      expect(buildSortOrder('tv', 'alpha')).toEqual([
        { field: 'displayName', direction: 'ASC' },
      ])
    })
  })

  describe('date-added', () => {
    it('ASC: single addedAt ASC clause', () => {
      expect(buildSortOrder(undefined, 'date-added')).toEqual([
        { field: 'addedAt', direction: 'ASC' },
      ])
    })

    it('DESC: single addedAt DESC clause', () => {
      expect(buildSortOrder(undefined, 'date-added', true)).toEqual([
        { field: 'addedAt', direction: 'DESC' },
      ])
    })
  })

  describe('year', () => {
    it('ASC: year nullsLast ASC + displayName tiebreaker ASC', () => {
      expect(buildSortOrder(undefined, 'year')).toEqual([
        { field: 'year', direction: 'ASC', nullsLast: true },
        { field: 'displayName', direction: 'ASC' },
      ])
    })

    it('DESC: year nullsLast DESC + displayName tiebreaker always ASC', () => {
      expect(buildSortOrder(undefined, 'year', true)).toEqual([
        { field: 'year', direction: 'DESC', nullsLast: true },
        { field: 'displayName', direction: 'ASC' },
      ])
    })

    it('mediaType is irrelevant for year sort', () => {
      expect(buildSortOrder('tv', 'year')).toEqual([
        { field: 'year', direction: 'ASC', nullsLast: true },
        { field: 'displayName', direction: 'ASC' },
      ])
    })
  })
})

// =================================================================
// 2. nullsLast — query builder SQL emission
// =================================================================

describe('buildFindQuery — nullsLast', () => {
  it('emits CASE IS NULL guard when nullsLast is true', () => {
    const { query } = buildFindQuery({
      where: { parentId: 'x' },
      orderBy: [{ field: 'year', direction: 'ASC', nullsLast: true }],
    })
    expect(query).toContain('CASE WHEN')
    expect(query).toContain('IS NULL')
    expect(query).toContain('ELSE 0')
    expect(query).toContain('e.year ASC')
  })

  it('does NOT emit CASE guard when nullsLast is absent', () => {
    const { query } = buildFindQuery({
      where: { parentId: 'x' },
      orderBy: [{ field: 'year', direction: 'ASC' }],
    })
    expect(query).not.toContain('CASE WHEN')
    expect(query).toContain('e.year ASC')
  })

  it('nullsLast DESC puts non-null rows first, null rows last', () => {
    const { query } = buildFindQuery({
      where: { parentId: 'x' },
      orderBy: [{ field: 'year', direction: 'DESC', nullsLast: true }],
    })
    // The null-guard is always ASC so nulls sort last regardless of main direction
    expect(query).toContain('(CASE WHEN e.year IS NULL THEN 1 ELSE 0 END) ASC')
    expect(query).toContain('e.year DESC')
  })
})

// =================================================================
// 3. FolderOrganizationSettings — not part of the cascade
// =================================================================

describe('resolveViewSettings — sortBy is NOT in the cascade', () => {
  const baseSettings: any = {
    defaultLayouts: { _default: { layout: 'grid', clickAction: 'detail' } },
    defaultLayoutSettings: { grid: {}, list: {}, tabs: {}, sections: {} },
  }

  it('sortBy is absent from ResolvedViewSettings (not a cascadable field)', () => {
    const item: any = {
      id: 'f1',
      type: 'folder',
      viewSettings: { sortBy: 'year', sortDescending: true },
    }
    const { settings } = resolveViewSettings(item, baseSettings)
    // sortBy lives in FolderOrganizationSettings, not CascadableViewSettings —
    // it is never part of the resolved output.
    expect((settings as any).sortBy).toBeUndefined()
    expect((settings as any).sortDescending).toBeUndefined()
  })

  it('passing sortBy in inheritedSettings does not affect resolution', () => {
    const item: any = { id: 'f1', type: 'folder', viewSettings: {} }
    // TypeScript prevents this at compile time; verify runtime is also unaffected.
    const inherited: any = { sortBy: 'date-added' }
    const { settings } = resolveViewSettings(item, baseSettings, new Set(), inherited)
    expect((settings as any).sortBy).toBeUndefined()
  })
})

// =================================================================
// 4. getChildren integration — DB ordering per sort mode
// =================================================================

describe('getChildren — sort ordering', () => {
  beforeEach(() => {
    // Seed parent folder
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'parent', parentId: 'root', path: 'parent', type: 'folder' },
    ])
  })

  it('alpha ASC: children ordered A→Z by display name', async () => {
    ctx.seedEntities([
      { id: 'eZ', title: 'Zebra' },
      { id: 'eA', title: 'Apple' },
      { id: 'eM', title: 'Mango' },
    ])
    ctx.seedItems([
      { id: 'cZ', parentId: 'parent', path: 'parent/z', type: 'folder', entityId: 'eZ' },
      { id: 'cA', parentId: 'parent', path: 'parent/a', type: 'folder', entityId: 'eA' },
      { id: 'cM', parentId: 'parent', path: 'parent/m', type: 'folder', entityId: 'eM' },
    ])
    mergeSettings('parent', { viewSettings: { sortBy: 'alpha' } })

    const result = expectItems(await getChildren('parent', {}))
    const names = result.map((i) => i.title ?? i.name)
    expect(names).toEqual(['Apple', 'Mango', 'Zebra'])
  })

  it('alpha DESC: children ordered Z→A', async () => {
    ctx.seedEntities([
      { id: 'eZ', title: 'Zebra' },
      { id: 'eA', title: 'Apple' },
      { id: 'eM', title: 'Mango' },
    ])
    ctx.seedItems([
      { id: 'cZ', parentId: 'parent', path: 'parent/z', type: 'folder', entityId: 'eZ' },
      { id: 'cA', parentId: 'parent', path: 'parent/a', type: 'folder', entityId: 'eA' },
      { id: 'cM', parentId: 'parent', path: 'parent/m', type: 'folder', entityId: 'eM' },
    ])
    mergeSettings('parent', { viewSettings: { sortBy: 'alpha', sortDescending: true } })

    const result = expectItems(await getChildren('parent', {}))
    const names = result.map((i) => i.title ?? i.name)
    expect(names).toEqual(['Zebra', 'Mango', 'Apple'])
  })

  it('date-added ASC: older items come first', async () => {
    ctx.seedItems([
      { id: 'new', parentId: 'parent', path: 'parent/new', type: 'folder' },
      { id: 'old', parentId: 'parent', path: 'parent/old', type: 'folder' },
    ])
    // Backdate 'old' to a very early timestamp
    ctx.db.prepare('UPDATE items SET added_at = 1000 WHERE id = ?').run('old')
    ctx.db.prepare('UPDATE items SET added_at = 9999999999999 WHERE id = ?').run('new')
    mergeSettings('parent', { viewSettings: { sortBy: 'date-added' } })

    const result = expectItems(await getChildren('parent', {}))
    expect(result[0].id).toBe('old')
    expect(result[1].id).toBe('new')
  })

  it('date-added DESC: newer items come first', async () => {
    ctx.seedItems([
      { id: 'new', parentId: 'parent', path: 'parent/new', type: 'folder' },
      { id: 'old', parentId: 'parent', path: 'parent/old', type: 'folder' },
    ])
    ctx.db.prepare('UPDATE items SET added_at = 1000 WHERE id = ?').run('old')
    ctx.db.prepare('UPDATE items SET added_at = 9999999999999 WHERE id = ?').run('new')
    mergeSettings('parent', { viewSettings: { sortBy: 'date-added', sortDescending: true } })

    const result = expectItems(await getChildren('parent', {}))
    expect(result[0].id).toBe('new')
    expect(result[1].id).toBe('old')
  })

  it('year ASC: items ordered oldest year first, null-year items last', async () => {
    ctx.seedEntities([
      { id: 'e2010', year: 2010, title: '2010 Film' },
      { id: 'e2020', year: 2020, title: '2020 Film' },
      { id: 'eNull', year: null, title: 'No Year' },
    ])
    ctx.seedItems([
      { id: 'c2020', parentId: 'parent', path: 'parent/2020', type: 'folder', entityId: 'e2020' },
      { id: 'c2010', parentId: 'parent', path: 'parent/2010', type: 'folder', entityId: 'e2010' },
      { id: 'cNull', parentId: 'parent', path: 'parent/null', type: 'folder', entityId: 'eNull' },
    ])
    mergeSettings('parent', { viewSettings: { sortBy: 'year' } })

    const result = expectItems(await getChildren('parent', {}))
    const years = result.map((i) => i.year ?? null)
    expect(years).toEqual([2010, 2020, null])
  })

  it('year DESC: newest year first, null-year items still last', async () => {
    ctx.seedEntities([
      { id: 'e2010', year: 2010, title: '2010 Film' },
      { id: 'e2020', year: 2020, title: '2020 Film' },
      { id: 'eNull', year: null, title: 'No Year' },
    ])
    ctx.seedItems([
      { id: 'c2020', parentId: 'parent', path: 'parent/2020', type: 'folder', entityId: 'e2020' },
      { id: 'c2010', parentId: 'parent', path: 'parent/2010', type: 'folder', entityId: 'e2010' },
      { id: 'cNull', parentId: 'parent', path: 'parent/null', type: 'folder', entityId: 'eNull' },
    ])
    mergeSettings('parent', { viewSettings: { sortBy: 'year', sortDescending: true } })

    const result = expectItems(await getChildren('parent', {}))
    const years = result.map((i) => i.year ?? null)
    expect(years).toEqual([2020, 2010, null])
  })

  it('year sort: items without entity also sort last (no entity_id → no JOIN row)', async () => {
    ctx.seedEntities([{ id: 'e2015', year: 2015, title: 'Has Year' }])
    ctx.seedItems([
      { id: 'withYear', parentId: 'parent', path: 'parent/wy', type: 'folder', entityId: 'e2015' },
      { id: 'noEntity', parentId: 'parent', path: 'parent/ne', type: 'folder' },
    ])
    mergeSettings('parent', { viewSettings: { sortBy: 'year' } })

    const result = expectItems(await getChildren('parent', {}))
    expect(result[0].id).toBe('withYear')
    expect(result[1].id).toBe('noEntity')
  })

  it('hybrid ASC (default): tv folder sorts seasons by number', async () => {
    ctx.seedEntities([
      { id: 'eShow', mediaType: 'tv', title: 'My Show' },
      { id: 'eS3', mediaType: 'season', seasonNumber: 3 },
      { id: 'eS1', mediaType: 'season', seasonNumber: 1 },
      { id: 'eS2', mediaType: 'season', seasonNumber: 2 },
    ])
    ctx.seedItems([
      { id: 'show', parentId: 'root', path: 'show', type: 'folder', entityId: 'eShow' },
      { id: 's3', parentId: 'show', path: 'show/s3', type: 'folder', entityId: 'eS3' },
      { id: 's1', parentId: 'show', path: 'show/s1', type: 'folder', entityId: 'eS1' },
      { id: 's2', parentId: 'show', path: 'show/s2', type: 'folder', entityId: 'eS2' },
    ])
    // sortBy defaults to hybrid — no explicit setting needed

    const result = expectItems(await getChildren('show', {}))
    expect(result.map((i) => i.id)).toEqual(['s1', 's2', 's3'])
  })

  it('hybrid: episodes sort before folders (typeRank)', async () => {
    ctx.seedEntities([
      { id: 'eSeason', mediaType: 'season', seasonNumber: 1, title: 'Season 1' },
      { id: 'eEp1', mediaType: 'episode', episodeNumber: 1, title: 'Episode 1' },
      { id: 'eEp2', mediaType: 'episode', episodeNumber: 2, title: 'Episode 2' },
      { id: 'eExtras', title: 'Extras' },
    ])
    ctx.seedItems([
      { id: 'season', parentId: 'root', path: 'show/s1', type: 'folder', entityId: 'eSeason' },
      { id: 'ep1', parentId: 'season', path: 'show/s1/ep1', type: 'file', entityId: 'eEp1' },
      { id: 'ep2', parentId: 'season', path: 'show/s1/ep2', type: 'file', entityId: 'eEp2' },
      { id: 'extras', parentId: 'season', path: 'show/s1/extras', type: 'folder', entityId: 'eExtras' },
    ])

    const result = expectItems(await getChildren('season', {}))
    const ids = result.map((i) => i.id)
    // Episodes (typeRank 1) must come before the Extras folder (typeRank 2)
    expect(ids.indexOf('ep1')).toBeLessThan(ids.indexOf('extras'))
    expect(ids.indexOf('ep2')).toBeLessThan(ids.indexOf('extras'))
  })

  it('hybrid DESC: tv folder sorts seasons in reverse (S3, S2, S1)', async () => {
    ctx.seedEntities([
      { id: 'eShow', mediaType: 'tv', title: 'My Show' },
      { id: 'eS3', mediaType: 'season', seasonNumber: 3 },
      { id: 'eS1', mediaType: 'season', seasonNumber: 1 },
      { id: 'eS2', mediaType: 'season', seasonNumber: 2 },
    ])
    ctx.seedItems([
      { id: 'show', parentId: 'root', path: 'show', type: 'folder', entityId: 'eShow' },
      { id: 's3', parentId: 'show', path: 'show/s3', type: 'folder', entityId: 'eS3' },
      { id: 's1', parentId: 'show', path: 'show/s1', type: 'folder', entityId: 'eS1' },
      { id: 's2', parentId: 'show', path: 'show/s2', type: 'folder', entityId: 'eS2' },
    ])
    mergeSettings('show', { viewSettings: { sortDescending: true } })

    const result = expectItems(await getChildren('show', {}))
    expect(result.map((i) => i.id)).toEqual(['s3', 's2', 's1'])
  })

  it('sortBy is read from the folder own viewSettings, NOT from inheritedSettings', async () => {
    ctx.seedItems([
      { id: 'child', parentId: 'parent', path: 'parent/child', type: 'folder' },
    ])
    ctx.seedEntities([
      { id: 'eA', title: 'Alpha' },
      { id: 'eZ', title: 'Zeta' },
    ])
    ctx.seedItems([
      { id: 'gcA', parentId: 'child', path: 'parent/child/a', type: 'folder', entityId: 'eA' },
      { id: 'gcZ', parentId: 'child', path: 'parent/child/z', type: 'folder', entityId: 'eZ' },
    ])
    // child folder itself has no sortBy — defaults to hybrid (name ASC)
    // Even if caller passes sortBy via inheritedSettings, it must have no effect
    const inheritedWithSortBy: any = { sortBy: 'alpha', sortDescending: true }
    const result = expectItems(await getChildren('child', {}, inheritedWithSortBy))
    // hybrid default → displayName ASC → Alpha before Zeta
    expect(result.map((i) => i.title ?? i.name)).toEqual(['Alpha', 'Zeta'])
  })

  it('sortBy on folder own viewSettings overrides the default regardless of inheritedSettings', async () => {
    ctx.seedItems([
      { id: 'child', parentId: 'parent', path: 'parent/child', type: 'folder' },
    ])
    ctx.seedEntities([
      { id: 'eA', title: 'Alpha' },
      { id: 'eZ', title: 'Zeta' },
    ])
    ctx.seedItems([
      { id: 'gcA', parentId: 'child', path: 'parent/child/a', type: 'folder', entityId: 'eA' },
      { id: 'gcZ', parentId: 'child', path: 'parent/child/z', type: 'folder', entityId: 'eZ' },
    ])
    // child folder itself sets alpha DESC — inheritedSettings passes a conflicting value
    mergeSettings('child', { viewSettings: { sortBy: 'alpha', sortDescending: true } })
    const inheritedWithDifferentSort: any = { sortBy: 'date-added' }
    const result = expectItems(await getChildren('child', {}, inheritedWithDifferentSort))
    // folder's own alpha DESC wins → Zeta before Alpha
    expect(result.map((i) => i.title ?? i.name)).toEqual(['Zeta', 'Alpha'])
  })
})
