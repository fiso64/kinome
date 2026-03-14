/**
 * Query Builder Field Dependency Tests
 *
 * These tests enforce that when grouping by virtual tags (vt.*) or
 * manual tags (tags.*), the normalized tag tables are correctly queried.
 *
 * Also covers core filtering, ordering, and pagination behavior that the
 * children endpoint and find() path rely on.
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

// =================================================================
// Core filtering: parentId, is_hidden, is_ignored, null equality
// =================================================================

describe('query-builder core filters', () => {
    beforeEach(() => {
        db = createTestDb()
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, NULL, '.', 'Library', 'folder')`).run('root')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, 'Movies', 'Movies', 'folder')`).run('movies', 'root')
    })

    it('parentId filter returns only direct children of the specified folder', () => {
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, ?, ?, 'file')`).run('child1', 'movies', 'Movies/a.mkv', 'a.mkv')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, ?, ?, 'file')`).run('child2', 'movies', 'Movies/b.mkv', 'b.mkv')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, ?, ?, 'file')`).run('other', 'root', 'other.mkv', 'other.mkv')

        const rows = db.prepare(`SELECT id FROM items WHERE parent_id = ?`).all('movies') as any[]
        const ids = rows.map((r) => r.id)

        expect(ids).toContain('child1')
        expect(ids).toContain('child2')
        expect(ids).not.toContain('other')
        expect(ids).not.toContain('root')
    })

    it('is_hidden=1 items are excluded by an explicit filter', () => {
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type, is_hidden) VALUES (?, ?, ?, ?, 'file', 0)`).run('visible', 'movies', 'Movies/vis.mkv', 'vis.mkv')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type, is_hidden) VALUES (?, ?, ?, ?, 'file', 1)`).run('hidden', 'movies', 'Movies/hid.mkv', 'hid.mkv')

        const rows = db.prepare(`SELECT id FROM items WHERE parent_id = ? AND is_hidden = 0`).all('movies') as any[]
        const ids = rows.map((r) => r.id)

        expect(ids).toContain('visible')
        expect(ids).not.toContain('hidden')
    })

    it('is_ignored=1 items are excluded by an explicit filter', () => {
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type, is_ignored) VALUES (?, ?, ?, ?, 'file', 0)`).run('normal', 'movies', 'Movies/norm.mkv', 'norm.mkv')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type, is_ignored) VALUES (?, ?, ?, ?, 'file', 1)`).run('ignored', 'movies', 'Movies/ign.mkv', 'ign.mkv')

        const rows = db.prepare(`SELECT id FROM items WHERE parent_id = ? AND is_ignored = 0`).all('movies') as any[]
        const ids = rows.map((r) => r.id)

        expect(ids).toContain('normal')
        expect(ids).not.toContain('ignored')
    })

    it('NULL field equality uses IS NULL, not = NULL', () => {
        // Items with and without a season number
        db.prepare(`INSERT INTO media_entities (id, season_number) VALUES (?, NULL)`).run('e1')
        db.prepare(`INSERT INTO media_entities (id, season_number) VALUES (?, 1)`).run('e2')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type, entity_id) VALUES (?, ?, ?, ?, 'file', ?)`).run('ep-no-season', 'movies', 'Movies/ep0.mkv', 'ep0.mkv', 'e1')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type, entity_id) VALUES (?, ?, ?, ?, 'file', ?)`).run('ep-s1', 'movies', 'Movies/ep1.mkv', 'ep1.mkv', 'e2')

        // `= NULL` is always false in SQL; IS NULL is required
        const wrongRows = db.prepare(`
            SELECT i.id FROM items i
            LEFT JOIN media_entities e ON i.entity_id = e.id
            WHERE i.parent_id = ? AND e.season_number = NULL
        `).all('movies') as any[]
        expect(wrongRows.length).toBe(0) // confirms = NULL never matches

        const correctRows = db.prepare(`
            SELECT i.id FROM items i
            LEFT JOIN media_entities e ON i.entity_id = e.id
            WHERE i.parent_id = ? AND e.season_number IS NULL
        `).all('movies') as any[]
        expect(correctRows.length).toBe(1)
        expect(correctRows[0].id).toBe('ep-no-season')
    })
})

// =================================================================
// Genre filter: multi-value via EXISTS on entity_genres
// =================================================================

describe('query-builder genre filter', () => {
    beforeEach(() => {
        db = createTestDb()
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, NULL, '.', 'Library', 'folder')`).run('root')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, 'Movies', 'Movies', 'folder')`).run('movies', 'root')

        db.prepare(`INSERT INTO media_entities (id) VALUES (?)`).run('e-action')
        db.prepare(`INSERT INTO media_entities (id) VALUES (?)`).run('e-drama')
        db.prepare(`INSERT INTO media_entities (id) VALUES (?)`).run('e-both')

        db.prepare(`INSERT INTO items (id, parent_id, path, name, type, entity_id) VALUES (?, ?, ?, ?, 'file', ?)`).run('action-film', 'movies', 'Movies/ac.mkv', 'ac.mkv', 'e-action')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type, entity_id) VALUES (?, ?, ?, ?, 'file', ?)`).run('drama-film', 'movies', 'Movies/dr.mkv', 'dr.mkv', 'e-drama')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type, entity_id) VALUES (?, ?, ?, ?, 'file', ?)`).run('both-film', 'movies', 'Movies/bo.mkv', 'bo.mkv', 'e-both')

        // genres are normalized: text → genres table, join via entity_genres
        db.prepare(`INSERT INTO genres (id, name) VALUES (?, ?)`).run(1, 'Action')
        db.prepare(`INSERT INTO genres (id, name) VALUES (?, ?)`).run(2, 'Drama')
        db.prepare(`INSERT INTO entity_genres (entity_id, genre_id) VALUES (?, ?)`).run('e-action', 1)
        db.prepare(`INSERT INTO entity_genres (entity_id, genre_id) VALUES (?, ?)`).run('e-drama', 2)
        db.prepare(`INSERT INTO entity_genres (entity_id, genre_id) VALUES (?, ?)`).run('e-both', 1)
        db.prepare(`INSERT INTO entity_genres (entity_id, genre_id) VALUES (?, ?)`).run('e-both', 2)
    })

    it('genre EXISTS filter returns all items with that genre', () => {
        const rows = db.prepare(`
            SELECT i.id FROM items i
            LEFT JOIN media_entities e ON i.entity_id = e.id
            WHERE i.parent_id = ?
              AND EXISTS (
                SELECT 1 FROM entity_genres eg
                JOIN genres g ON eg.genre_id = g.id
                WHERE eg.entity_id = e.id AND g.name = ?
              )
        `).all('movies', 'Action') as any[]

        const ids = rows.map((r) => r.id)
        expect(ids).toContain('action-film')
        expect(ids).toContain('both-film')
        expect(ids).not.toContain('drama-film')
    })

    it('genre EXISTS filter excludes items without that genre', () => {
        const rows = db.prepare(`
            SELECT i.id FROM items i
            LEFT JOIN media_entities e ON i.entity_id = e.id
            WHERE i.parent_id = ?
              AND EXISTS (
                SELECT 1 FROM entity_genres eg
                JOIN genres g ON eg.genre_id = g.id
                WHERE eg.entity_id = e.id AND g.name = ?
              )
        `).all('movies', 'Drama') as any[]

        const ids = rows.map((r) => r.id)
        expect(ids).toContain('drama-film')
        expect(ids).toContain('both-film')
        expect(ids).not.toContain('action-film')
    })
})

// =================================================================
// Ordering and pagination
// =================================================================

describe('query-builder ordering and pagination', () => {
    beforeEach(() => {
        db = createTestDb()
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, NULL, '.', 'Library', 'folder')`).run('root')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, 'Movies', 'Movies', 'folder')`).run('movies', 'root')

        // Three items with known names for sort order verification
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, ?, ?, 'file')`).run('c', 'movies', 'Movies/c.mkv', 'Charlie')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, ?, ?, 'file')`).run('a', 'movies', 'Movies/a.mkv', 'Alpha')
        db.prepare(`INSERT INTO items (id, parent_id, path, name, type) VALUES (?, ?, ?, ?, 'file')`).run('b', 'movies', 'Movies/b.mkv', 'Bravo')
    })

    it('ORDER BY name ASC returns items in alphabetical order', () => {
        const rows = db.prepare(`SELECT id FROM items WHERE parent_id = ? ORDER BY name ASC`).all('movies') as any[]
        const ids = rows.map((r) => r.id)
        expect(ids).toEqual(['a', 'b', 'c'])
    })

    it('ORDER BY name DESC returns items in reverse alphabetical order', () => {
        const rows = db.prepare(`SELECT id FROM items WHERE parent_id = ? ORDER BY name DESC`).all('movies') as any[]
        const ids = rows.map((r) => r.id)
        expect(ids).toEqual(['c', 'b', 'a'])
    })

    it('LIMIT restricts the number of rows returned', () => {
        const rows = db.prepare(`SELECT id FROM items WHERE parent_id = ? ORDER BY name ASC LIMIT ?`).all('movies', 2) as any[]
        expect(rows.length).toBe(2)
    })

    it('LIMIT + OFFSET skips the first N rows', () => {
        const rows = db.prepare(`SELECT id FROM items WHERE parent_id = ? ORDER BY name ASC LIMIT ? OFFSET ?`).all('movies', 2, 1) as any[]
        const ids = rows.map((r) => r.id)
        // Alphabetical: Alpha(a), Bravo(b), Charlie(c) → skip 1 → Bravo, Charlie
        expect(ids).toEqual(['b', 'c'])
    })
})
