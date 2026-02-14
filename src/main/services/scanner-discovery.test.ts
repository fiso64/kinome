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
}) {
    db.prepare(`
    INSERT INTO items (id, parent_id, path, name, type)
    VALUES (?, ?, ?, ?, ?)
  `).run(item.id, item.parentId ?? null, item.path ?? item.id, item.name ?? item.id, item.type ?? 'folder')
}

function insertMetadata(meta: {
    itemId: string
    mediaType?: string | null
    lastRefreshedAt?: number | null
}) {
    db.prepare(`
    INSERT INTO metadata (item_id, media_type, last_refreshed_at)
    VALUES (?, ?, ?)
  `).run(meta.itemId, meta.mediaType ?? null, meta.lastRefreshedAt ?? null)
}

function insertFolderSettings(settings: {
    itemId: string
    scraperSettings?: Record<string, any>
}) {
    db.prepare(`
    INSERT INTO folder_settings (item_id, scraper_settings_json)
    VALUES (?, ?)
  `).run(settings.itemId, settings.scraperSettings ? JSON.stringify(settings.scraperSettings) : null)
}

// =================================================================
// SPEC(scan_architecture.md §Phase 2, line 163-169):
//   process_tv_children is TRUE by default for TV shows.
//   Query must use LEFT JOIN + IS NOT 0 to treat NULL as enabled.
// =================================================================

describe('getTvShowsForStructuralSync', () => {
    const QUERY = `
    SELECT i.*, m.*, f.scraper_settings_json
    FROM items i
    JOIN metadata m ON i.id = m.item_id
    LEFT JOIN folder_settings f ON i.id = f.item_id
    WHERE i.type = 'folder'
      AND m.media_type = 'tv'
      AND (json_extract(f.scraper_settings_json, '$.process_tv_children') IS NOT 0)
  `

    beforeEach(() => {
        db = createTestDb()
    })

    it('includes TV shows WITHOUT a folder_settings row (default-enabled gate)', () => {
        insertItem({ id: 'show1', type: 'folder' })
        insertMetadata({ itemId: 'show1', mediaType: 'tv' })
        // Deliberately NO folder_settings row

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.id)).toContain('show1')
    })

    it('includes TV shows where process_tv_children is explicitly true', () => {
        insertItem({ id: 'show2', type: 'folder' })
        insertMetadata({ itemId: 'show2', mediaType: 'tv' })
        insertFolderSettings({ itemId: 'show2', scraperSettings: { process_tv_children: 1 } })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.id)).toContain('show2')
    })

    it('EXCLUDES TV shows where process_tv_children is explicitly disabled', () => {
        insertItem({ id: 'show3', type: 'folder' })
        insertMetadata({ itemId: 'show3', mediaType: 'tv' })
        insertFolderSettings({ itemId: 'show3', scraperSettings: { process_tv_children: 0 } })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.id)).not.toContain('show3')
    })

    it('EXCLUDES non-TV items', () => {
        insertItem({ id: 'movie1', type: 'folder' })
        insertMetadata({ itemId: 'movie1', mediaType: 'movie' })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.id)).not.toContain('movie1')
    })

    it('EXCLUDES items without metadata', () => {
        insertItem({ id: 'bare1', type: 'folder' })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.id)).not.toContain('bare1')
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
    SELECT i.*, m.*
    FROM items i
    LEFT JOIN metadata m ON i.id = m.item_id
    LEFT JOIN folder_settings pf ON i.parent_id = pf.item_id
    WHERE (m.media_type IN ('movie', 'tv') OR m.media_type IS NULL)
      AND m.last_refreshed_at IS NULL
      AND json_extract(pf.scraper_settings_json, '$.retrieve_children_metadata') = 1
  `

    beforeEach(() => {
        db = createTestDb()
        // Root folder with Gate A enabled
        insertItem({ id: 'root', path: '.', name: 'Library' })
        insertFolderSettings({ itemId: 'root', scraperSettings: { retrieve_children_metadata: 1 } })
    })

    it('returns dirty items with a gated parent (both conditions met)', () => {
        insertItem({ id: 'movie1', parentId: 'root', type: 'file' })
        insertMetadata({ itemId: 'movie1', mediaType: 'movie', lastRefreshedAt: null })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.id)).toContain('movie1')
    })

    it('returns items with NULL mediaType (unknown type, needs identification)', () => {
        insertItem({ id: 'unknown1', parentId: 'root', type: 'file' })
        insertMetadata({ itemId: 'unknown1', mediaType: null, lastRefreshedAt: null })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.id)).toContain('unknown1')
    })

    it('EXCLUDES already-refreshed items even if parent is gated', () => {
        insertItem({ id: 'fresh1', parentId: 'root', type: 'file' })
        insertMetadata({ itemId: 'fresh1', mediaType: 'movie', lastRefreshedAt: Date.now() })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.id)).not.toContain('fresh1')
    })

    it('EXCLUDES dirty items whose parent is NOT gated', () => {
        insertItem({ id: 'ungated-folder', parentId: 'root', type: 'folder' })
        // No folder_settings for ungated-folder (Gate A not enabled)

        insertItem({ id: 'orphan1', parentId: 'ungated-folder', type: 'file' })
        insertMetadata({ itemId: 'orphan1', mediaType: 'movie', lastRefreshedAt: null })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.id)).not.toContain('orphan1')
    })

    it('EXCLUDES non-content types (seasons, episodes are synced via process_show)', () => {
        insertItem({ id: 'season1', parentId: 'root', type: 'folder' })
        insertMetadata({ itemId: 'season1', mediaType: 'season', lastRefreshedAt: null })

        const results = db.prepare(QUERY).all() as any[]
        expect(results.map((r: any) => r.id)).not.toContain('season1')
    })
})
