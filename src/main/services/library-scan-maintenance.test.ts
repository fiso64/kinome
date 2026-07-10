import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { runFullLibraryScan } from './library.service'
import * as metadataService from './metadata.service'

let ctx: ServiceTestContext

beforeEach(() => {
  ctx = createServiceTestContext()
})

afterEach(() => {
  ctx.cleanup()
})

function pathsForItemIds(itemIds: Iterable<string>): string[] {
  const ids = [...itemIds]
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = ctx.db
    .prepare(`SELECT relative_path FROM media_locations WHERE item_id IN (${placeholders}) ORDER BY relative_path`)
    .all(...ids) as { relative_path: string }[]
  return rows.map((row) => row.relative_path)
}

function itemIdForSourcePath(sourceId: string, relativePath: string): string | null {
  const row = ctx.db.prepare(`
    SELECT item_id
    FROM media_locations
    WHERE source_id = ? AND relative_path = ?
  `).get(sourceId, relativePath) as { item_id: string } | undefined
  return row?.item_id ?? null
}

describe('full-library scan maintenance orchestration', () => {
  it('runs targeted enrichment for a completed source before scanning the next source', async () => {
    const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-fast-source-'))
    const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-slow-source-'))

    const sourceA = { id: 'fast-source', path: tmpA, isRelative: false }
    const sourceB = { id: 'slow-source', path: tmpB, isRelative: false }

    const events: Array<
      | { kind: 'targeted'; slowFileScanned: boolean; paths: string[] }
      | { kind: 'final' }
    > = []

    const enrichItemsSpy = spyOn(metadataService, 'enrichItems').mockImplementation(async (itemIds: Iterable<string>) => {
      const slowFile = ctx.db
        .prepare("SELECT 1 FROM media_locations WHERE source_id = ? AND relative_path = 'slow.mkv'")
        .get(sourceB.id)
      events.push({
        kind: 'targeted',
        slowFileScanned: !!slowFile,
        paths: pathsForItemIds(itemIds)
      })
    })
    const enrichDatabaseSpy = spyOn(metadataService, 'enrichDatabase').mockImplementation(async () => {
      events.push({ kind: 'final' })
    })

    try {
      await fs.writeFile(path.join(tmpA, 'fast.mkv'), 'fast')
      await fs.writeFile(path.join(tmpB, 'slow.mkv'), 'slow')

      await runFullLibraryScan({
        sources: [sourceA, sourceB],
        sourcePaths: new Map([
          [sourceA.id, tmpA],
          [sourceB.id, tmpB]
        ]),
        runEarlyMaintenance: true
      })

      const targetedEvents = events.filter((event) => event.kind === 'targeted') as Extract<
        (typeof events)[number],
        { kind: 'targeted' }
      >[]
      expect(targetedEvents).toHaveLength(2)
      expect(targetedEvents[0].slowFileScanned).toBe(false)
      expect(targetedEvents[0].paths).toContain('fast.mkv')
      expect(targetedEvents[0].paths).not.toContain('slow.mkv')
      expect(targetedEvents[1].slowFileScanned).toBe(true)
      expect(targetedEvents[1].paths).toContain('slow.mkv')
      expect(events.at(-1)).toEqual({ kind: 'final' })
    } finally {
      enrichItemsSpy.mockRestore()
      enrichDatabaseSpy.mockRestore()
      await fs.rm(tmpA, { recursive: true, force: true })
      await fs.rm(tmpB, { recursive: true, force: true })
    }
  })

  it('preserves identity when a same-relative-path folder moves from an earlier source to a later source with new file identities', async () => {
    const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-ssd-source-'))
    const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-hdd-source-'))

    const sourceA = { id: 'ssd-source', path: tmpA, isRelative: false }
    const sourceB = { id: 'hdd-source', path: tmpB, isRelative: false }
    const sourcePaths = new Map([
      [sourceA.id, tmpA],
      [sourceB.id, tmpB]
    ])

    const enrichItemsSpy = spyOn(metadataService, 'enrichItems').mockImplementation(async () => {})
    const enrichDatabaseSpy = spyOn(metadataService, 'enrichDatabase').mockImplementation(async () => {})

    try {
      await fs.mkdir(path.join(tmpA, 'Shows', 'Foo'), { recursive: true })
      await fs.writeFile(path.join(tmpA, 'Shows', 'Foo', 'episode.mkv'), 'episode')

      await runFullLibraryScan({
        sources: [sourceA, sourceB],
        sourcePaths,
        runEarlyMaintenance: false
      })

      const originalShowId = itemIdForSourcePath(sourceA.id, 'Shows/Foo')
      const originalEpisodeId = itemIdForSourcePath(sourceA.id, 'Shows/Foo/episode.mkv')
      expect(originalShowId).not.toBeNull()
      expect(originalEpisodeId).not.toBeNull()

      ctx.db.prepare(`
        INSERT INTO media_entities (id, media_type, title, last_refreshed_at)
        VALUES (?, 'tv', 'Foo', 7777)
      `).run('entity-foo')
      ctx.db.prepare(`
        UPDATE media_items
        SET entity_id = 'entity-foo',
            media_kind = 'tv',
            created_at = 1234
        WHERE id = ?
      `).run(originalShowId)
      ctx.db.prepare(`
        INSERT INTO folder_settings (item_id, view_settings_json)
        VALUES (?, ?)
      `).run(originalShowId, JSON.stringify({ layout: 'grid' }))
      ctx.db.prepare(`
        INSERT INTO user_state (item_id, user_id, watched, last_watched_at)
        VALUES (?, 'default', 1, 5555)
      `).run(originalEpisodeId)

      await fs.mkdir(path.join(tmpB, 'Shows', 'Foo'), { recursive: true })
      await fs.writeFile(path.join(tmpB, 'Shows', 'Foo', 'episode.mkv'), 'episode')
      await fs.rm(path.join(tmpA, 'Shows', 'Foo'), { recursive: true, force: true })

      await runFullLibraryScan({
        sources: [sourceA, sourceB],
        sourcePaths,
        runEarlyMaintenance: true
      })

      expect(itemIdForSourcePath(sourceB.id, 'Shows/Foo')).toBe(originalShowId)
      expect(itemIdForSourcePath(sourceB.id, 'Shows/Foo/episode.mkv')).toBe(originalEpisodeId)
      expect(itemIdForSourcePath(sourceA.id, 'Shows/Foo')).toBeNull()

      const showRow = ctx.db.prepare(`
        SELECT entity_id, created_at, logical_missing
        FROM media_items
        WHERE id = ?
      `).get(originalShowId) as { entity_id: string; created_at: number; logical_missing: number }
      expect(showRow).toEqual({
        entity_id: 'entity-foo',
        created_at: 1234,
        logical_missing: 0
      })

      const watchedState = ctx.db.prepare(`
        SELECT watched, last_watched_at
        FROM user_state
        WHERE item_id = ? AND user_id = 'default'
      `).get(originalEpisodeId) as { watched: number; last_watched_at: number } | undefined
      expect(watchedState).toEqual({ watched: 1, last_watched_at: 5555 })

      const settings = ctx.db.prepare(`
        SELECT view_settings_json
        FROM folder_settings
        WHERE item_id = ?
      `).get(originalShowId) as { view_settings_json: string } | undefined
      expect(JSON.parse(settings!.view_settings_json)).toEqual({ layout: 'grid' })
    } finally {
      enrichItemsSpy.mockRestore()
      enrichDatabaseSpy.mockRestore()
      await fs.rm(tmpA, { recursive: true, force: true })
      await fs.rm(tmpB, { recursive: true, force: true })
    }
  })

  it('preserves TV episode identity when a show is copy-deleted across sources and reorganized into season folders', async () => {
    const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-tv-ssd-source-'))
    const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-tv-hdd-source-'))

    const sourceA = { id: 'tv-ssd-source', path: tmpA, isRelative: false }
    const sourceB = { id: 'tv-hdd-source', path: tmpB, isRelative: false }
    const sourcePaths = new Map([
      [sourceA.id, tmpA],
      [sourceB.id, tmpB]
    ])

    const enrichItemsSpy = spyOn(metadataService, 'enrichItems').mockImplementation(async () => {})
    const enrichDatabaseSpy = spyOn(metadataService, 'enrichDatabase').mockImplementation(async () => {})

    const showA = path.join(tmpA, 'Shows', 'Example Show')
    const flatEp1 = path.join(showA, 'Example.Show.S01E01.mkv')
    const flatEp2 = path.join(showA, 'Example.Show.S01E02.mkv')
    const showB = path.join(tmpB, 'Shows', 'Example Show')
    const seasonB = path.join(showB, 'Season 01')
    const renamedEp1 = path.join(seasonB, 'Example Show - S01E01 - Pilot.mkv')
    const renamedEp2 = path.join(seasonB, 'Example Show - S01E02 - Second.mkv')

    try {
      await fs.mkdir(showA, { recursive: true })
      await fs.writeFile(flatEp1, 'episode-1')
      await fs.writeFile(flatEp2, 'episode-2')

      await runFullLibraryScan({
        sources: [sourceA, sourceB],
        sourcePaths,
        runEarlyMaintenance: false
      })

      const showId = itemIdForSourcePath(sourceA.id, 'Shows/Example Show')
      const ep1Id = itemIdForSourcePath(sourceA.id, 'Shows/Example Show/Example.Show.S01E01.mkv')
      const ep2Id = itemIdForSourcePath(sourceA.id, 'Shows/Example Show/Example.Show.S01E02.mkv')
      expect(showId).not.toBeNull()
      expect(ep1Id).not.toBeNull()
      expect(ep2Id).not.toBeNull()

      ctx.db.prepare(`
        INSERT INTO media_entities (id, tmdb_id, media_type, title, season_number, episode_number, last_refreshed_at)
        VALUES
          ('entity-cross-show', 123, 'tv', 'Example Show', NULL, NULL, 1000),
          ('entity-cross-ep-1', 123, 'episode', 'Pilot', 1, 1, 2000),
          ('entity-cross-ep-2', 123, 'episode', 'Second', 1, 2, 3000)
      `).run()
      ctx.db.prepare(`
        UPDATE media_items
        SET entity_id = 'entity-cross-show',
            media_kind = 'tv',
            created_at = 1111
        WHERE id = ?
      `).run(showId)
      ctx.db.prepare(`
        UPDATE media_items
        SET entity_id = 'entity-cross-ep-1',
            media_kind = 'episode',
            created_at = 2222
        WHERE id = ?
      `).run(ep1Id)
      ctx.db.prepare(`
        UPDATE media_items
        SET entity_id = 'entity-cross-ep-2',
            media_kind = 'episode',
            created_at = 3333
        WHERE id = ?
      `).run(ep2Id)
      ctx.db.prepare(`
        INSERT INTO user_state (item_id, user_id, watched, last_watched_at)
        VALUES (?, 'default', 1, 5555)
      `).run(ep1Id)

      await fs.mkdir(seasonB, { recursive: true })
      await fs.copyFile(flatEp1, renamedEp1)
      await fs.copyFile(flatEp2, renamedEp2)
      await fs.rm(showA, { recursive: true, force: true })

      await runFullLibraryScan({
        sources: [sourceA, sourceB],
        sourcePaths,
        runEarlyMaintenance: true
      })

      expect(itemIdForSourcePath(sourceB.id, 'Shows/Example Show')).toBe(showId)
      expect(itemIdForSourcePath(sourceB.id, 'Shows/Example Show/Season 01/Example Show - S01E01 - Pilot.mkv')).toBe(ep1Id)
      expect(itemIdForSourcePath(sourceB.id, 'Shows/Example Show/Season 01/Example Show - S01E02 - Second.mkv')).toBe(ep2Id)
      expect(itemIdForSourcePath(sourceA.id, 'Shows/Example Show/Example.Show.S01E01.mkv')).toBeNull()
      expect(itemIdForSourcePath(sourceA.id, 'Shows/Example Show/Example.Show.S01E02.mkv')).toBeNull()

      const seasonId = itemIdForSourcePath(sourceB.id, 'Shows/Example Show/Season 01')
      expect(seasonId).not.toBeNull()

      const ep1 = ctx.db.prepare(`
        SELECT mi.parent_item_id, mi.entity_id, mi.media_kind, mi.created_at, ml.source_id, ml.relative_path, ml.name,
               e.title, e.season_number, e.episode_number, e.last_refreshed_at
        FROM media_items mi
        JOIN media_locations ml ON ml.item_id = mi.id
        JOIN media_entities e ON e.id = mi.entity_id
        WHERE mi.id = ?
      `).get(ep1Id) as any
      expect(ep1).toEqual({
        parent_item_id: seasonId,
        entity_id: 'entity-cross-ep-1',
        media_kind: 'episode',
        created_at: 2222,
        source_id: sourceB.id,
        relative_path: 'Shows/Example Show/Season 01/Example Show - S01E01 - Pilot.mkv',
        name: 'Example Show - S01E01 - Pilot.mkv',
        title: 'Pilot',
        season_number: 1,
        episode_number: 1,
        last_refreshed_at: 2000
      })

      const ep2 = ctx.db.prepare(`
        SELECT mi.parent_item_id, mi.entity_id, mi.media_kind, mi.created_at,
               e.title, e.season_number, e.episode_number, e.last_refreshed_at
        FROM media_items mi
        JOIN media_entities e ON e.id = mi.entity_id
        WHERE mi.id = ?
      `).get(ep2Id) as any
      expect(ep2).toEqual({
        parent_item_id: seasonId,
        entity_id: 'entity-cross-ep-2',
        media_kind: 'episode',
        created_at: 3333,
        title: 'Second',
        season_number: 1,
        episode_number: 2,
        last_refreshed_at: 3000
      })

      const watchedState = ctx.db.prepare(`
        SELECT watched, last_watched_at
        FROM user_state
        WHERE item_id = ? AND user_id = 'default'
      `).get(ep1Id) as { watched: number; last_watched_at: number } | undefined
      expect(watchedState).toEqual({ watched: 1, last_watched_at: 5555 })
    } finally {
      enrichItemsSpy.mockRestore()
      enrichDatabaseSpy.mockRestore()
      await fs.rm(tmpA, { recursive: true, force: true })
      await fs.rm(tmpB, { recursive: true, force: true })
    }
  })
})
