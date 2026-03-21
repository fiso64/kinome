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
import { applyGrouping, removeGrouping, syncAllGroupings, syncVirtualSeasonFolders } from './grouping.service'
import { applyVirtualTags } from './virtualTags.service'
import { reapplyVirtualTags } from './library.service'
import { find, getItemById } from './repository.service'
import { createUserVirtualFolder } from './virtualFolders.service'
import { ensureHomeVirtualFolder, HOME_FOLDER_ID } from '../database/repositories/filesystem.repo'
import type { StoredViewSettings, Settings, MediaFolder, LibraryFilter } from '@shared/types'

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
                tv: { layout: 'tabs', clickAction: 'folder' },
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

// =================================================================
// Grouping Write Operations (Domain)
// =================================================================

describe('Grouping Write Operations', () => {
  let ctx: ServiceTestContext

  beforeEach(() => {
    ctx = createServiceTestContext()
  })

  afterEach(() => {
    ctx.cleanup()
  })

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
      expect(uncat.filter!.conditionGroups![0].some(c => c.op === 'isNull')).toBe(true)

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
      ctx.seedFolderSettings([
        { itemId: 'root', folderSettings: { retrieveChildrenMetadata: true } },
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

    it('applyGrouping on a user virtual folder inheriting from home creates grouping subfolders', async () => {
      const vfId = createUserVirtualFolder('root', 'Inherited VF', {
        scope: { parentId: HOME_FOLDER_ID },
        conditionGroups: []
      })

      // The bug: applyGrouping uses compileFilter(folder.filter) without resolveEffectiveFilter
      // which makes it look for items with literal parent_id = 'virtual-home', finding 0 items.
      applyGrouping(vfId, 'mediaType')

      const groupingFolders = find({
        where: { parentId: vfId },
        rawConditions: [`i.virtual_type = 'grouping'`],
      })

      const names = groupingFolders.map((f) => f.name).sort()
      expect(names).toEqual(['movie', 'tv'])
    })

    it('applyGrouping on a virtual folder with scope: full library correctly filters children', () => {
      ctx.seedGenres('e1', ['Action', 'Sci-Fi'])
      ctx.seedGenres('e2', ['Drama'])
      ctx.seedGenres('e3', ['Action'])

      const vfId = createUserVirtualFolder('root', 'All Genres', {
        scope: {},
        conditionGroups: []
      })

      applyGrouping(vfId, 'genre')

      const groupingFolders = find({
        where: { parentId: vfId },
        rawConditions: [`i.virtual_type = 'grouping'`],
      })

      const names = groupingFolders.map((f) => f.name).sort()
      // "Uncategorized" appears because the root folder (seed item) matches the empty filter and has no genres.
      expect(names).toEqual(['Action', 'Drama', 'Sci-Fi', 'Uncategorized'])

      const actionRaw = groupingFolders.find((f) => f.name === 'Action')!
      const action = getItemById(actionRaw.id) as MediaFolder
      const actionChildren = find(compileFilter(action.filter!))

      const actionIds = actionChildren.map((c) => c.id).sort()
      expect(actionIds).toEqual(['film1', 'film2'])
    })
  })

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
})
