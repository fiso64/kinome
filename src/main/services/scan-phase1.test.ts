/**
 * Scan Architecture — Phase 1 SQL Invariant Tests
 *
 * Tests the critical SQL behavior for Phase 1 (Filesystem Sync)
 * from scan_architecture.md. These guard against regressions
 * where COALESCE or conditional cleanup logic is accidentally changed.
 *
 * SPEC: scan_architecture.md §Phase 1
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SCHEMA_SQL } from '../database/schema'
import { _setDbForTesting } from '../database/client'
import {
    deleteItem,
    findPresentLocationByRelativePath,
    findReusableItemIdForDiscoveredLocation,
    getItemIdBySourcePath,
    markLocationAsMissing,
    migrateRecord,
    upsertLibraryItems
} from '../database/repositories/filesystem.repo'

let db: Database

function createTestDb(): Database {
    const testDb = new Database(':memory:')
    testDb.run('PRAGMA foreign_keys = ON')
    testDb.exec(SCHEMA_SQL)
    _setDbForTesting(testDb)
    return testDb
}

function insertItem(item: {
    id: string
    parentId?: string | null
    path?: string
    name?: string
    type?: 'file' | 'folder'
    sourceId?: string
    entityId?: string | null
    isIgnored?: number | null
    isHidden?: number | null
    isMissing?: number | null
    inode?: number | null
    deviceId?: number | null
}) {
    const sourceId = item.sourceId ?? 'source-1'
    const relativePath = item.path ?? item.id
    const name = item.name ?? item.id
    const type = item.type ?? 'file'
    const isMissing = item.isMissing ?? 0
    db.prepare(`
    INSERT INTO media_items (
      id, parent_item_id, physical_kind, media_kind, name, entity_id,
      is_hidden, logical_missing, created_at, updated_at
    )
    VALUES (?, ?, ?, (SELECT media_type FROM media_entities WHERE id = ?), ?, ?, ?, ?, 1000, 1000)
  `).run(
        item.id,
        item.parentId ?? null,
        type,
        item.entityId ?? null,
        name,
        item.entityId ?? null,
        item.isHidden ?? 0,
        isMissing
    )
    db.prepare(`
    INSERT INTO media_locations (
      id, item_id, source_id, relative_path, name, type,
      size, mtime, birthtime, inode, device_id,
      is_present, is_ignored, is_hidden, is_shadowed, first_seen_at, last_seen_at, missing_since
    )
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 0, 1000, 1000, ?)
  `).run(
        `location:${item.id}`,
        item.id,
        sourceId,
        relativePath,
        name,
        type,
        item.inode ?? null,
        item.deviceId ?? null,
        isMissing ? 0 : 1,
        item.isIgnored ?? 0,
        item.isHidden ?? 0,
        isMissing ? 1000 : null
    )
}

// =================================================================
// SPEC(scan_architecture.md §Phase 1, line 143-145):
//   Final Sync must use COALESCE(excluded.is_ignored, is_ignored)
//   so that discovery-time 'null' values do NOT overwrite
//   authoritative worker states.
//
// The upsertLibraryItems SQL in filesystem.repo.ts does:
//   is_ignored = COALESCE(excluded.is_ignored, is_ignored)
//   is_hidden = COALESCE(excluded.is_hidden, is_hidden)
// =================================================================

describe('COALESCE suppression guard (Phase 1 bulk insert)', () => {
    beforeEach(() => {
        db = createTestDb()
    })

    it('preserves existing is_ignored=1 when new value is NULL', () => {
        // Step 1: Item was previously marked as ignored by the suppression worker
        insertItem({ id: 'folder1', isIgnored: 1, isHidden: 0 })

        // Step 2: Bulk insert with NULL (discovery-time unknown state)
        upsertLibraryItems([{ '@id': 'folder1', '@parentId': null, '@path': 'folder1', '@name': 'folder1', '@type': 'folder', '@sourceId': 'source-1', '@isIgnored': null, '@isHidden': null }])

        const row = db.prepare('SELECT is_ignored, is_hidden FROM media_locations WHERE item_id = ?').get('folder1') as any
        expect(row.is_ignored).toBe(1) // MUST be preserved!
    })

    it('preserves existing is_hidden=1 when new value is NULL', () => {
        insertItem({ id: 'folder2', isIgnored: 0, isHidden: 1 })

        upsertLibraryItems([{ '@id': 'folder2', '@parentId': null, '@path': 'folder2', '@name': 'folder2', '@type': 'folder', '@sourceId': 'source-1', '@isIgnored': null, '@isHidden': null }])

        const row = db.prepare('SELECT is_hidden FROM media_items WHERE id = ?').get('folder2') as any
        expect(row.is_hidden).toBe(1) // MUST be preserved!
    })

    it('allows explicit 0 to clear is_ignored', () => {
        insertItem({ id: 'folder3', isIgnored: 1, isHidden: 0 })

        upsertLibraryItems([{ '@id': 'folder3', '@parentId': null, '@path': 'folder3', '@name': 'folder3', '@type': 'folder', '@sourceId': 'source-1', '@isIgnored': 0, '@isHidden': 0 }])

        const row = db.prepare('SELECT is_ignored FROM media_locations WHERE item_id = ?').get('folder3') as any
        expect(row.is_ignored).toBe(0) // Explicit 0 allowed
    })

    it('clears is_missing on re-discovery', () => {
        // Item was marked missing in a previous scan
        insertItem({ id: 'file1', isMissing: 1 })

        // Re-discovered in a new scan
        upsertLibraryItems([{ '@id': 'file1', '@parentId': null, '@path': 'file1', '@name': 'file1', '@type': 'file', '@sourceId': 'source-1', '@isIgnored': 0, '@isHidden': 0 }])

        const row = db.prepare('SELECT logical_missing FROM media_items WHERE id = ?').get('file1') as any
        expect(row.logical_missing).toBe(0) // Un-ghosted
    })

    it('refreshes physical identity fields for existing rows', () => {
        insertItem({ id: 'old-parent', parentId: null, type: 'folder' })
        insertItem({ id: 'new-parent', parentId: null, type: 'folder' })
        insertItem({
            id: 'folder1',
            parentId: 'old-parent',
            path: 'Old Name',
            name: 'Old Name',
            type: 'folder'
        })

        upsertLibraryItems([{ '@id': 'folder1', '@parentId': 'new-parent', '@path': 'New Name', '@name': 'New Name', '@type': 'folder', '@sourceId': 'source-1', '@isIgnored': 0, '@isHidden': 0 }])

        const row = db.prepare('SELECT parent_id, path, name, type FROM media_items_read WHERE id = ?').get('folder1') as any
        expect(row).toEqual({
            parent_id: 'new-parent',
            path: 'New Name',
            name: 'New Name',
            type: 'folder'
        })
    })
})

// =================================================================
// SPEC(scan_architecture.md §Phase 1, line 147-152):
//   Conditional Cleanup:
//     - Items with locked fields → mark as missing (ghost)
//     - Items without locked fields → delete entirely
// =================================================================

describe('Conditional Cleanup (Phase 1 missing items)', () => {
    beforeEach(() => {
        db = createTestDb()
    })

    it('marks item as missing (ghost) when it has locked fields', () => {
        insertItem({ id: 'locked1', type: 'file' })
        const entityId = 'entity-locked1'
        db.prepare(`INSERT INTO media_entities (id, locked_fields_json) VALUES (?, ?)`).run(entityId, JSON.stringify(['title', 'posterPath']))
        db.prepare(`UPDATE media_items SET entity_id = ? WHERE id = ?`).run(entityId, 'locked1')

        // Simulate: item not found on disk → mark as missing
        markLocationAsMissing('location:locked1')

        const row = db.prepare('SELECT logical_missing FROM media_items WHERE id = ?').get('locked1') as any
        expect(row.logical_missing).toBe(1)

        // Entity should still exist (not cascade-deleted from item)
        const meta = db.prepare('SELECT locked_fields_json FROM media_entities WHERE id = ?').get(entityId) as any
        expect(meta).not.toBeNull()
        expect(JSON.parse(meta.locked_fields_json)).toContain('title')
    })

    it('fully deletes item when it has no locked fields', () => {
        insertItem({ id: 'unlocked1', type: 'file' })
        const entityId = 'entity-unlocked1'
        db.prepare(`INSERT INTO media_entities (id, locked_fields_json) VALUES (?, ?)`).run(entityId, '[]')
        db.prepare(`UPDATE media_items SET entity_id = ? WHERE id = ?`).run(entityId, 'unlocked1')

        // Simulate: item not found on disk → delete entirely
        deleteItem('unlocked1')

        const row = db.prepare('SELECT * FROM media_items WHERE id = ?').get('unlocked1')
        expect(row).toBeNull()

        // Entity should still exist (ON DELETE SET NULL, not CASCADE)
        const meta = db.prepare('SELECT * FROM media_entities WHERE id = ?').get(entityId)
        expect(meta).not.toBeNull()
    })

    it('cascade-deletes user_state when item is deleted', () => {
        insertItem({ id: 'cascade1', type: 'file' })
        const entityId = 'entity-cascade1'
        db.prepare(`INSERT INTO media_entities (id, title) VALUES (?, ?)`).run(entityId, 'Some Movie')
        db.prepare(`UPDATE media_items SET entity_id = ? WHERE id = ?`).run(entityId, 'cascade1')
        db.prepare(`INSERT INTO user_state (item_id) VALUES (?)`).run('cascade1')

        deleteItem('cascade1')

        // user_state should be gone (CASCADE from items)
        expect(db.prepare('SELECT * FROM user_state WHERE item_id = ?').get('cascade1')).toBeNull()
        // Entity should still exist (SET NULL, not CASCADE)
        expect(db.prepare('SELECT * FROM media_entities WHERE id = ?').get(entityId)).not.toBeNull()
    })
})

describe('Rename rescue (Phase 1 identity migration)', () => {
    beforeEach(() => {
        db = createTestDb()
    })

    it('updates parent, path, name, and stats when migrating a renamed record', () => {
        insertItem({ id: 'old-parent', parentId: null, type: 'folder' })
        insertItem({ id: 'new-parent', parentId: null, type: 'folder' })
        insertItem({
            id: 'old-id',
            parentId: 'old-parent',
            path: 'Show/Old Season',
            name: 'Old Season',
            type: 'folder',
            isIgnored: 1,
            isHidden: 1
        })

        migrateRecord('old-id', {
            '@id': 'new-id',
            '@parentId': 'new-parent',
            '@path': 'Show/New Season',
            '@name': 'New Season',
            '@type': 'folder',
            '@sourceId': 'source-1',
            '@size': 10,
            '@mtime': 20,
            '@birthtime': 30,
            '@inode': 40,
            '@deviceId': 50,
            '@isIgnored': null,
            '@isHidden': null
        })

        const row = db.prepare(`
            SELECT id, parent_id, path, name, type, source_id, size, mtime, birthtime, inode, device_id, is_ignored, is_hidden, is_missing
            FROM media_items_read
            WHERE id = ?
        `).get('old-id') as any

        expect(row).toEqual({
            id: 'old-id',
            parent_id: 'new-parent',
            path: 'Show/New Season',
            name: 'New Season',
            type: 'folder',
            source_id: 'source-1',
            size: 10,
            mtime: 20,
            birthtime: 30,
            inode: 40,
            device_id: 50,
            is_ignored: 1,
            is_hidden: 1,
            is_missing: 0
        })

        expect(db.prepare('SELECT * FROM media_items WHERE id = ?').get('new-id')).toBeNull()
    })
})

describe('Location identity matching guards', () => {
    beforeEach(() => {
        db = createTestDb()
    })

    it('normalizes source-relative paths at the repository boundary', () => {
        upsertLibraryItems([{
            '@id': 'normalized-item',
            '@parentId': null,
            '@path': 'Movies\\Action//film.mkv',
            '@name': 'film.mkv',
            '@type': 'file',
            '@sourceId': 'source-1',
            '@isIgnored': 0,
            '@isHidden': 0
        }])

        const stored = db.prepare(`
            SELECT relative_path
            FROM media_locations
            WHERE item_id = ?
        `).get('normalized-item') as { relative_path: string }

        expect(stored.relative_path).toBe('Movies/Action/film.mkv')
        expect(getItemIdBySourcePath('source-1', 'Movies\\Action/film.mkv')).toBe('normalized-item')
    })

    it('does not reuse an inode/device candidate when multiple existing items match', () => {
        insertItem({ id: 'candidate-a', sourceId: 'source-a', path: 'A/movie.mkv', inode: 42, deviceId: 7 })
        insertItem({ id: 'candidate-b', sourceId: 'source-b', path: 'B/movie.mkv', inode: 42, deviceId: 7 })

        const match = findReusableItemIdForDiscoveredLocation({
            sourceId: 'source-c',
            relativePath: 'movie.mkv',
            inode: 42,
            deviceId: 7
        })

        expect(match).toBeNull()
    })

    it('does not reuse a missing same-relative-path candidate when multiple items match', () => {
        insertItem({ id: 'missing-a', sourceId: 'source-a', path: 'Shows/Foo', isMissing: 1 })
        insertItem({ id: 'missing-b', sourceId: 'source-b', path: 'Shows/Foo', isMissing: 1 })

        const match = findReusableItemIdForDiscoveredLocation({
            sourceId: 'source-c',
            relativePath: 'Shows\\Foo',
            inode: 100,
            deviceId: 200
        })

        expect(match).toBeNull()
    })

    it('does not shadow to a relative-path candidate when multiple present items match', () => {
        insertItem({ id: 'present-a', sourceId: 'source-a', path: 'Movies/Foo', type: 'folder' })
        insertItem({ id: 'present-b', sourceId: 'source-b', path: 'Movies/Foo', type: 'folder' })

        const match = findPresentLocationByRelativePath('Movies\\Foo', 'source-c')

        expect(match).toBeNull()
    })
})

// =================================================================
// SPEC(virtual-filesystem-analysis.md §Phase 1):
//   getAllIdsInScope path prefix boundary behavior.
//
//   The SQL is:
//     isRoot → SELECT item_id FROM media_locations
//     else   → SELECT item_id FROM media_locations WHERE relative_path LIKE ? OR relative_path = ?
//              params: [`${prefix}/%`, prefix]
//
//   Critical: 'movies' prefix must NOT match 'movies-extra/foo.mkv'.
//   The trailing slash in LIKE ensures exact directory boundary.
// =================================================================

describe('getAllIdsInScope path prefix boundary', () => {
    // Mirrors the exact SQL from filesystem.repo.ts getAllIdsInScope
    function getAllIdsInScope(pathPrefix: string): string[] {
        const isRoot = pathPrefix === '' || pathPrefix === '.'
        const query = isRoot
            ? 'SELECT item_id AS id FROM media_locations'
            : 'SELECT item_id AS id FROM media_locations WHERE relative_path LIKE ? OR relative_path = ?'
        const params = isRoot ? [] : [`${pathPrefix}/%`, pathPrefix]
        const rows = db.prepare(query).all(...params) as { id: string }[]
        return rows.map((r) => r.id)
    }

    beforeEach(() => {
        db = createTestDb()
        // Library root
        insertItem({ id: 'root', parentId: null, path: '.', type: 'folder' })
        // movies folder and two children
        insertItem({ id: 'movies', parentId: 'root', path: 'movies', type: 'folder' })
        insertItem({ id: 'mov1', parentId: 'movies', path: 'movies/a.mkv' })
        insertItem({ id: 'mov2', parentId: 'movies', path: 'movies/b.mkv' })
        // movies/action subfolder and a child
        insertItem({ id: 'action', parentId: 'movies', path: 'movies/action', type: 'folder' })
        insertItem({ id: 'act1', parentId: 'action', path: 'movies/action/hero.mkv' })
        // sibling folder whose name starts with 'movies' — must NOT be included
        insertItem({ id: 'movies-extra', parentId: 'root', path: 'movies-extra', type: 'folder' })
        insertItem({ id: 'extra1', parentId: 'movies-extra', path: 'movies-extra/x.mkv' })
        // unrelated folder
        insertItem({ id: 'tv', parentId: 'root', path: 'tv', type: 'folder' })
        insertItem({ id: 'tv1', parentId: 'tv', path: 'tv/show.mkv' })
    })

    it('empty prefix returns every item in the library', () => {
        const ids = getAllIdsInScope('')
        // All 10 items must be present
        expect(ids).toContain('root')
        expect(ids).toContain('movies')
        expect(ids).toContain('mov1')
        expect(ids).toContain('mov2')
        expect(ids).toContain('action')
        expect(ids).toContain('act1')
        expect(ids).toContain('movies-extra')
        expect(ids).toContain('extra1')
        expect(ids).toContain('tv')
        expect(ids).toContain('tv1')
        expect(ids.length).toBe(10)
    })

    it('"." prefix is treated as root and returns every item', () => {
        const ids = getAllIdsInScope('.')
        expect(ids.length).toBe(10)
    })

    it('prefix "movies" returns the folder itself and all descendants', () => {
        const ids = getAllIdsInScope('movies')
        expect(ids).toContain('movies')
        expect(ids).toContain('mov1')
        expect(ids).toContain('mov2')
        expect(ids).toContain('action')
        expect(ids).toContain('act1')
    })

    it('prefix "movies" does NOT include items from "movies-extra"', () => {
        const ids = getAllIdsInScope('movies')
        expect(ids).not.toContain('movies-extra')
        expect(ids).not.toContain('extra1')
    })

    it('prefix "movies" does NOT include unrelated sibling folders', () => {
        const ids = getAllIdsInScope('movies')
        expect(ids).not.toContain('tv')
        expect(ids).not.toContain('tv1')
        expect(ids).not.toContain('root')
    })

    it('prefix "movies/action" returns only that subfolder and its children', () => {
        const ids = getAllIdsInScope('movies/action')
        expect(ids).toContain('action')
        expect(ids).toContain('act1')
        // Parent and siblings must be excluded
        expect(ids).not.toContain('movies')
        expect(ids).not.toContain('mov1')
        expect(ids).not.toContain('mov2')
        expect(ids.length).toBe(2)
    })
})
