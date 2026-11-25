import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { resolveScanScope, runLibraryScan } from './library.service'
import * as filesystemService from './filesystem.service'
import * as metadataService from './metadata.service'
import * as fileProbe from './probe-media'
import * as settingsService from './settings.service'
import * as retriever from './retriever.service'
import { getTransport } from '../transport.registry'
import { getFileChangeRevisions, saveProviderMatch, upsertMetadata } from '../database/repositories/metadata.repo'
import { find as findItems, getHomeFolderId, getItemById } from './repository.service'

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
    WHERE source_id = ? AND relative_path = ? AND is_present = 1
  `).get(sourceId, relativePath) as { item_id: string } | undefined
  return row?.item_id ?? null
}

describe('full-library scan maintenance orchestration', () => {
  it('publishes Home before probing and keeps probe status active through the file-tag refresh', async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-probe-milestones-'))
    const source = { id: 'source', path: fixture, isRelative: false }
    const probeStarted = Promise.withResolvers<void>()
    const releaseProbe = Promise.withResolvers<void>()
    const settings = await settingsService.readSettings()
    const readSettings = spyOn(settingsService, 'readSettings').mockResolvedValue({
      ...settings,
      tmdbApiKey: '',
      virtualTags: [...(settings.virtualTags ?? []), {
        id: 'resolution', name: 'resolution', cases: [{
          filter: { conditions: [{ field: 'file.videoHeight', op: 'eq', value: 1080 }] },
          result: '1080p'
        }]
      }]
    })
    const which = spyOn(Bun, 'which').mockReturnValue('ffprobe')
    const probe = spyOn(fileProbe, 'probeMedia').mockImplementation(async () => {
      probeStarted.resolve()
      await releaseProbe.promise
      return { tracks: [{ index: 0, kind: 'video', height: 1080, default: true, forced: false, hearingImpaired: false }] }
    })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const info = spyOn(console, 'info').mockImplementation(() => {})
    const events: string[] = []
    const transport = getTransport()
    const notify = spyOn(transport, 'notifyMetadataIndexUpdated').mockImplementation(() => {
      events.push('published')
    })
    const status = spyOn(transport, 'notifyScanStatusChanged').mockImplementation(({ isProbingLocalMedia }) => {
      if (isProbingLocalMedia !== undefined) events.push(isProbingLocalMedia ? 'probe started' : 'probe finished')
    })
    const scanLibrary = () => runLibraryScan({
      sources: [source],
      sourcePaths: new Map([[source.id, fixture]]),
      sourceFolderSettings: { [source.id]: { [fixture]: { retrieve_children_metadata: true } } }
    })

    try {
      const file = path.join(fixture, 'Feature.mkv')
      await fs.writeFile(file, 'probe fixture')
      await fs.utimes(file, 1_700_000_000, 1_700_000_000)
      const scan = scanLibrary()
      try {
        await Promise.race([probeStarted.promise, scan])
        expect(events).toEqual(['published', 'probe started'])
        expect(ctx.db.query("SELECT 1 FROM media_items WHERE parent_item_id = ? AND name = 'Uncategorized'").get(getHomeFolderId()))
          .not.toBeNull()
        expect(ctx.db.query("SELECT value FROM item_virtual_tags WHERE key = 'resolution'").get()).toBeNull()
      } finally {
        releaseProbe.resolve()
        await scan
      }
      expect(ctx.db.query("SELECT value FROM item_virtual_tags WHERE key = 'resolution'").get()).toEqual({ value: '1080p' })
      expect(events).toEqual(['published', 'probe started', 'published', 'probe finished'])

      events.length = 0
      await scanLibrary()
      expect(events).toEqual(['published'])
      expect(probe).toHaveBeenCalledTimes(1)
    } finally {
      status.mockRestore()
      notify.mockRestore()
      info.mockRestore()
      log.mockRestore()
      probe.mockRestore()
      which.mockRestore()
      readSettings.mockRestore()
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })

  it.each([false, true])('preserves identity after copy, delete, and rename (reverse priority: %s)', async (reverse) => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-content-move-'))
    const sources = ['first', 'second'].map((id) => ({
      id, path: path.join(fixture, id), isRelative: false,
    }))
    const [first, second] = reverse ? [sources[1], sources[0]] : sources
    const sourcePaths = new Map(sources.map(({ id, path }) => [id, path]))
    const scan = () => runLibraryScan({ sources, sourcePaths, runEarlyMaintenance: false })
    const enrichment = spyOn(metadataService, 'enrichDatabase').mockResolvedValue(undefined)

    try {
      const original = path.join(first.path, 'Old Movie')
      const destination = path.join(second.path, 'New Movie')
      await fs.mkdir(original, { recursive: true })
      await fs.mkdir(second.path)
      await fs.writeFile(path.join(original, 'Old.mkv'), 'fixture movie data')
      await scan()
      const originalFolderId = itemIdForSourcePath(first.id, 'Old Movie')
      const originalFileId = itemIdForSourcePath(first.id, 'Old Movie/Old.mkv')
      expect(originalFolderId).not.toBeNull()
      expect(originalFileId).not.toBeNull()

      await fs.mkdir(destination)
      await fs.copyFile(path.join(original, 'Old.mkv'), path.join(destination, 'New.mkv'))
      await fs.rm(original, { recursive: true })
      await scan()

      expect(itemIdForSourcePath(second.id, 'New Movie')).toBe(originalFolderId)
      expect(itemIdForSourcePath(second.id, 'New Movie/New.mkv')).toBe(originalFileId)
      expect(itemIdForSourcePath(first.id, 'Old Movie/Old.mkv')).toBeNull()
    } finally {
      enrichment.mockRestore()
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })

  it('refreshes changed files’ nearest titles and only the affected season, with retry and opt-out', async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-refresh-on-edit-'))
    const source = { id: 'source', path: fixture, isRelative: false }
    const scan = (refetchRemoteMetadataOnFileChange?: boolean) => runLibraryScan({
      sources: [source], sourcePaths: new Map([[source.id, fixture]]), refetchRemoteMetadataOnFileChange
    })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const settings = await settingsService.readSettings()
    const readSettings = spyOn(settingsService, 'readSettings').mockResolvedValue({ ...settings, tmdbApiKey: '' })
    const getDetails = spyOn(retriever, 'getDetails').mockImplementation(async (id, type) => type === 'tv' ? {
      id, name: 'Orbit', status: 'Returning Series', next_episode_to_air: { air_date: '2030-01-02' },
      seasons: [1, 2].map((season_number) => ({ season_number, name: `Season ${season_number}`, overview: '' }))
    } : { id, title: 'Feature Refreshed', status: 'Released' })
    const getCredits = spyOn(retriever, 'getCredits').mockResolvedValue(null)
    const getSeason = spyOn(retriever, 'getSeasonDetails').mockImplementation(async (_id, season) => ({
      episodes: [{ episode_number: 1, name: `Episode ${season}`, overview: '' }]
    }))

    try {
      const episode1 = 'Orbit/Season 01/Orbit.S01E01.mkv'
      const episode2 = 'Orbit/Season 02/Orbit.S02E01.mkv'
      const feature = 'Feature.mkv'
      for (const file of [episode1, episode2, feature]) {
        const filePath = path.join(fixture, file)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, 'before')
      }
      await scan()
      const idFor = (file: string) => itemIdForSourcePath(source.id, file)!
      const show = idFor('Orbit')
      const movie = idFor(feature)
      const season1 = idFor('Orbit/Season 01')
      const season2 = idFor('Orbit/Season 02')
      const providerFacts = {
        title: 'Fixture', originalTitle: null, overview: null, releaseDate: null,
        year: null, runtime: null, genres: [], artwork: {}, metadata: {}
      }
      saveProviderMatch(show, 'tmdb', { id: 101, type: 'tv' }, providerFacts)
      saveProviderMatch(movie, 'tmdb', { id: 102, type: 'movie' }, providerFacts)
      upsertMetadata(show, { tmdbId: 101, mediaType: 'tv', lastRefreshedAt: 1 })
      upsertMetadata(movie, { tmdbId: 102, mediaType: 'movie', lastRefreshedAt: 1 })
      for (const [number, folder, file] of [[1, season1, episode1], [2, season2, episode2]] as const) {
        upsertMetadata(folder, { mediaType: 'season', seasonNumber: number, lastRefreshedAt: 1 })
        upsertMetadata(idFor(file), { mediaType: 'episode', seasonNumber: number, episodeNumber: 1 })
      }

      readSettings.mockResolvedValue({ ...settings, tmdbApiKey: 'fixture-key' })
      await scan()
      expect(getDetails).toHaveBeenCalledTimes(0)

      await fs.appendFile(path.join(fixture, episode1), 'change')
      await fs.utimes(path.join(fixture, feature), 1_800_000_000, 1_800_000_000)
      getSeason.mockResolvedValueOnce(null)
      await scan()
      expect(getDetails.mock.calls.map(([id]) => id).sort()).toEqual([101, 102])
      expect(getDetails.mock.calls.find(([id]) => id === 101)?.[3]).toContain('content_ratings')
      expect(findItems({ where: { id: show }, fields: ['tmdbMetadata'] })[0].tmdbMetadata).toMatchObject({
        status: 'Returning Series',
        nextAirDate: '2030-01-02'
      })
      expect(getSeason.mock.calls.map(([, season]) => season)).toEqual([1])
      expect(getItemById(movie)?.title).toBe('Feature Refreshed')
      expect([...getFileChangeRevisions([show, season1, season2, movie]).keys()].sort())
        .toEqual([season1, show].sort())

      getDetails.mockClear()
      getSeason.mockClear()
      await scan()
      expect(getDetails.mock.calls.map(([id]) => id)).toEqual([101])
      expect(getSeason.mock.calls.map(([, season]) => season)).toEqual([1])
      expect(getItemById(idFor(episode1))?.title).toBe('Episode 1')
      expect(getFileChangeRevisions([show, season1, season2, movie]).size).toBe(0)
      expect(getItemById(season2)?.lastRefreshedAt).toBe(1)

      getDetails.mockClear()
      getSeason.mockClear()
      await fs.appendFile(path.join(fixture, episode2), 'disabled')
      await scan(false)
      await scan()
      expect(getDetails).toHaveBeenCalledTimes(0)
      expect(getSeason).toHaveBeenCalledTimes(0)
    } finally {
      getSeason.mockRestore()
      getCredits.mockRestore()
      getDetails.mockRestore()
      readSettings.mockRestore()
      log.mockRestore()
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })

  it('backfills previously matched titles once, fetching supplemental details without artwork or credits', async () => {
    ctx.seedItems([
      { id: 'root', type: 'folder' },
      { id: 'movie', parentId: 'root', name: 'Original.mkv' },
      { id: 'edition', parentId: 'root', name: 'Edition.mkv' }
    ])
    for (const id of ['movie', 'edition']) {
      saveProviderMatch(id, 'tmdb', { id: 34, type: 'movie' })
      upsertMetadata(id, { title: 'Library title', tmdbId: 34, mediaType: 'movie', lastRefreshedAt: 1 })
    }
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const settings = await settingsService.readSettings()
    const readSettings = spyOn(settingsService, 'readSettings').mockResolvedValue({ ...settings, tmdbApiKey: 'fixture-key' })
    const getDetails = spyOn(retriever, 'getDetails').mockResolvedValue({
      title: 'Provider title',
      vote_average: 8.3,
      vote_count: 21,
      release_dates: { results: [
        { iso_3166_1: 'GB', release_dates: [{ type: 3, certification: '12A' }] },
        { iso_3166_1: 'US', release_dates: [
          { type: 1, certification: 'R' }, { type: 3, certification: 'PG-13' }
        ] }
      ] },
      external_ids: { imdb_id: 'tt1234' },
      homepage: 'javascript:alert(1)',
      production_companies: [{ name: 'Studio One' }, { name: 'Studio One' }]
    })
    const getCredits = spyOn(retriever, 'getCredits').mockResolvedValue(null)

    try {
      await metadataService.enrichDatabase()
      await metadataService.enrichDatabase()
      expect(getDetails.mock.calls).toEqual([[34, 'movie', 'fixture-key', 'external_ids,release_dates']])
      expect(getCredits).toHaveBeenCalledTimes(0)
      const editions = findItems({ where: { parentId: 'root' }, fields: ['title', 'tmdbMetadata'] })
      expect(editions).toHaveLength(2)
      for (const edition of editions) {
        expect(edition.title).toBe('Library title')
        expect(edition.tmdbMetadata).toMatchObject({
          contentRating: 'PG-13', tmdbRating: 8.3, imdbId: 'tt1234', studios: ['Studio One']
        })
        expect(edition.tmdbMetadata?.homepage).toBeUndefined()
      }
    } finally {
      getCredits.mockRestore()
      getDetails.mockRestore()
      readSettings.mockRestore()
      log.mockRestore()
    }
  })

  it('refreshes the facts of a show whose next air date has passed, and leaves upcoming and undated shows alone', async () => {
    ctx.seedItems([
      { id: 'root', type: 'folder' },
      { id: 'aired', parentId: 'root', type: 'folder', name: 'Aired' },
      { id: 'upcoming', parentId: 'root', type: 'folder', name: 'Upcoming' },
      { id: 'ended', parentId: 'root', type: 'folder', name: 'Ended' }
    ])
    const shows = { aired: [51, '2001-01-01'], upcoming: [52, '2999-01-01'], ended: [53, null] } as const
    for (const [id, [tmdbId, nextAirDate]] of Object.entries(shows)) {
      saveProviderMatch(id, 'tmdb', { id: tmdbId, type: 'tv' })
      upsertMetadata(id, { title: 'Library title', tmdbId, mediaType: 'tv', lastRefreshedAt: 1 })
      ctx.db.prepare("UPDATE media_entities SET tmdb_display_json = '{}', tmdb_next_air_date = ? WHERE tmdb_id = ?")
        .run(nextAirDate, tmdbId)
    }
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const settings = await settingsService.readSettings()
    const readSettings = spyOn(settingsService, 'readSettings').mockResolvedValue({ ...settings, tmdbApiKey: 'fixture-key' })
    const getDetails = spyOn(retriever, 'getDetails').mockResolvedValue({
      name: 'Provider title', status: 'Returning Series', next_episode_to_air: { air_date: '2999-06-01' }
    })
    const getCredits = spyOn(retriever, 'getCredits').mockResolvedValue(null)
    const getSeason = spyOn(retriever, 'getSeasonDetails').mockResolvedValue(null)

    try {
      await metadataService.enrichDatabase()
      await metadataService.enrichDatabase()
      expect(getDetails.mock.calls.map(([id, type]) => [id, type])).toEqual([[51, 'tv']])
      expect(getSeason).toHaveBeenCalledTimes(0)
      const [aired] = findItems({ where: { id: 'aired' }, fields: ['title', 'tmdbMetadata'] })
      expect(aired.title).toBe('Library title')
      expect(aired.tmdbMetadata).toMatchObject({ nextAirDate: '2999-06-01', status: 'Returning Series' })
    } finally {
      getSeason.mockRestore()
      getCredits.mockRestore()
      getDetails.mockRestore()
      readSettings.mockRestore()
      log.mockRestore()
    }
  })

  it('rescans one folder by item or by path and leaves the rest of the source alone', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-scoped-scan-'))
    const source = { id: 'scoped-source', path: root, isRelative: false }
    const sourcePaths = new Map([[source.id, root]])
    const write = async (file: string) => {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await fs.writeFile(path.join(root, file), file)
    }
    const enriched: string[][] = []
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const enrichItems = spyOn(metadataService, 'enrichItems')
      .mockImplementation(async (itemIds: Iterable<string>) => { enriched.push(pathsForItemIds(itemIds)) })
    const enrichDatabase = spyOn(metadataService, 'enrichDatabase').mockImplementation(async () => {})
    const scan = (scope?: Map<string, string>) =>
      runLibraryScan({ sources: [source], sourcePaths, scope, runEarlyMaintenance: false })

    try {
      await write('A/keep.mkv'); await write('A/gone.mkv'); await write('B/first.mkv')
      await scan()

      await write('A/added.mkv'); await write('B/unseen.mkv'); await write('New/Deep/film.mkv')
      await fs.rm(path.join(root, 'A/gone.mkv'))

      // By item: a file stands for its folder.
      const byItem = await resolveScanScope({ itemId: itemIdForSourcePath(source.id, 'A/keep.mkv')! }, sourcePaths)
      expect([...byItem]).toEqual([[source.id, 'A']])
      await scan(byItem)
      expect(['A/added.mkv', 'A/gone.mkv', 'A/keep.mkv', 'B/unseen.mkv', 'New/Deep/film.mkv']
        .map((file) => itemIdForSourcePath(source.id, file) !== null)).toEqual([true, false, true, false, false])
      // The folder, its files and the source root above them are enriched. Other folders are not.
      expect(enriched.at(-1)).toEqual(['.', 'A', 'A/added.mkv', 'A/keep.mkv'])

      // By path: the scan starts at the highest folder the library has yet to see, so the new branch is linked.
      const byPath = await resolveScanScope({ path: path.join(root, 'New/Deep/film.mkv') }, sourcePaths)
      expect([...byPath]).toEqual([[source.id, 'New']])
      await scan(byPath)
      const parentOf = (file: string) => (ctx.db.prepare('SELECT parent_item_id AS id FROM media_items WHERE id = ?')
        .get(itemIdForSourcePath(source.id, file)) as { id: string }).id
      expect(parentOf('New/Deep/film.mkv')).toBe(itemIdForSourcePath(source.id, 'New/Deep')!)
      expect(parentOf('New')).toBe(itemIdForSourcePath(source.id, '.')!)
      expect(itemIdForSourcePath(source.id, 'B/unseen.mkv')).toBeNull()

      await expect(resolveScanScope({ itemId: 'unknown' }, sourcePaths)).rejects.toThrow('Item not found.')
      await expect(resolveScanScope({ path: os.tmpdir() }, sourcePaths)).rejects.toThrow('outside the media sources')
      await expect(resolveScanScope({ path: path.join(root, 'missing') }, sourcePaths)).rejects.toThrow('does not exist')
    } finally {
      enrichDatabase.mockRestore()
      enrichItems.mockRestore()
      log.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('starts targeted enrichment early without blocking the next source scan', async () => {
    const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-fast-source-'))
    const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-slow-source-'))

    const sourceA = { id: 'fast-source', path: tmpA, isRelative: false }
    const sourceB = { id: 'slow-source', path: tmpB, isRelative: false }

    const events: Array<
      | { kind: 'targeted'; slowFileScanned: boolean; paths: string[] }
      | { kind: 'final' }
    > = []

    const pendingMetadata = Promise.withResolvers<void>()
    const secondSourceScanned = Promise.withResolvers<void>()
    const scanDirectory = filesystemService.scanDirectory
    const scanSpy = spyOn(filesystemService, 'scanDirectory').mockImplementation(async (...args) => {
      const result = await scanDirectory(...args)
      if (args[0].id === sourceB.id) secondSourceScanned.resolve()
      return result
    })
    const enrichItemsSpy = spyOn(metadataService, 'enrichItems').mockImplementation(async (itemIds: Iterable<string>) => {
      const slowFile = ctx.db
        .prepare("SELECT 1 FROM media_locations WHERE source_id = ? AND relative_path = 'slow.mkv'")
        .get(sourceB.id)
      events.push({
        kind: 'targeted',
        slowFileScanned: !!slowFile,
        paths: pathsForItemIds(itemIds)
      })
      if (!slowFile) await pendingMetadata.promise
    })
    const enrichDatabaseSpy = spyOn(metadataService, 'enrichDatabase').mockImplementation(async () => {
      events.push({ kind: 'final' })
    })

    try {
      await fs.writeFile(path.join(tmpA, 'fast.mkv'), 'fast')
      await fs.writeFile(path.join(tmpB, 'slow.mkv'), 'slow')

      const scan = runLibraryScan({
        sources: [sourceA, sourceB],
        sourcePaths: new Map([
          [sourceA.id, tmpA],
          [sourceB.id, tmpB]
        ]),
        runEarlyMaintenance: true
      })

      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          secondSourceScanned.promise,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Second source waited for metadata')), 1_500)
          })
        ])
        expect(itemIdForSourcePath(sourceB.id, 'slow.mkv')).not.toBeNull()
        expect(events).toHaveLength(1)
      } finally {
        clearTimeout(timeout)
        pendingMetadata.resolve()
        await scan
      }

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
      scanSpy.mockRestore()
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

      await runLibraryScan({
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

      await runLibraryScan({
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

      await runLibraryScan({
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

      await runLibraryScan({
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
        JOIN media_locations ml ON ml.item_id = mi.id AND ml.is_present = 1
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
