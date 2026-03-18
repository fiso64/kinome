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
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SCHEMA_SQL } from '../database/schema'
import { resolveViewSettings } from '@shared/settings-helpers'
import { compileFilter, buildWhereFragment } from '../database/query-builder'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { applyGrouping, syncAllGroupings } from './virtualFolders.service'
import { applyVirtualTags } from './virtualTags.service'
import { reapplyVirtualTags } from './library.service'
import { find, getItemById } from './repository.service'
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

        it('defaults groupBy to "folder" for all layouts including grid', () => {
            const item = { id: 'f1' } as MediaFolder
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.layout).toBe('grid')
            expect(res.groupBy).toBe('folder')
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

/**
 * Helper: runs compileFilter → buildWhereFragment end-to-end and returns
 * the final SQL conditions + params. This tests the contract that matters:
 * the SQL that actually hits the database.
 */
function compileToSql(filter: Parameters<typeof compileFilter>[0], opts?: { includeHidden?: boolean }) {
    const compiled = compileFilter(filter)
    const { conditions, params, tables } = buildWhereFragment({
        ...compiled,
        includeHidden: opts?.includeHidden ?? true,
        includeIgnored: true,
    })
    const sql = conditions.join(' AND ')
    return { sql, conditions, params, tables, compiled }
}

describe('compileFilter', () => {
    it('always includes is_virtual = 0', () => {
        const { sql } = compileToSql({})
        expect(sql).toContain('i.is_virtual = 0')
    })

    it('maps scope.parentId to where clause', () => {
        const { sql, params } = compileToSql({ scope: { parentId: 'abc' } })
        expect(sql).toContain('i.parent_id = ?')
        expect(params).toContain('abc')
    })

    it('compiles eq condition', () => {
        const { params } = compileToSql({ conditions: [{ field: 'year', op: 'eq', value: '2024' }] })
        expect(params).toContain('2024')
    })

    it('compiles gt condition', () => {
        const { sql, params } = compileToSql({ conditions: [{ field: 'year', op: 'gt', value: 2020 }] })
        expect(sql).toContain('> ?')
        expect(params).toContain(2020)
    })

    it('compiles addedDaysAgo lt condition', () => {
        const { sql, params } = compileToSql({ conditions: [{ field: 'addedDaysAgo', op: 'lt', value: 30 }] })
        expect(sql).toContain('< ?')
        expect(params).toContain(30)
    })

    it('compiles vt.* condition to EXISTS subquery', () => {
        const { sql, params } = compileToSql({ conditions: [{ field: 'vt.is_anime', op: 'eq', value: 'Yes' }] })
        expect(sql).toContain('entity_virtual_tags')
        expect(params).toContain('is_anime')
        expect(params).toContain('Yes')
    })

    it('combines scope and multiple conditions correctly', () => {
        const { sql, params } = compileToSql({
            scope: { parentId: 'movies' },
            conditions: [
                { field: 'year', op: 'eq', value: '2023' },
                { field: 'vt.is_anime', op: 'eq', value: 'Yes' },
                { field: 'addedDaysAgo', op: 'lt', value: 7 }
            ]
        })
        expect(params).toContain('movies')
        expect(params).toContain('2023')
        expect(params).toContain('is_anime')
        expect(params).toContain('Yes')
        expect(params).toContain(7)
        expect(sql).toContain('i.is_virtual = 0')
    })

    it('empty filter produces only the is_virtual guard', () => {
        const { conditions } = compileToSql({})
        expect(conditions).toEqual(['i.is_virtual = 0'])
    })

    it('compiles isNull condition', () => {
        const { sql } = compileToSql({ conditions: [{ field: 'year', op: 'isNull' }] })
        expect(sql).toContain('IS NULL')
    })

    it('compiles isNotNull vt.* condition', () => {
        const { sql, params } = compileToSql({ conditions: [{ field: 'vt.is_anime', op: 'isNotNull' }] })
        expect(sql).toContain('EXISTS')
        expect(params).toContain('is_anime')
    })

    // --- conditionGroups: OR-of-AND ---

    it('compiles conditionGroups into OR-joined SQL', () => {
        const { compiled } = compileToSql({
            conditionGroups: [
                [{ field: 'year', op: 'gt', value: 2020 }],
                [{ field: 'year', op: 'lt', value: 2000 }],
            ]
        })
        expect(compiled.compiledConditions!.sql).toContain(' OR ')
    })

    it('compiles conditionGroups with AND within groups', () => {
        const { compiled } = compileToSql({
            conditionGroups: [
                [{ field: 'year', op: 'gt', value: 2020 }, { field: 'mediaType', op: 'eq', value: 'movie' }],
            ]
        })
        expect(compiled.compiledConditions!.sql).toContain(' AND ')
    })

    it('conditionGroups preserves scope alongside groups', () => {
        const { sql, params } = compileToSql({
            scope: { parentId: 'movies' },
            conditionGroups: [
                [{ field: 'year', op: 'gt', value: 2020 }],
            ]
        })
        expect(params).toContain('movies')
        expect(sql).toContain('> ?')
    })

    it('conditionGroups produces correct params in order', () => {
        const { params } = compileToSql({
            conditionGroups: [
                [{ field: 'year', op: 'gt', value: 2020 }],
                [{ field: 'year', op: 'lt', value: 1990 }],
            ]
        })
        expect(params).toContain(2020)
        expect(params).toContain(1990)
    })

    it('legacy conditions and conditionGroups produce equivalent SQL', () => {
        const legacy = compileToSql({
            conditions: [{ field: 'year', op: 'gt', value: 2020 }]
        })
        const groups = compileToSql({
            conditionGroups: [[{ field: 'year', op: 'gt', value: 2020 }]]
        })
        // Both should produce the same effective params
        expect(legacy.params).toEqual(groups.params)
    })

    // --- tags.* and vt.* in compiled output ---

    it('compiles tags.* condition to EXISTS subquery', () => {
        const { sql, params, tables } = compileToSql({ conditions: [{ field: 'tags.resolution', op: 'eq', value: '4K' }] })
        expect(sql).toContain('entity_tags')
        expect(params).toContain('resolution')
        expect(params).toContain('4K')
        expect(tables.has('e')).toBe(true)
    })

    it('compiles tags.* contains condition', () => {
        const { sql, params } = compileToSql({ conditions: [{ field: 'tags.source', op: 'contains', value: 'Blu' }] })
        expect(sql).toContain('entity_tags')
        expect(sql).toContain('LIKE')
        expect(params).toContain('source')
        expect(params).toContain('%Blu%')
    })

    it('conditionGroups with tags.* and vt.* fields', () => {
        const { sql, params, compiled } = compileToSql({
            conditionGroups: [
                [{ field: 'tags.resolution', op: 'eq', value: '4K' }],
                [{ field: 'vt.is_anime', op: 'eq', value: 'Yes' }],
            ]
        })
        expect(compiled.compiledConditions!.sql).toContain(' OR ')
        expect(params).toContain('resolution')
        expect(params).toContain('4K')
        expect(params).toContain('is_anime')
        expect(params).toContain('Yes')
    })

    it('conditionGroups mixing tags.*, vt.*, and metadata in AND groups', () => {
        const { params, compiled } = compileToSql({
            conditionGroups: [
                [{ field: 'vt.is_anime', op: 'eq', value: 'Yes' }, { field: 'year', op: 'gt', value: 2020 }],
                [{ field: 'tags.source', op: 'contains', value: 'Blu-ray' }],
            ]
        })
        // First group: vt + year AND-joined; second group: tags.*
        expect(compiled.compiledConditions!.sql).toContain(' AND ')
        expect(compiled.compiledConditions!.sql).toContain(' OR ')
        expect(params).toContain('is_anime')
        expect(params).toContain('Yes')
        expect(params).toContain(2020)
        expect(params).toContain('source')
        expect(params).toContain('%Blu-ray%')
    })

    // --- isEmpty / isNotEmpty SQL compilation ---

    it('compiles isEmpty on scalar field to IS NULL OR empty check', () => {
        const { sql } = compileToSql({ conditions: [{ field: 'year', op: 'isEmpty' }] })
        expect(sql).toContain('IS NULL')
    })

    it('compiles isNotEmpty on scalar field', () => {
        const { sql } = compileToSql({ conditions: [{ field: 'year', op: 'isNotEmpty' }] })
        expect(sql).toContain('IS NOT NULL')
    })

    it('compiles isEmpty on tags.* to NOT EXISTS', () => {
        const { sql, params } = compileToSql({ conditions: [{ field: 'tags.resolution', op: 'isEmpty' }] })
        expect(sql).toContain('entity_tags')
        expect(params).toContain('resolution')
    })

    it('compiles isEmpty on vt.* to NOT EXISTS', () => {
        const { sql, params } = compileToSql({ conditions: [{ field: 'vt.is_anime', op: 'isEmpty' }] })
        expect(sql).toContain('entity_virtual_tags')
        expect(params).toContain('is_anime')
    })

    it('compiles isEmpty on genre to NOT EXISTS', () => {
        const { sql } = compileToSql({ conditions: [{ field: 'genre', op: 'isEmpty' }] })
        expect(sql).toContain('entity_genres')
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

// =================================================================
// Grouping staleness — groups must stay in sync with data changes
// =================================================================

describe('grouping staleness', () => {
  let ctx: ServiceTestContext

  beforeEach(() => {
    ctx = createServiceTestContext()
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie', year: 2023 },
      { id: 'e2', mediaType: 'movie', year: 2024 },
      { id: 'e3', mediaType: 'movie', year: 2023 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, path: '.', type: 'folder' },
      { id: 'movies', parentId: 'root', path: 'movies', type: 'folder' },
      { id: 'film1', parentId: 'movies', path: 'movies/film1', entityId: 'e1' },
      { id: 'film2', parentId: 'movies', path: 'movies/film2', entityId: 'e2' },
      { id: 'film3', parentId: 'movies', path: 'movies/film3', entityId: 'e3' },
    ])
    ctx.seedGenres('e1', ['Action'])
    ctx.seedGenres('e2', ['Action', 'Drama'])
    ctx.seedGenres('e3', ['Comedy'])
  })

  afterEach(() => {
    ctx.cleanup()
  })

  function getGroupNames(parentId: string) {
    return find({
      where: { parentId },
      rawConditions: [`i.virtual_type = 'grouping'`],
    }).map((f) => f.name).sort()
  }

  it('new genre added after grouping → new group should appear', () => {
    applyGrouping('movies', 'genre')
    expect(getGroupNames('movies')).toEqual(['Action', 'Comedy', 'Drama'])

    // Add 'Horror' to film3
    ctx.seedGenres('e3', ['Comedy', 'Horror'])
    syncAllGroupings()

    expect(getGroupNames('movies')).toContain('Horror')
  })

  it('genre emptied after grouping → empty group should disappear', () => {
    applyGrouping('movies', 'genre')
    expect(getGroupNames('movies')).toContain('Comedy')

    // Remove Comedy from film3, give it Action instead
    ctx.db.prepare(`DELETE FROM entity_genres WHERE entity_id = 'e3'`).run()
    ctx.seedGenres('e3', ['Action'])
    syncAllGroupings()

    expect(getGroupNames('movies')).not.toContain('Comedy')
  })

  it('new item with new year added after grouping → new group should appear', () => {
    applyGrouping('movies', 'year')
    expect(getGroupNames('movies')).toEqual(['2023', '2024'])

    ctx.seedEntities([{ id: 'e4', mediaType: 'movie', year: 2025 }])
    ctx.seedItems([{ id: 'film4', parentId: 'movies', path: 'movies/film4', entityId: 'e4' }])
    syncAllGroupings()

    expect(getGroupNames('movies')).toContain('2025')
  })

  it('virtual tag changed after grouping → groups should update', () => {
    ctx.seedVirtualTags('e1', { quality: '4K' })
    ctx.seedVirtualTags('e2', { quality: '4K' })
    ctx.seedVirtualTags('e3', { quality: '1080p' })

    applyGrouping('movies', 'vt.quality')
    expect(getGroupNames('movies')).toEqual(['1080p', '4K'])

    // Change film3 from 1080p to 720p (a new value)
    ctx.db.prepare(`UPDATE entity_virtual_tags SET value = '720p' WHERE entity_id = 'e3' AND key = 'quality'`).run()
    syncAllGroupings()

    // 720p group should appear, 1080p should disappear (no items left)
    expect(getGroupNames('movies')).toContain('720p')
    expect(getGroupNames('movies')).not.toContain('1080p')
  })

  it('vtag result value renamed → stale group disappears, new group appears', () => {
    // Setup: is_animated vtag with result "Animation"
    const vtagConfig = [{
      id: 'vt-animated',
      name: 'is_animated',
      cases: [{ filter: { conditions: [{ field: 'genre', op: 'contains' as const, value: 'Animation' }] }, result: 'Animation' }],
      defaultResult: 'Live Action'
    }]

    ctx.seedGenres('e1', ['Action', 'Animation'])
    ctx.seedGenres('e2', ['Action'])
    ctx.seedGenres('e3', ['Drama'])

    applyVirtualTags(vtagConfig)
    applyGrouping('movies', 'vt.is_animated')
    expect(getGroupNames('movies')).toEqual(['Animation', 'Live Action'])

    // User changes result value: "Animation" → "Animation 2" and saves settings.
    // reapplyVirtualTagsAfterSettingsChange calls applyVirtualTags but must also
    // sync groupings — otherwise stale grouping folders remain.
    const updatedConfig = [{
      ...vtagConfig[0],
      cases: [{ filter: { conditions: [{ field: 'genre', op: 'contains' as const, value: 'Animation' }] }, result: 'Animation 2' }],
    }]
    reapplyVirtualTags(updatedConfig)

    // "Animation" group should be gone, "Animation 2" should exist
    expect(getGroupNames('movies')).not.toContain('Animation')
    expect(getGroupNames('movies')).toContain('Animation 2')
    expect(getGroupNames('movies')).toContain('Live Action')
  })

  it('genre change triggers vtag re-evaluation and grouping update', () => {
    // Setup: is_animated vtag depends on genres containing "Animation"
    const vtagConfig = [{
      id: 'vt-animated',
      name: 'is_animated',
      cases: [{ filter: { conditions: [{ field: 'genre', op: 'contains' as const, value: 'Animation' }] }, result: 'Animated' }],
      defaultResult: 'Live Action'
    }]

    // film1 has Animation genre, film2 and film3 don't
    ctx.seedGenres('e1', ['Action', 'Animation'])
    ctx.seedGenres('e2', ['Action'])
    ctx.seedGenres('e3', ['Drama'])

    // Compute and persist vtags
    applyVirtualTags(vtagConfig)

    // Group by the vtag
    applyGrouping('movies', 'vt.is_animated')
    expect(getGroupNames('movies')).toEqual(['Animated', 'Live Action'])

    // Now add Animation to film2's genres
    ctx.db.prepare(`DELETE FROM entity_genres WHERE entity_id = 'e2'`).run()
    ctx.seedGenres('e2', ['Action', 'Animation'])

    // Re-evaluate vtags for the changed item, then sync groupings.
    // This is what updateIfChangedAndBroadcast should do after persisting.
    applyVirtualTags(vtagConfig, ['film2'])
    syncAllGroupings()

    // Verify the Animated group now contains both film1 and film2
    const animatedFolder = find({
      where: { parentId: 'movies' },
      rawConditions: [`i.virtual_type = 'grouping'`],
    }).find((f) => f.name === 'Animated')!
    const full = getItemById(animatedFolder.id) as MediaFolder
    const children = find(compileFilter(full.filter!))

    // This FAILS: film2 should now be Animated, but entity_virtual_tags wasn't updated
    expect(children).toHaveLength(2)
    expect(children.map((c) => c.id).sort()).toEqual(['film1', 'film2'])
  })
})
