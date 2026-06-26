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
import { setTransport } from '../transport.registry'
import type { ITransport } from '../transport/transport.interface'
import type { LibraryConditionOp } from '@shared/types'

/** No-op transport for tests — satisfies the ITransport contract without side effects. */
function createNoopTransport(): ITransport {
  return {
    notifyLibraryItemsUpdated: () => {},
    notifyMetadataIndexUpdated: () => {},
    notifyLibraryItemDeleted: () => {},
    notifySettingsUpdated: () => {},
    forceRendererReload: () => {},
    notifyScanStatusChanged: () => {},
    broadcast: () => {},
    notifyHandlerTestSuccess: () => {},
    getCurrentStatus: () => ({} as any)
  }
}

export interface SeedItem {
  id: string
  parentId?: string | null
  path?: string
  name?: string
  type?: 'file' | 'folder'
  sourceId?: string | null
  entityId?: string | null
  isHidden?: number
  isIgnored?: number
  isMissing?: number
  isVirtual?: number
  virtualType?: string | null
  filterJson?: string | null
  ownerId?: string | null
}

export interface SeedEntity {
  id: string
  tmdbId?: number | null
  mediaType?: string | null
  title?: string | null
  year?: number | null
  seasonNumber?: number | null
  episodeNumber?: number | null
}

export interface SeedFolderSettings {
  itemId: string
  viewSettings?: Record<string, any>
  folderSettings?: { retrieveChildrenMetadata?: boolean; childrenTypeHint?: string | null; processTvChildren?: boolean }
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

  // Wire up a no-op transport so services that broadcast don't crash
  setTransport(createNoopTransport())

  const seedItems = (items: SeedItem[]) => {
    const itemStmt = db.prepare(`
      INSERT INTO media_items (
        id, parent_item_id, physical_kind, media_kind, name, entity_id,
        is_virtual, virtual_type, filter_json, owner_id,
        is_hidden, logical_missing, created_at, updated_at
      )
      VALUES (
        ?, ?, ?, (SELECT media_type FROM media_entities WHERE id = ?), ?, ?,
        ?, ?, ?, ?, ?, ?, 1000, 1000
      )
      ON CONFLICT(id) DO UPDATE SET
        parent_item_id = excluded.parent_item_id,
        physical_kind = excluded.physical_kind,
        media_kind = excluded.media_kind,
        name = excluded.name,
        entity_id = excluded.entity_id,
        is_virtual = excluded.is_virtual,
        virtual_type = excluded.virtual_type,
        filter_json = excluded.filter_json,
        owner_id = excluded.owner_id,
        is_hidden = excluded.is_hidden,
        logical_missing = excluded.logical_missing,
        updated_at = excluded.updated_at
    `)
    const locationStmt = db.prepare(`
      INSERT INTO media_locations (
        id, item_id, source_id, relative_path, name, type,
        is_present, is_ignored, is_hidden, is_shadowed,
        first_seen_at, last_seen_at, missing_since
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1000, 1000, ?)
      ON CONFLICT(source_id, relative_path) DO UPDATE SET
        item_id = excluded.item_id,
        name = excluded.name,
        type = excluded.type,
        is_present = excluded.is_present,
        is_ignored = excluded.is_ignored,
        is_hidden = excluded.is_hidden,
        last_seen_at = excluded.last_seen_at,
        missing_since = excluded.missing_since
    `)
    for (const item of items) {
      const isVirtual = item.isVirtual ?? 0
      const type = item.type ?? 'file'
      const entityId = item.entityId ?? null
      const name = item.name ?? item.id
      const path = item.path ?? item.id
      const isMissing = item.isMissing ?? 0
      itemStmt.run(
        item.id,
        item.parentId ?? null,
        isVirtual ? 'virtual' : type,
        entityId,
        name,
        entityId,
        isVirtual,
        item.virtualType ?? null,
        item.filterJson ?? null,
        item.ownerId ?? null,
        item.isHidden ?? 0,
        isMissing
      )
      if (!isVirtual) {
        const sourceId = item.sourceId ?? 'test-source'
        locationStmt.run(
          `location:${item.id}`,
          item.id,
          sourceId,
          path,
          name,
          type,
          isMissing ? 0 : 1,
          item.isIgnored ?? 0,
          item.isHidden ?? 0,
          isMissing ? 1000 : null
        )
      }
    }
  }

  const seedEntities = (entities: SeedEntity[]) => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO media_entities (id, tmdb_id, media_type, title, year, season_number, episode_number)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const e of entities) {
      stmt.run(e.id, e.tmdbId ?? null, e.mediaType ?? null, e.title ?? null, e.year ?? null, e.seasonNumber ?? null, e.episodeNumber ?? null)
    }
  }

  const seedFolderSettings = (settings: SeedFolderSettings[]) => {
    const stmt = db.prepare(`
      INSERT INTO folder_settings (item_id, view_settings_json, applied_grouping, retrieve_children_metadata, children_type_hint, process_tv_children)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const s of settings) {
      const vs = s.viewSettings ? { ...s.viewSettings } : null
      const appliedGrouping = vs?.appliedGrouping ?? null
      if (vs) delete vs.appliedGrouping
      stmt.run(
        s.itemId,
        vs ? JSON.stringify(vs) : null,
        appliedGrouping,
        s.folderSettings?.retrieveChildrenMetadata ? 1 : 0,
        s.folderSettings?.childrenTypeHint ?? null,
        s.folderSettings?.processTvChildren === false ? 0 : 1,
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
    const itemRows = db.prepare('SELECT id FROM media_items WHERE entity_id = ?').all(entityId) as { id: string }[]
    for (const [key, value] of Object.entries(tags)) {
      db.prepare(`INSERT OR REPLACE INTO entity_tags (entity_id, key, value) VALUES (?, ?, ?)`).run(entityId, key, value)
      for (const row of itemRows) {
        db.prepare(`INSERT OR REPLACE INTO item_tags (item_id, key, value) VALUES (?, ?, ?)`).run(row.id, key, value)
      }
    }
  }

  const seedVirtualTags = (entityId: string, tags: Record<string, string>) => {
    const itemRows = db.prepare('SELECT id FROM media_items WHERE entity_id = ?').all(entityId) as { id: string }[]
    for (const [key, value] of Object.entries(tags)) {
      db.prepare(`INSERT OR REPLACE INTO entity_virtual_tags (entity_id, key, value) VALUES (?, ?, ?)`).run(entityId, key, value)
      for (const row of itemRows) {
        db.prepare(`INSERT OR REPLACE INTO item_virtual_tags (item_id, key, value) VALUES (?, ?, ?)`).run(row.id, key, value)
      }
    }
  }

  const cleanup = () => {
    db.close()
    _clearDbForTesting()
  }

  return { db, seedItems, seedEntities, seedFolderSettings, seedGenres, seedTags, seedVirtualTags, cleanup }
}
