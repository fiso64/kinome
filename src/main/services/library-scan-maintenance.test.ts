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
})
