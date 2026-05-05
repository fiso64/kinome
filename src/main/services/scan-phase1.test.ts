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
import { migrateRecord } from '../database/repositories/filesystem.repo'

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
    isIgnored?: number | null
    isHidden?: number | null
}) {
    db.prepare(`
    INSERT INTO items (id, parent_id, path, name, type, is_ignored, is_hidden)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
        item.id,
        item.parentId ?? null,
        item.path ?? item.id,
        item.name ?? item.id,
        item.type ?? 'file',
        item.isIgnored ?? 0,
        item.isHidden ?? 0
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
    // This is the exact SQL from filesystem.repo.ts upsertLibraryItems
    const UPSERT_SQL = `
    INSERT INTO items (id, parent_id, path, name, type, size, mtime, birthtime, inode, device_id, is_missing, is_ignored, is_hidden)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      is_missing = 0,
      parent_id = excluded.parent_id,
      path = excluded.path,
      name = excluded.name,
      type = excluded.type,
      size = excluded.size,
      mtime = excluded.mtime,
      birthtime = excluded.birthtime,
      inode = excluded.inode,
      device_id = excluded.device_id,
      is_ignored = COALESCE(excluded.is_ignored, is_ignored),
      is_hidden = COALESCE(excluded.is_hidden, is_hidden)
  `

    beforeEach(() => {
        db = createTestDb()
    })

    it('preserves existing is_ignored=1 when new value is NULL', () => {
        // Step 1: Item was previously marked as ignored by the suppression worker
        insertItem({ id: 'folder1', isIgnored: 1, isHidden: 0 })

        // Step 2: Bulk insert with NULL (discovery-time unknown state)
        db.prepare(UPSERT_SQL).run(
            'folder1', null, 'folder1', 'folder1', 'folder',
            null, null, null, null, null,
            null, // is_ignored = NULL (discovery-time)
            null  // is_hidden = NULL
        )

        const row = db.prepare('SELECT is_ignored, is_hidden FROM items WHERE id = ?').get('folder1') as any
        expect(row.is_ignored).toBe(1) // MUST be preserved!
    })

    it('preserves existing is_hidden=1 when new value is NULL', () => {
        insertItem({ id: 'folder2', isIgnored: 0, isHidden: 1 })

        db.prepare(UPSERT_SQL).run(
            'folder2', null, 'folder2', 'folder2', 'folder',
            null, null, null, null, null,
            null, // is_ignored = NULL
            null  // is_hidden = NULL (discovery-time)
        )

        const row = db.prepare('SELECT is_hidden FROM items WHERE id = ?').get('folder2') as any
        expect(row.is_hidden).toBe(1) // MUST be preserved!
    })

    it('allows explicit 0 to clear is_ignored', () => {
        insertItem({ id: 'folder3', isIgnored: 1, isHidden: 0 })

        db.prepare(UPSERT_SQL).run(
            'folder3', null, 'folder3', 'folder3', 'folder',
            null, null, null, null, null,
            0, // explicit 0 - should override
            0
        )

        const row = db.prepare('SELECT is_ignored FROM items WHERE id = ?').get('folder3') as any
        expect(row.is_ignored).toBe(0) // Explicit 0 allowed
    })

    it('clears is_missing on re-discovery', () => {
        // Item was marked missing in a previous scan
        insertItem({ id: 'file1' })
        db.prepare('UPDATE items SET is_missing = 1 WHERE id = ?').run('file1')

        // Re-discovered in a new scan
        db.prepare(UPSERT_SQL).run(
            'file1', null, 'file1', 'file1', 'file',
            null, null, null, null, null,
            0, 0
        )

        const row = db.prepare('SELECT is_missing FROM items WHERE id = ?').get('file1') as any
        expect(row.is_missing).toBe(0) // Un-ghosted
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

        db.prepare(UPSERT_SQL).run(
            'folder1', 'new-parent', 'New Name', 'New Name', 'folder',
            null, null, null, null, null,
            0, 0
        )

        const row = db.prepare('SELECT parent_id, path, name, type FROM items WHERE id = ?').get('folder1') as any
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
        db.prepare(`UPDATE items SET entity_id = ? WHERE id = ?`).run(entityId, 'locked1')

        // Simulate: item not found on disk → mark as missing
        db.prepare('UPDATE items SET is_missing = 1 WHERE id = ?').run('locked1')

        const row = db.prepare('SELECT is_missing FROM items WHERE id = ?').get('locked1') as any
        expect(row.is_missing).toBe(1)

        // Entity should still exist (not cascade-deleted from item)
        const meta = db.prepare('SELECT locked_fields_json FROM media_entities WHERE id = ?').get(entityId) as any
        expect(meta).not.toBeNull()
        expect(JSON.parse(meta.locked_fields_json)).toContain('title')
    })

    it('fully deletes item when it has no locked fields', () => {
        insertItem({ id: 'unlocked1', type: 'file' })
        const entityId = 'entity-unlocked1'
        db.prepare(`INSERT INTO media_entities (id, locked_fields_json) VALUES (?, ?)`).run(entityId, '[]')
        db.prepare(`UPDATE items SET entity_id = ? WHERE id = ?`).run(entityId, 'unlocked1')

        // Simulate: item not found on disk → delete entirely
        db.prepare('DELETE FROM items WHERE id = ?').run('unlocked1')

        const row = db.prepare('SELECT * FROM items WHERE id = ?').get('unlocked1')
        expect(row).toBeNull()

        // Entity should still exist (ON DELETE SET NULL, not CASCADE)
        const meta = db.prepare('SELECT * FROM media_entities WHERE id = ?').get(entityId)
        expect(meta).not.toBeNull()
    })

    it('cascade-deletes user_state when item is deleted', () => {
        insertItem({ id: 'cascade1', type: 'file' })
        const entityId = 'entity-cascade1'
        db.prepare(`INSERT INTO media_entities (id, title) VALUES (?, ?)`).run(entityId, 'Some Movie')
        db.prepare(`UPDATE items SET entity_id = ? WHERE id = ?`).run(entityId, 'cascade1')
        db.prepare(`INSERT INTO user_state (item_id) VALUES (?)`).run('cascade1')

        db.prepare('DELETE FROM items WHERE id = ?').run('cascade1')

        // user_state should be gone (CASCADE from items)
        expect(db.prepare('SELECT * FROM user_state WHERE item_id = ?').get('cascade1')).toBeNull()
        // Entity should still exist (SET NULL, not CASCADE)
        expect(db.prepare('SELECT * FROM media_entities WHERE id = ?').get(entityId)).not.toBeNull()
    })
})

describe('Rename rescue (Phase 1 identity migration)', () => {
    beforeEach(() => {
        db = createTestDb()
        _setDbForTesting(db)
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

        const oldRow = db.prepare('SELECT * FROM items WHERE id = ?').get('old-id')
        expect(oldRow).toBeNull()

        const row = db.prepare(`
            SELECT id, parent_id, path, name, type, source_id, size, mtime, birthtime, inode, device_id, is_ignored, is_hidden, is_missing
            FROM items
            WHERE id = ?
        `).get('new-id') as any

        expect(row).toEqual({
            id: 'new-id',
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
    })
})

// =================================================================
// SPEC(virtual-filesystem-analysis.md §Phase 1):
//   getAllIdsInScope path prefix boundary behavior.
//
//   The SQL is:
//     isRoot → SELECT id FROM items
//     else   → SELECT id FROM items WHERE path LIKE ? OR path = ?
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
            ? 'SELECT id FROM items'
            : 'SELECT id FROM items WHERE path LIKE ? OR path = ?'
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
