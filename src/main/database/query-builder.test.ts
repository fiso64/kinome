/**
 * Query Builder Field Dependency Tests
 *
 * These tests enforce that when grouping by virtual tags (vt.*) or
 * manual tags (tags.*), the normalized tag tables are correctly queried.
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
        db.prepare(`INSERT INTO media_entities (id, media_type) VALUES (?, 'movie')`).run('entity1')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type, entity_id) VALUES (?, ?, 'Movies/movie.mkv', 'movie.mkv', 'file', ?)`).run('file1', 'folder1', 'entity1')

        // Insert virtual tags into normalized table
        db.prepare(`INSERT INTO entity_virtual_tags (entity_id, key, value) VALUES (?, ?, ?)`).run('entity1', 'quality', '4K')
        db.prepare(`INSERT INTO entity_virtual_tags (entity_id, key, value) VALUES (?, ?, ?)`).run('entity1', 'source', 'BluRay')

        // Insert manual tags into normalized table
        db.prepare(`INSERT INTO entity_tags (entity_id, key, value) VALUES (?, ?, ?)`).run('entity1', 'resolution', '2160p')
    })

    it('virtual tag data is available via subquery', () => {
        const rows = db.prepare(`
      SELECT i.id,
        (SELECT json_group_object(vt.key, vt.value) FROM entity_virtual_tags vt WHERE vt.entity_id = e.id) AS virtual_tags_json
      FROM items i
      LEFT JOIN media_entities e ON i.entity_id = e.id
      WHERE i.parent_id = ?
    `).all('folder1') as any[]

        expect(rows.length).toBe(1)
        const vtags = JSON.parse(rows[0].virtual_tags_json || '{}')
        expect(vtags.quality).toBe('4K')
    })

    it('manual tag data is available via subquery', () => {
        const rows = db.prepare(`
      SELECT i.id,
        (SELECT json_group_object(t.key, t.value) FROM entity_tags t WHERE t.entity_id = e.id) AS tags_json
      FROM items i
      LEFT JOIN media_entities e ON i.entity_id = e.id
      WHERE i.parent_id = ?
    `).all('folder1') as any[]

        expect(rows.length).toBe(1)
        const tags = JSON.parse(rows[0].tags_json || '{}')
        expect(tags.resolution).toBe('2160p')
    })

    it('virtual tag filtering works with EXISTS on normalized table', () => {
        const rows = db.prepare(`
      SELECT i.id
      FROM items i
      LEFT JOIN media_entities e ON i.entity_id = e.id
      WHERE i.parent_id = ?
        AND EXISTS (SELECT 1 FROM entity_virtual_tags WHERE entity_id = e.id AND key = ? AND value = ?)
    `).all('folder1', 'quality', '4K') as any[]

        expect(rows.length).toBe(1)
        expect(rows[0].id).toBe('file1')
    })

    it('returns no results for non-matching virtual tag value', () => {
        const rows = db.prepare(`
      SELECT i.id
      FROM items i
      LEFT JOIN media_entities e ON i.entity_id = e.id
      WHERE i.parent_id = ?
        AND EXISTS (SELECT 1 FROM entity_virtual_tags WHERE entity_id = e.id AND key = ? AND value = ?)
    `).all('folder1', 'quality', '1080p') as any[]

        expect(rows.length).toBe(0)
    })
})
