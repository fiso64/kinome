/**
 * Root Retrieval Integration Test
 *
 * Reproduces the exact server flow:
 *   1. Schema created (fresh DB)
 *   2. Root item inserted via upsertRootItem (Phase 1 init)
 *   3. Items inserted via upsertLibraryItems (Phase 1 crawl)
 *   4. Root fetched via fetchRoot() (getLibraryRoot path → /api/library-root)
 *   5. Root fetched via rawFind() through query builder (find() path → /api/items/root)
 *
 * Regression guard: e.id column shadowing i.id when using SELECT i.*, e.*
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SCHEMA_SQL } from './schema'
import { buildFindQuery } from './query-builder'
import { mapRowToLibraryItem } from './mappers'

let db: Database

function createTestDb(): Database {
    const testDb = new Database(':memory:')
    testDb.run('PRAGMA foreign_keys = ON')
    testDb.exec(SCHEMA_SQL)
    return testDb
}

function upsertRootItem(id: string, name: string) {
    db.prepare(`
    INSERT INTO items (id, parent_id, path, name, type, is_missing, is_ignored, is_hidden)
    VALUES (?, NULL, '.', ?, 'folder', 0, 0, 0)
    ON CONFLICT(id) DO UPDATE SET is_missing = 0, name = excluded.name
  `).run(id, name)
}

function upsertLibraryItems(items: any[]) {
    const stmt = db.prepare(`
    INSERT INTO items (id, parent_id, path, name, type, size, mtime, birthtime, inode, device_id, is_missing, is_ignored, is_hidden)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      is_missing = 0, parent_id = excluded.parent_id,
      is_ignored = COALESCE(excluded.is_ignored, is_ignored),
      is_hidden = COALESCE(excluded.is_hidden, is_hidden)
  `)
    for (const item of items) {
        stmt.run(item['@id'], item['@parentId'], item['@path'], item['@name'], item['@type'],
            null, null, null, null, null, item['@isIgnored'] ?? 0, item['@isHidden'] ?? 0)
    }
}

// Minimal reproduction of FULL_SELECT_SQL (uses explicit entity columns, no e.*)
function fetchRoot(): any {
    return db.prepare(`
    SELECT i.*,
           e.id AS _entity_id,
           e.tmdb_id, e.media_type, e.title, e.original_title, e.overview,
           e.release_date, e.year, e.runtime,
           e.season_number, e.episode_number, e.parent_entity_id,
           e.poster_path, e.backdrop_path, e.logo_path,
           e.locked_fields_json, e.last_refreshed_at, e.version,
           (SELECT json_group_array(g.name) FROM entity_genres eg JOIN genres g ON eg.genre_id = g.id WHERE eg.entity_id = e.id) AS genres,
           (SELECT json_group_object(t.key, t.value) FROM entity_tags t WHERE t.entity_id = e.id) AS tags,
           (SELECT json_group_object(vt.key, vt.value) FROM entity_virtual_tags vt WHERE vt.entity_id = e.id) AS virtualTags,
           u.watched, u.last_watched_at, u.continue_watching_dismissed,
           u.next_up_dismissed, u.next_up_episode_id,
           CASE WHEN f.applied_grouping IS NOT NULL
               THEN json_set(COALESCE(f.view_settings_json, '{}'), '$.appliedGrouping', f.applied_grouping)
               ELSE f.view_settings_json END AS viewSettings,
           f.retrieve_children_metadata, f.children_type_hint, f.process_tv_children
    FROM items i
    LEFT JOIN media_entities e ON i.entity_id = e.id
    LEFT JOIN user_state u ON i.id = u.item_id
    LEFT JOIN folder_settings f ON i.id = f.item_id
    WHERE i.parent_id IS NULL LIMIT 1
  `).get()
}

// These field lists are test-local. They are NOT imported from shared/types.ts
// to avoid locking in any particular field set.
const BASIC_FIELDS = ['id', 'parentId', 'name', 'type', 'title', 'mediaType', 'posterPath']
const EXTENDED_FIELDS = [...BASIC_FIELDS, 'overview', 'backdropPath', 'logoPath', 'year', 'genres']

describe('Root Retrieval (End-to-End)', () => {
    const ROOT_ID = 'abc123rootid'

    beforeEach(() => {
        db = createTestDb()
        upsertRootItem(ROOT_ID, 'My Library')
        upsertLibraryItems([
            { '@id': 'child1', '@parentId': ROOT_ID, '@path': 'Movie1', '@name': 'Movie1', '@type': 'folder', '@isIgnored': 0, '@isHidden': 0 },
            { '@id': 'child2', '@parentId': ROOT_ID, '@path': 'Movie2', '@name': 'Movie2', '@type': 'folder', '@isIgnored': 0, '@isHidden': 0 },
        ])
    })

    it('fetchRoot() finds root by parent_id IS NULL', () => {
        const row = fetchRoot()
        expect(row).not.toBeNull()

        const item = mapRowToLibraryItem(row)
        expect(item.id).toBe(ROOT_ID)
        expect(item.name).toBe('My Library')
    })

    it('find() via query builder returns root by id', () => {
        const { query, params } = buildFindQuery({
            fields: BASIC_FIELDS,
            where: { id: ROOT_ID },
            limit: 1,
        })

        const rows = db.prepare(query).all(...params) as any[]
        expect(rows.length).toBe(1)

        const item = mapRowToLibraryItem(rows[0])
        expect(item.id).toBe(ROOT_ID)
    })

    it('find() returns root with extended fields', () => {
        const { query, params } = buildFindQuery({
            fields: EXTENDED_FIELDS,
            where: { id: ROOT_ID },
            limit: 1,
        })

        const rows = db.prepare(query).all(...params) as any[]
        expect(rows.length).toBe(1)

        const item = mapRowToLibraryItem(rows[0])
        expect(item.id).toBe(ROOT_ID)
        expect(item.name).toBe('My Library')
    })

    it('find() returns children of root', () => {
        const { query, params } = buildFindQuery({
            fields: BASIC_FIELDS,
            where: { parentId: ROOT_ID },
        })

        const rows = db.prepare(query).all(...params) as any[]
        expect(rows.length).toBe(2)
        const items = rows.map(mapRowToLibraryItem)
        expect(items.map(i => i.id)).toContain('child1')
        expect(items.map(i => i.id)).toContain('child2')
    })

    it('root.id is preserved even when entity_id is NULL (no metadata)', () => {
        const root = db.prepare('SELECT entity_id FROM items WHERE id = ?').get(ROOT_ID) as any
        expect(root.entity_id).toBeNull()

        const { query, params } = buildFindQuery({
            fields: EXTENDED_FIELDS,
            where: { id: ROOT_ID },
            limit: 1,
        })

        const rows = db.prepare(query).all(...params) as any[]
        expect(rows.length).toBe(1)
        expect(rows[0].id).toBe(ROOT_ID) // Must NOT be null from e.id shadowing
    })

    it('upsertMetadata creates entity and links it', () => {
        const entityId = 'test-entity-uuid'
        db.prepare('INSERT INTO media_entities (id) VALUES (?)').run(entityId)
        db.prepare('UPDATE items SET entity_id = ? WHERE id = ?').run(entityId, 'child1')
        db.prepare(`
      UPDATE media_entities SET title = ?, media_type = ?, tmdb_id = ?, poster_path = ?
      WHERE id = ?
    `).run('Rocky', 'movie', 1366, 'rocky.jpg', entityId)

        const { query, params } = buildFindQuery({
            fields: EXTENDED_FIELDS,
            where: { id: 'child1' },
            limit: 1,
        })

        const rows = db.prepare(query).all(...params) as any[]
        expect(rows.length).toBe(1)

        const item = mapRowToLibraryItem(rows[0])
        expect(item.id).toBe('child1')
        expect(item.title).toBe('Rocky')
        expect(item.mediaType).toBe('movie')
        expect(item.posterPath).toBe('rocky.jpg')
    })

    it('user_state upsert works with FK constraint', () => {
        expect(() => {
            db.prepare(`INSERT INTO user_state (item_id, watched) VALUES (?, 1)
        ON CONFLICT(item_id, user_id) DO UPDATE SET watched = excluded.watched`).run('child1')
        }).not.toThrow()
    })

    it('user_state upsert fails for non-existent item', () => {
        expect(() => {
            db.prepare(`INSERT INTO user_state (item_id, watched) VALUES (?, 1)
        ON CONFLICT(item_id, user_id) DO UPDATE SET watched = excluded.watched`).run('DOES_NOT_EXIST')
        }).toThrow()
    })
})
