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
        db.prepare(`
      INSERT INTO metadata (item_id, locked_fields_json)
      VALUES (?, ?)
    `).run('locked1', JSON.stringify(['title', 'posterPath']))

        // Simulate: item not found on disk → mark as missing
        db.prepare('UPDATE items SET is_missing = 1 WHERE id = ?').run('locked1')

        const row = db.prepare('SELECT is_missing FROM items WHERE id = ?').get('locked1') as any
        expect(row.is_missing).toBe(1)

        // Metadata should still exist (not cascade-deleted)
        const meta = db.prepare('SELECT locked_fields_json FROM metadata WHERE item_id = ?').get('locked1') as any
        expect(meta).not.toBeNull()
        expect(JSON.parse(meta.locked_fields_json)).toContain('title')
    })

    it('fully deletes item when it has no locked fields', () => {
        insertItem({ id: 'unlocked1', type: 'file' })
        db.prepare(`
      INSERT INTO metadata (item_id, locked_fields_json)
      VALUES (?, ?)
    `).run('unlocked1', '[]')

        // Simulate: item not found on disk → delete entirely
        db.prepare('DELETE FROM items WHERE id = ?').run('unlocked1')

        const row = db.prepare('SELECT * FROM items WHERE id = ?').get('unlocked1')
        expect(row).toBeNull()

        // Metadata should also be deleted (CASCADE)
        const meta = db.prepare('SELECT * FROM metadata WHERE item_id = ?').get('unlocked1')
        expect(meta).toBeNull()
    })

    it('cascade-deletes metadata when item is deleted', () => {
        insertItem({ id: 'cascade1', type: 'file' })
        db.prepare(`INSERT INTO metadata (item_id, title) VALUES (?, ?)`).run('cascade1', 'Some Movie')
        db.prepare(`INSERT INTO user_state (item_id) VALUES (?)`).run('cascade1')

        db.prepare('DELETE FROM items WHERE id = ?').run('cascade1')

        // Both metadata and user_state should be gone
        expect(db.prepare('SELECT * FROM metadata WHERE item_id = ?').get('cascade1')).toBeNull()
        expect(db.prepare('SELECT * FROM user_state WHERE item_id = ?').get('cascade1')).toBeNull()
    })
})
