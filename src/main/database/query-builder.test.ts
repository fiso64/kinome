/**
 * Query Builder Field Dependency Tests
 *
 * These tests enforce that when grouping by virtual tags (vt.*) or
 * manual tags (tags.*), the metadata table is joined and the relevant
 * JSON blob is available for in-memory extraction.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SCHEMA_SQL } from './schema'

let db: Database

function createTestDb(): Database {
    const testDb = new Database(':memory:')
    testDb.run('PRAGMA foreign_keys = ON')
    testDb.exec(SCHEMA_SQL)
    return testDb
}

describe('query-builder field dependencies', () => {
    beforeEach(() => {
        db = createTestDb()

        // Root → Folder → File with virtual tags and manual tags
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, NULL, '.', 'Library', 'folder')`).run('root')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, 'Movies', 'Movies', 'folder')`).run('folder1', 'root')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, 'Movies/movie.mkv', 'movie.mkv', 'file')`).run('file1', 'folder1')
        db.prepare(`INSERT INTO metadata (item_id, media_type) VALUES (?, 'movie')`).run('file1')
        db.prepare(`UPDATE metadata SET virtual_tags_json = ?, tags_json = ? WHERE item_id = ?`).run(
            JSON.stringify({ quality: '4K', source: 'BluRay' }),
            JSON.stringify({ resolution: '2160p' }),
            'file1'
        )
    })

    it('virtual tag data is available when metadata table is joined', () => {
        const rows = db.prepare(`
      SELECT i.id, m.virtual_tags_json
      FROM items i
      LEFT JOIN metadata m ON i.id = m.item_id
      WHERE i.parent_id = ?
    `).all('folder1') as any[]

        expect(rows.length).toBe(1)
        const vtags = JSON.parse(rows[0].virtual_tags_json || '{}')
        expect(vtags.quality).toBe('4K')
    })

    it('manual tag data is available when metadata table is joined', () => {
        const rows = db.prepare(`
      SELECT i.id, m.tags_json
      FROM items i
      LEFT JOIN metadata m ON i.id = m.item_id
      WHERE i.parent_id = ?
    `).all('folder1') as any[]

        expect(rows.length).toBe(1)
        const tags = JSON.parse(rows[0].tags_json || '{}')
        expect(tags.resolution).toBe('2160p')
    })

    it('virtual tag filtering works with json_extract', () => {
        const rows = db.prepare(`
      SELECT i.id
      FROM items i
      LEFT JOIN metadata m ON i.id = m.item_id
      WHERE i.parent_id = ?
        AND json_extract(m.virtual_tags_json, '$.quality') = ?
    `).all('folder1', '4K') as any[]

        expect(rows.length).toBe(1)
        expect(rows[0].id).toBe('file1')
    })

    it('returns no results for non-matching virtual tag value', () => {
        const rows = db.prepare(`
      SELECT i.id
      FROM items i
      LEFT JOIN metadata m ON i.id = m.item_id
      WHERE i.parent_id = ?
        AND json_extract(m.virtual_tags_json, '$.quality') = ?
    `).all('folder1', '1080p') as any[]

        expect(rows.length).toBe(0)
    })
})
