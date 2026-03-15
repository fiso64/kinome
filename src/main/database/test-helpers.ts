/**
 * Shared test helpers for integration tests.
 *
 * Provides a createServiceTestContext() function that stands up an in-memory
 * SQLite DB and wires it into the client singleton so all service-layer code
 * (which calls getDb()) hits the test DB without mocking.
 *
 * Usage:
 *   let ctx: ServiceTestContext
 *   beforeEach(() => { ctx = createServiceTestContext() })
 *   afterEach(() => { ctx.cleanup() })
 *
 *   it('works', () => {
 *     ctx.seedItems([{ id: 'root', parentId: null, type: 'folder' }])
 *     const result = someServiceFunction('root')
 *     expect(result).toBe(...)
 *   })
 */
import { Database } from 'bun:sqlite'
import { SCHEMA_SQL } from './schema'
import { _setDbForTesting, _clearDbForTesting } from './client'
import type { LibraryConditionOp } from '@shared/types'

export interface SeedItem {
  id: string
  parentId?: string | null
  path?: string
  name?: string
  type?: 'file' | 'folder'
  entityId?: string | null
  isVirtual?: number
  virtualType?: string | null
  filterJson?: string | null
}

export interface SeedEntity {
  id: string
  mediaType?: string | null
  title?: string | null
  year?: number | null
  seasonNumber?: number | null
  episodeNumber?: number | null
}

export interface SeedFolderSettings {
  itemId: string
  viewSettings?: Record<string, any>
  scraperSettings?: Record<string, any>
}

export interface ServiceTestContext {
  db: Database
  seedItems: (items: SeedItem[]) => void
  seedEntities: (entities: SeedEntity[]) => void
  seedFolderSettings: (settings: SeedFolderSettings[]) => void
  seedGenres: (entityId: string, genres: string[]) => void
  seedTags: (entityId: string, tags: Record<string, string>) => void
  seedVirtualTags: (entityId: string, tags: Record<string, string>) => void
  cleanup: () => void
}

export function createServiceTestContext(): ServiceTestContext {
  const db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  // Point the global singleton at this DB so service code works
  _setDbForTesting(db)

  const seedItems = (items: SeedItem[]) => {
    const stmt = db.prepare(`
      INSERT INTO items (id, parent_id, path, name, type, entity_id, is_virtual, virtual_type, filter_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const item of items) {
      stmt.run(
        item.id,
        item.parentId ?? null,
        item.path ?? item.id,
        item.name ?? item.id,
        item.type ?? 'file',
        item.entityId ?? null,
        item.isVirtual ?? 0,
        item.virtualType ?? null,
        item.filterJson ?? null
      )
    }
  }

  const seedEntities = (entities: SeedEntity[]) => {
    const stmt = db.prepare(`
      INSERT INTO media_entities (id, media_type, title, year, season_number, episode_number)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const e of entities) {
      stmt.run(e.id, e.mediaType ?? null, e.title ?? null, e.year ?? null, e.seasonNumber ?? null, e.episodeNumber ?? null)
    }
  }

  const seedFolderSettings = (settings: SeedFolderSettings[]) => {
    const stmt = db.prepare(`
      INSERT INTO folder_settings (item_id, view_settings_json, scraper_settings_json)
      VALUES (?, ?, ?)
    `)
    for (const s of settings) {
      stmt.run(
        s.itemId,
        s.viewSettings ? JSON.stringify(s.viewSettings) : null,
        s.scraperSettings ? JSON.stringify(s.scraperSettings) : null
      )
    }
  }

  const seedGenres = (entityId: string, genres: string[]) => {
    for (const name of genres) {
      db.prepare(`INSERT OR IGNORE INTO genres (name) VALUES (?)`).run(name)
      const row = db.prepare(`SELECT id FROM genres WHERE name = ?`).get(name) as any
      db.prepare(`INSERT OR IGNORE INTO entity_genres (entity_id, genre_id) VALUES (?, ?)`).run(entityId, row.id)
    }
  }

  const seedTags = (entityId: string, tags: Record<string, string>) => {
    for (const [key, value] of Object.entries(tags)) {
      db.prepare(`INSERT INTO entity_tags (entity_id, key, value) VALUES (?, ?, ?)`).run(entityId, key, value)
    }
  }

  const seedVirtualTags = (entityId: string, tags: Record<string, string>) => {
    for (const [key, value] of Object.entries(tags)) {
      db.prepare(`INSERT INTO entity_virtual_tags (entity_id, key, value) VALUES (?, ?, ?)`).run(entityId, key, value)
    }
  }

  const cleanup = () => {
    db.close()
    _clearDbForTesting()
  }

  return { db, seedItems, seedEntities, seedFolderSettings, seedGenres, seedTags, seedVirtualTags, cleanup }
}
