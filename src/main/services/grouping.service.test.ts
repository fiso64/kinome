/**
 * Grouping Service Tests
 *
 * Split into two concerns:
 *
 * A) resolveViewSettings — pure function from @shared/settings-helpers.
 *    Kept from the old test file: these tests are entirely unchanged and
 *    have nothing to do with the deleted grouping engine.
 *
 * B) compileFilter + children branch SQL contracts — new tests for the
 *    DB-driven virtual folder architecture. Use in-memory SQLite directly
 *    (same pattern as query-builder.test.ts and scan-phase1.test.ts).
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SCHEMA_SQL } from '../database/schema'
import { resolveViewSettings } from '@shared/settings-helpers'
import { compileFilter } from '../database/query-builder'
import type { StoredViewSettings, Settings, MediaFolder } from '@shared/types'

// =================================================================
// A) resolveViewSettings — Layout Resolution Sensitivity Matrix
// =================================================================

describe('Layout Resolution Sensitivity Matrix', () => {
    let mockSettings: Settings

    beforeEach(() => {
        mockSettings = {
            defaultLayouts: {
                _default: { layout: 'grid', clickAction: 'detail' },
                movie: { layout: 'grid', clickAction: 'detail', gridPosterSize: 300 },
                tv: { layout: 'tabs', clickAction: 'folder', groupBy: 'folder' },
                season: { layout: 'list', clickAction: 'detail' },
            },
            defaultLayoutSettings: {
                grid: { gridPosterSize: 250 },
                list: { listDescriptionRows: 5 },
                tabs: { tabStyle: 'pills' } as any,
                sections: { sectionStyle: 'default' } as any
            },
            virtualTags: [],
        } as unknown as Settings
    })

    describe('Specificity Cascade', () => {
        it('Scenario 1: Global Default (Lowest Specificity)', () => {
            const item = { id: 'f1', type: 'folder' } as MediaFolder
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.layout).toBe('grid')
            expect(res.gridPosterSize).toBe(250)
        })

        it('Scenario 2: Media-Type Default beats Global', () => {
            const item = { id: 'show1', type: 'folder', mediaType: 'movie' } as MediaFolder
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.layout).toBe('grid')
            expect(res.gridPosterSize).toBe(300)
        })

        it('Scenario 3: Local Item Settings beat Media-Type', () => {
            const item = {
                id: 'show1',
                type: 'folder',
                mediaType: 'movie',
                viewSettings: { layout: 'list', listDescriptionRows: 10 }
            } as unknown as MediaFolder
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.layout).toBe('list')
            expect(res.listDescriptionRows).toBe(10)
        })

        it('Scenario 4: Inherited Context beats Local Item', () => {
            const item = { id: 'f1', type: 'folder', viewSettings: { layout: 'grid' } } as unknown as MediaFolder
            const inherited: StoredViewSettings = { layout: 'sections' }
            const res = resolveViewSettings(item, mockSettings, new Set(), inherited).settings
            expect(res.layout).toBe('sections')
        })

        it('Scenario 5: Direct Override (Highest Specificity) beats Inherited', () => {
            const item = { id: 'child-1' } as MediaFolder
            const inherited: StoredViewSettings = {
                layout: 'sections',
                overrides: { 'child-1': { layout: 'tabs' } }
            }
            const res = resolveViewSettings(item, mockSettings, new Set(), inherited).settings
            expect(res.layout).toBe('tabs')
        })
    })

    describe('Layer Bypassing', () => {
        it('Scenario 6: ignoreLayers - bypasses type-specific, falls back to global', () => {
            const item = { id: 'm1', type: 'folder', mediaType: 'movie' } as MediaFolder
            const res = resolveViewSettings(item, mockSettings, new Set(['movie'])).settings
            expect(res.gridPosterSize).toBe(250)
        })

        it('Scenario 7: ignoreOverrideId - bypasses specific child override', () => {
            const item = { id: 'c1', type: 'folder' } as MediaFolder
            const inherited: StoredViewSettings = {
                layout: 'sections',
                overrides: { 'c1': { layout: 'list' } }
            }
            const res = resolveViewSettings(item, mockSettings, new Set(), inherited, 'c1').settings
            expect(res.layout).toBe('sections')
        })
    })

    describe('Additive Merging of Complex Maps', () => {
        it('merges childViewSettings.overrides across layers', () => {
            const parent = {
                id: 'p1',
                viewSettings: {
                    childViewSettings: { overrides: { 'c1': { layout: 'list' } } }
                }
            } as unknown as MediaFolder

            const inherited: StoredViewSettings = {
                childViewSettings: { overrides: { 'c2': { layout: 'grid' } } }
            }

            const res = resolveViewSettings(parent, mockSettings, new Set(), inherited).settings
            const overrides = res.childViewSettings?.overrides
            expect(overrides?.['c1'].layout).toBe('list')
            expect(overrides?.['c2'].layout).toBe('grid')
        })
    })

    describe('TV Show Defaults (Invariant I3)', () => {
        it('injects season childViewSettings for TV shows', () => {
            const show = { id: 'show1', mediaType: 'tv' } as MediaFolder
            const res = resolveViewSettings(show, mockSettings).settings
            expect(res.childViewSettings?.layout).toBe('list')
        })

        it('preserves existing child overrides while injecting season defaults', () => {
            const show = {
                id: 'show1',
                mediaType: 'tv',
                viewSettings: {
                    childViewSettings: {
                        overrides: { 'spec': { title: 'Special Episode' } }
                    }
                }
            } as unknown as MediaFolder
            const res = resolveViewSettings(show, mockSettings).settings
            expect(res.childViewSettings?.layout).toBe('list')
            expect(res.childViewSettings?.overrides?.['spec'].title).toBe('Special Episode')
        })

        it('does NOT inject season defaults for non-TV folders', () => {
            const folder = { id: 'f1', mediaType: 'movie' } as MediaFolder
            const res = resolveViewSettings(folder, mockSettings).settings
            // movie default is grid — childViewSettings should not have season layout injected
            expect(res.childViewSettings?.layout).toBeUndefined()
        })
    })

    describe('groupBy Resolution', () => {
        it('defaults groupBy to "folder" for tabs layout', () => {
            const item = { id: 'f1', viewSettings: { layout: 'tabs' } } as unknown as MediaFolder
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.groupBy).toBe('folder')
        })

        it('defaults groupBy to "folder" for sections layout', () => {
            const item = { id: 'f1', viewSettings: { layout: 'sections' } } as unknown as MediaFolder
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.groupBy).toBe('folder')
        })

        it('does NOT default groupBy for grid layout', () => {
            const item = { id: 'f1' } as MediaFolder
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.layout).toBe('grid')
            expect(res.groupBy).toBeNull()
        })

        it('explicit groupBy from a layer overrides the default', () => {
            const item = {
                id: 'f1',
                viewSettings: { layout: 'tabs', groupBy: 'year' }
            } as unknown as MediaFolder
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.groupBy).toBe('year')
        })
    })

    describe('Layout-Specific Settings', () => {
        it('pulls gridPosterSize from defaultLayoutSettings when no layer sets it', () => {
            const item = { id: 'f1' } as MediaFolder
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.layout).toBe('grid')
            expect(res.gridPosterSize).toBe(250) // from defaultLayoutSettings.grid
        })

        it('layout-specific settings from a winning layer override defaultLayoutSettings', () => {
            const item = {
                id: 'f1',
                viewSettings: { gridPosterSize: 400 }
            } as unknown as MediaFolder
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.gridPosterSize).toBe(400)
        })

        it('switching layout switches which specific keys are resolved', () => {
            const item = {
                id: 'f1',
                viewSettings: { layout: 'list' }
            } as unknown as MediaFolder
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.layout).toBe('list')
            expect(res.listDescriptionRows).toBe(5) // from defaultLayoutSettings.list
            expect(res.gridPosterSize).toBeUndefined() // grid-specific, not resolved for list
        })
    })

    describe('Null/Missing Settings Fallback', () => {
        it('returns safe defaults when settings is null', () => {
            const item = { id: 'f1' } as MediaFolder
            const res = resolveViewSettings(item, null).settings
            expect(res.layout).toBe('grid')
            expect(res.clickAction).toBe('detail')
        })

        it('respects item viewSettings even when global settings is null', () => {
            const item = {
                id: 'f1',
                viewSettings: { layout: 'list', clickAction: 'navigate' }
            } as unknown as MediaFolder
            const res = resolveViewSettings(item, null).settings
            expect(res.layout).toBe('list')
            expect(res.clickAction).toBe('navigate')
        })

        it('respects inherited settings when global settings is null', () => {
            const item = { id: 'f1' } as MediaFolder
            const inherited: StoredViewSettings = { layout: 'sections' }
            const res = resolveViewSettings(item, null, new Set(), inherited).settings
            expect(res.layout).toBe('sections')
        })
    })

    describe('Invariant I1: Direct View Isolation', () => {
        it('without inherited context, parent styling does not leak', () => {
            // When a user navigates directly to a folder, inheritedSettings is undefined.
            // The folder should show its own settings, not whatever a parent might have set.
            const item = {
                id: 'child1',
                viewSettings: { layout: 'grid' }
            } as unknown as MediaFolder
            // No inherited param → direct navigation
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.layout).toBe('grid')
        })
    })

    describe('Invariant I2: Inline Inheritance', () => {
        it('inherited context overrides local settings (inline/embedded view)', () => {
            const item = {
                id: 'child1',
                viewSettings: { layout: 'grid' }
            } as unknown as MediaFolder
            const inherited: StoredViewSettings = { layout: 'list' }
            const res = resolveViewSettings(item, mockSettings, new Set(), inherited).settings
            expect(res.layout).toBe('list')
        })

        it('same item resolves differently depending on inherited context', () => {
            const item = {
                id: 'child1',
                viewSettings: { layout: 'grid', gridPosterSize: 400 }
            } as unknown as MediaFolder
            // Direct view — no inheritance
            const direct = resolveViewSettings(item, mockSettings).settings
            expect(direct.layout).toBe('grid')

            // Inline view — parent says sections
            const inline = resolveViewSettings(
                item, mockSettings, new Set(),
                { layout: 'sections' }
            ).settings
            expect(inline.layout).toBe('sections')
        })
    })
})

// =================================================================
// B) compileFilter — pure function tests
// =================================================================

describe('compileFilter', () => {
    it('always includes is_virtual = 0 rawCondition', () => {
        const result = compileFilter({})
        expect(result.rawConditions).toContain('i.is_virtual = 0')
    })

    it('maps scope.parentId to where.parentId', () => {
        const result = compileFilter({ scope: { parentId: 'abc' } })
        expect(result.where?.parentId).toBe('abc')
    })

    it('maps eq condition to where entry', () => {
        const result = compileFilter({ conditions: [{ field: 'year', op: 'eq', value: '2024' }] })
        expect(result.where?.year).toBe('2024')
    })

    it('maps non-eq condition to typedWhere', () => {
        const result = compileFilter({ conditions: [{ field: 'year', op: 'gt', value: 2020 }] })
        expect(result.where?.year).toBeUndefined()
        expect(result.typedWhere).toEqual([{ field: 'year', op: 'gt', value: 2020 }])
    })

    it('maps addedDaysAgo lt to typedWhere (no special-casing)', () => {
        const result = compileFilter({ conditions: [{ field: 'addedDaysAgo', op: 'lt', value: 30 }] })
        expect(result.typedWhere).toEqual([{ field: 'addedDaysAgo', op: 'lt', value: 30 }])
        expect(result.rawConditions).toEqual(['i.is_virtual = 0'])
    })

    it('routes vt.* condition to typedWhere', () => {
        const result = compileFilter({ conditions: [{ field: 'vt.is_anime', op: 'eq', value: 'Yes' }] })
        expect(result.typedWhere).toEqual([{ field: 'vt.is_anime', op: 'eq', value: 'Yes' }])
    })

    it('combines scope and multiple conditions correctly', () => {
        const result = compileFilter({
            scope: { parentId: 'movies' },
            conditions: [
                { field: 'year', op: 'eq', value: '2023' },
                { field: 'vt.is_anime', op: 'eq', value: 'Yes' },
                { field: 'addedDaysAgo', op: 'lt', value: 7 }
            ]
        })
        expect(result.where?.parentId).toBe('movies')
        expect(result.where?.year).toBe('2023')
        expect(result.typedWhere).toEqual([
            { field: 'vt.is_anime', op: 'eq', value: 'Yes' },
            { field: 'addedDaysAgo', op: 'lt', value: 7 }
        ])
        expect(result.rawConditions).toContain('i.is_virtual = 0')
    })

    it('empty filter produces only the is_virtual guard', () => {
        const result = compileFilter({})
        expect(result.where).toBeUndefined()
        expect(result.typedWhere).toBeUndefined()
        expect(result.rawConditions).toEqual(['i.is_virtual = 0'])
    })

    it('routes isNull to typedWhere without a value', () => {
        const result = compileFilter({ conditions: [{ field: 'year', op: 'isNull' }] })
        expect(result.typedWhere).toEqual([{ field: 'year', op: 'isNull' }])
        expect(result.where).toBeUndefined()
    })

    it('routes isNotNull to typedWhere without a value', () => {
        const result = compileFilter({ conditions: [{ field: 'vt.is_anime', op: 'isNotNull' }] })
        expect(result.typedWhere).toEqual([{ field: 'vt.is_anime', op: 'isNotNull' }])
    })
})

// =================================================================
// C) Children branch SQL contracts — in-memory SQLite
// =================================================================

let db: Database

function createTestDb(): Database {
    const testDb = new Database(':memory:')
    testDb.run('PRAGMA foreign_keys = ON')
    testDb.exec(SCHEMA_SQL)
    return testDb
}

function insertItem(item: {
    id: string
    parentId?: string | null
    path?: string
    name?: string
    type?: 'file' | 'folder'
    isVirtual?: number
    virtualType?: string | null
}) {
    db.prepare(`
        INSERT INTO items (id, parent_id, path, name, type, is_virtual, virtual_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        item.id,
        item.parentId ?? null,
        item.path ?? item.id,
        item.name ?? item.id,
        item.type ?? 'file',
        item.isVirtual ?? 0,
        item.virtualType ?? null
    )
}

describe('Branch B: appliedGrouping SQL contract', () => {
    beforeEach(() => {
        db = createTestDb()
        insertItem({ id: 'root', parentId: null, path: '.', type: 'folder' })
        insertItem({ id: 'movies', parentId: 'root', path: 'movies', type: 'folder' })

        // Real children — excluded when grouping is active
        insertItem({ id: 'film1', parentId: 'movies', path: 'movies/film1' })
        insertItem({ id: 'film2', parentId: 'movies', path: 'movies/film2' })

        // Grouping virtual folders — included
        insertItem({ id: 'g-2023', parentId: 'movies', path: 'virtual://g-2023', type: 'folder', isVirtual: 1, virtualType: 'grouping' })
        insertItem({ id: 'g-2024', parentId: 'movies', path: 'virtual://g-2024', type: 'folder', isVirtual: 1, virtualType: 'grouping' })

        // User virtual folder — always included
        insertItem({ id: 'u-recent', parentId: 'movies', path: 'virtual://u-recent', type: 'folder', isVirtual: 1, virtualType: 'user' })
    })

    it('returns grouping and user virtual folders, not real children', () => {
        const rows = db.prepare(`
            SELECT id FROM items
            WHERE parent_id = ?
              AND (virtual_type = 'grouping' OR virtual_type = 'user')
        `).all('movies') as any[]

        const ids = rows.map((r) => r.id)
        expect(ids).toContain('g-2023')
        expect(ids).toContain('g-2024')
        expect(ids).toContain('u-recent')
        expect(ids).not.toContain('film1')
        expect(ids).not.toContain('film2')
    })

    it('a season virtual folder appears alongside grouping folders', () => {
        insertItem({ id: 's-1', parentId: 'movies', path: 'virtual://s-1', type: 'folder', isVirtual: 1, virtualType: 'season' })

        // season is NOT grouping or user — excluded by branch B filter
        const rows = db.prepare(`
            SELECT id FROM items
            WHERE parent_id = ?
              AND (virtual_type = 'grouping' OR virtual_type = 'user')
        `).all('movies') as any[]

        const ids = rows.map((r) => r.id)
        expect(ids).not.toContain('s-1')
    })
})

describe('Branch C: no grouping SQL contract', () => {
    beforeEach(() => {
        db = createTestDb()
        insertItem({ id: 'root', parentId: null, path: '.', type: 'folder' })
        insertItem({ id: 'movies', parentId: 'root', path: 'movies', type: 'folder' })

        // Real children — included
        insertItem({ id: 'film1', parentId: 'movies', path: 'movies/film1' })
        insertItem({ id: 'film2', parentId: 'movies', path: 'movies/film2' })

        // Stale grouping virtual folder — excluded
        insertItem({ id: 'g-stale', parentId: 'movies', path: 'virtual://g-stale', type: 'folder', isVirtual: 1, virtualType: 'grouping' })

        // User virtual folder — included
        insertItem({ id: 'u-recent', parentId: 'movies', path: 'virtual://u-recent', type: 'folder', isVirtual: 1, virtualType: 'user' })
    })

    it('returns real children and user virtual folders, excludes grouping virtual folders', () => {
        const rows = db.prepare(`
            SELECT id FROM items
            WHERE parent_id = ?
              AND (is_virtual = 0 OR virtual_type = 'user')
        `).all('movies') as any[]

        const ids = rows.map((r) => r.id)
        expect(ids).toContain('film1')
        expect(ids).toContain('film2')
        expect(ids).toContain('u-recent')
        expect(ids).not.toContain('g-stale')
    })

    it('also excludes season virtual folders (they show via their own parent context)', () => {
        insertItem({ id: 's-1', parentId: 'movies', path: 'virtual://s-1', type: 'folder', isVirtual: 1, virtualType: 'season' })

        const rows = db.prepare(`
            SELECT id FROM items
            WHERE parent_id = ?
              AND (is_virtual = 0 OR virtual_type = 'user')
        `).all('movies') as any[]

        expect(rows.map((r) => r.id)).not.toContain('s-1')
    })
})

describe('Branch A: pool query SQL contract', () => {
    beforeEach(() => {
        db = createTestDb()
        insertItem({ id: 'root', parentId: null, path: '.', type: 'folder' })
        insertItem({ id: 'movies', parentId: 'root', path: 'movies', type: 'folder' })

        db.prepare(`INSERT INTO media_entities (id, year) VALUES (?, ?)`).run('e1', 2023)
        db.prepare(`INSERT INTO media_entities (id, year) VALUES (?, ?)`).run('e2', 2024)

        insertItem({ id: 'film-2023', parentId: 'movies', path: 'movies/film-2023' })
        insertItem({ id: 'film-2024', parentId: 'movies', path: 'movies/film-2024' })
        db.prepare(`UPDATE items SET entity_id = ? WHERE id = ?`).run('e1', 'film-2023')
        db.prepare(`UPDATE items SET entity_id = ? WHERE id = ?`).run('e2', 'film-2024')

        // A virtual item also under movies — pool query must exclude it
        insertItem({ id: 'virt', parentId: 'movies', path: 'virtual://virt', type: 'folder', isVirtual: 1, virtualType: 'grouping' })
    })

    it('filters by parentId scope and year, excludes virtual items', () => {
        const rows = db.prepare(`
            SELECT i.id FROM items i
            LEFT JOIN media_entities e ON i.entity_id = e.id
            WHERE i.parent_id = ?
              AND e.year = ?
              AND i.is_virtual = 0
        `).all('movies', 2023) as any[]

        const ids = rows.map((r) => r.id)
        expect(ids).toContain('film-2023')
        expect(ids).not.toContain('film-2024')
        expect(ids).not.toContain('virt')
    })

    it('pool query without scope covers entire library (no parentId constraint)', () => {
        const rows = db.prepare(`
            SELECT i.id FROM items i
            LEFT JOIN media_entities e ON i.entity_id = e.id
            WHERE e.year = ?
              AND i.is_virtual = 0
        `).all(2024) as any[]

        const ids = rows.map((r) => r.id)
        expect(ids).toContain('film-2024')
        expect(ids).not.toContain('film-2023')
        expect(ids).not.toContain('virt')
    })

    it('is_virtual = 0 guard excludes virtual items even when they match all other filters', () => {
        // Give the virtual item a matching entity
        db.prepare(`INSERT INTO media_entities (id, year) VALUES (?, ?)`).run('ev', 2023)
        db.prepare(`UPDATE items SET entity_id = ? WHERE id = ?`).run('ev', 'virt')

        const rows = db.prepare(`
            SELECT i.id FROM items i
            LEFT JOIN media_entities e ON i.entity_id = e.id
            WHERE i.parent_id = ?
              AND e.year = ?
              AND i.is_virtual = 0
        `).all('movies', 2023) as any[]

        expect(rows.map((r) => r.id)).not.toContain('virt')
    })
})
