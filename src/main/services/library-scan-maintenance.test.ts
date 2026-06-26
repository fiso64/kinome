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
})
