/**
 * Scanner Discovery Invariant Tests
 *
 * These tests enforce the Phase 2 discovery logic from scan_architecture.md.
 * They guard against regressions where JOIN types or WHERE clause logic
 * is accidentally changed during refactoring.
 *
 * SPEC: scan_architecture.md §Phase 2
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
    entityId?: string | null
}) {
    db.prepare(`
    INSERT INTO items (id, parent_id, path, name, type, entity_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(item.id, item.parentId ?? null, item.path ?? item.id, item.name ?? item.id, item.type ?? 'folder', item.entityId ?? null)
}

function insertEntity(entity: {
    id: string
    mediaType?: string | null
    lastRefreshedAt?: number | null
}) {
    db.prepare(`
    INSERT INTO media_entities (id, media_type, last_refreshed_at)
    VALUES (?, ?, ?)
  `).run(entity.id, entity.mediaType ?? null, entity.lastRefreshedAt ?? null)
}

function insertFolderSettings(settings: {
    itemId: string
    folderSettings?: { retrieveChildrenMetadata?: boolean; childrenTypeHint?: string | null; processTvChildren?: boolean }
}) {
    db.prepare(`
    INSERT INTO folder_settings (item_id, retrieve_children_metadata, children_type_hint, process_tv_children)
    VALUES (?, ?, ?, ?)
  `).run(
        settings.itemId,
        settings.folderSettings?.retrieveChildrenMetadata ? 1 : 0,
        settings.folderSettings?.childrenTypeHint ?? null,
        settings.folderSettings?.processTvChildren === false ? 0 : 1,
    )
}

// =================================================================
// SPEC(scan_architecture.md §Phase 2, line 163-169):
//   process_tv_children is TRUE by default for TV shows.
//   Query must use LEFT JOIN + IS NOT 0 to treat NULL as enabled.
// =================================================================

describe('getTvShowsForStructuralSync', () => {
    const QUERY = `
    SELECT i.id AS item_id, i.type, e.media_type, f.process_tv_children
    FROM items i
    JOIN media_entities e ON i.entity_id = e.id
    LEFT JOIN folder_settings f ON i.id = f.item_id
    WHERE i.type = 'folder'
      AND e.media_type = 'tv'
      AND (f.process_tv_children IS NULL OR f.process_tv_children != 0)
  `

    beforeEach(() => {
        db = createTestDb()
    })

    it('includes TV shows WITHOUT a folder_settings row (default-enabled gate)', () => {
        const entityId = 'entity-show1'
        insertEntity({ id: entityId, mediaType: 'tv' })
        insertItem({ id: 'show1', type: 'folder', entityId })
        // Deliberately NO folder_settings row

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.item_id)).toContain('show1')
    })

    it('includes TV shows where process_tv_children is explicitly true', () => {
        const entityId = 'entity-show2'
        insertEntity({ id: entityId, mediaType: 'tv' })
        insertItem({ id: 'show2', type: 'folder', entityId })
        insertFolderSettings({ itemId: 'show2', folderSettings: { processTvChildren: true } })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.item_id)).toContain('show2')
    })

    it('EXCLUDES TV shows where process_tv_children is explicitly disabled', () => {
        const entityId = 'entity-show3'
        insertEntity({ id: entityId, mediaType: 'tv' })
        insertItem({ id: 'show3', type: 'folder', entityId })
        insertFolderSettings({ itemId: 'show3', folderSettings: { processTvChildren: false } })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.item_id)).not.toContain('show3')
    })

    it('EXCLUDES non-TV items', () => {
        const entityId = 'entity-movie1'
        insertEntity({ id: entityId, mediaType: 'movie' })
        insertItem({ id: 'movie1', type: 'folder', entityId })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.item_id)).not.toContain('movie1')
    })

    it('EXCLUDES items without an entity link', () => {
        insertItem({ id: 'bare1', type: 'folder' })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.item_id)).not.toContain('bare1')
    })
})

// =================================================================
// SPEC(scan_architecture.md §Phase 2, line 187-195):
//   dirty_roots = items WHERE
//     (mediaType IN ('movie', 'tv', NULL) AND lastRefreshedAt IS NULL)
//     AND (parent.retrieve_children_metadata == TRUE)
//
//   ALL conditions are ANDed. Not ORed.
// =================================================================

describe('getDiscoveryItemsForPhase2', () => {
    const QUERY = `
    SELECT i.id AS item_id, i.type, e.media_type, e.last_refreshed_at
    FROM items i
    LEFT JOIN media_entities e ON i.entity_id = e.id
    LEFT JOIN folder_settings pf ON i.parent_id = pf.item_id
    WHERE (e.media_type IN ('movie', 'tv') OR e.media_type IS NULL)
      AND e.last_refreshed_at IS NULL
      AND pf.retrieve_children_metadata = 1
  `

    beforeEach(() => {
        db = createTestDb()
        // Root folder with Gate A enabled
        insertItem({ id: 'root', path: '.', name: 'Library' })
        insertFolderSettings({ itemId: 'root', folderSettings: { retrieveChildrenMetadata: true } })
    })

    it('returns dirty items with a gated parent (both conditions met)', () => {
        const entityId = 'entity-movie1'
        insertEntity({ id: entityId, mediaType: 'movie', lastRefreshedAt: null })
        insertItem({ id: 'movie1', parentId: 'root', type: 'file', entityId })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.item_id)).toContain('movie1')
    })

    it('returns items with NULL mediaType (unknown type, needs identification)', () => {
        const entityId = 'entity-unknown1'
        insertEntity({ id: entityId, mediaType: null, lastRefreshedAt: null })
        insertItem({ id: 'unknown1', parentId: 'root', type: 'file', entityId })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.item_id)).toContain('unknown1')
    })

    it('EXCLUDES already-refreshed items even if parent is gated', () => {
        const entityId = 'entity-fresh1'
        insertEntity({ id: entityId, mediaType: 'movie', lastRefreshedAt: Date.now() })
        insertItem({ id: 'fresh1', parentId: 'root', type: 'file', entityId })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.item_id)).not.toContain('fresh1')
    })

    it('EXCLUDES dirty items whose parent is NOT gated', () => {
        insertItem({ id: 'ungated-folder', parentId: 'root', type: 'folder' })
        // No folder_settings for ungated-folder (Gate A not enabled)

        const entityId = 'entity-orphan1'
        insertEntity({ id: entityId, mediaType: 'movie', lastRefreshedAt: null })
        insertItem({ id: 'orphan1', parentId: 'ungated-folder', type: 'file', entityId })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.item_id)).not.toContain('orphan1')
    })

    it('EXCLUDES non-content types (seasons, episodes are synced via process_show)', () => {
        const entityId = 'entity-season1'
        insertEntity({ id: entityId, mediaType: 'season', lastRefreshedAt: null })
        insertItem({ id: 'season1', parentId: 'root', type: 'folder', entityId })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.item_id)).not.toContain('season1')
    })
})
