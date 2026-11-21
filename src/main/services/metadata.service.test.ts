/**
 * Metadata Service Tests — Custom Artwork Upload
 *
 * Integration tests for setImage / removeImage with buffer-based uploads
 * (the "Upload File" button in the artwork modal).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { setImage, removeImage, clearItemMetadata, fetchAndApplyMetadata } from './metadata.service'
import type { MetadataProvider } from './metadata-provider'
import { findByFtsQuery } from '../database/repositories/search.repo'
import { upsertMetadata } from '../database/repositories/metadata.repo'
import { syncTvShowStructure } from './tv-show.service'
import { updateIfChangedAndBroadcast } from './item-update.service'
import { find, getItemById } from './repository.service'
import { setLibraryDataPath } from './paths.service'
import { applyGrouping, syncVirtualSeasonFolders } from './grouping.service'
import type { MediaFolder } from '@shared/types'

let ctx: ServiceTestContext
let tmpDir: string

beforeEach(async () => {
  ctx = createServiceTestContext()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kinome-test-'))
  // Create the images subdirectory
  await fs.mkdir(path.join(tmpDir, 'images'), { recursive: true })
  setLibraryDataPath(tmpDir)
})

afterEach(async () => {
  ctx.cleanup()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/** Helper: create a small valid PNG buffer */
function fakePngBuffer(): Buffer {
  // Minimal PNG: 1x1 transparent pixel
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
    'Nl7BcQAAAABJRU5ErkJggg==',
    'base64'
  )
}

it('shares provider facts while materializing and clearing metadata per item', async () => {
  ctx.seedItems([{ id: 'edition-1' }, { id: 'edition-2' }])
  upsertMetadata('edition-1', {
    title: 'Personal Title',
    genres: ['Custom Genre'],
    lockedFields: ['title', 'genres'],
    tags: { accepted: 'yes' },
  })
  await setImage('edition-1', 'poster', { type: 'local', buffer: fakePngBuffer(), originalName: 'one.png' })

  const provider: MetadataProvider = {
    name: 'fixture',
    match: async () => ({ id: 51, type: 'movie' }),
    details: async () => ({
      title: 'Provider Movie',
      originalTitle: 'Original Movie',
      overview: 'Searchable description',
      releaseDate: '2020-01-01',
      year: 2020,
      runtime: 110,
      genres: ['Drama'],
      artwork: {},
    }),
    credits: async () => ({ cast: [{ id: 23, name: 'Example Actor', profile_path: null }], crew: [] }),
    episodes: async () => null,
  }
  for (const id of ['edition-1', 'edition-2']) {
    await fetchAndApplyMetadata(getItemById(id)!, { provider })
  }

  const matches = ctx.db.prepare(`
    SELECT DISTINCT e.id, e.title FROM media_items i JOIN media_entities e ON i.entity_id = e.id
  `).all() as { id: string; title: string }[]
  expect(matches).toHaveLength(1)
  expect(matches[0].title).toBe('Provider Movie')
  expect(getItemById('edition-1')).toMatchObject({
    title: 'Personal Title', genres: ['Custom Genre'], posterPath: 'edition-1.png',
  })
  expect(getItemById('edition-2')).toMatchObject({ title: 'Provider Movie', genres: ['Drama'], posterPath: null })
  expect(find({ where: { genre: 'Custom Genre' }, fields: ['id'] }).map(({ id }) => id)).toEqual(['edition-1'])
  expect(findByFtsQuery('Personal', [], 10).map(({ id }) => id)).toEqual(['edition-1'])

  await clearItemMetadata('edition-1')
  expect(getItemById('edition-1')).toMatchObject({ title: null, tags: { accepted: 'yes' } })
  expect(getItemById('edition-2')).toMatchObject({ title: 'Provider Movie', genres: ['Drama'] })
  expect(ctx.db.prepare('SELECT title FROM media_entities WHERE id = ?').get(matches[0].id))
    .toEqual({ title: 'Provider Movie' })
  expect(findByFtsQuery('Personal', [], 10)).toEqual([])
})

describe('setImage — buffer upload', () => {
  it('saves a poster from a buffer for a real file item', async () => {
    ctx.seedEntities([{ id: 'e1', mediaType: 'movie', title: 'Test Movie' }])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'movie1', parentId: 'root', type: 'file', entityId: 'e1' }
    ])

    const result = await setImage('movie1', 'poster', {
      type: 'local',
      buffer: fakePngBuffer(),
      originalName: 'my-poster.png'
    } as any)

    expect(result).not.toBeNull()
    expect(result!.posterPath).toMatch(/movie1.*\.png$/)

    // File should exist on disk
    const filePath = path.join(tmpDir, 'images', result!.posterPath!)
    const stat = await fs.stat(filePath)
    expect(stat.size).toBeGreaterThan(0)
  })

  it('saves a backdrop from a buffer for a real file item', async () => {
    ctx.seedEntities([{ id: 'e1', mediaType: 'movie', title: 'Test Movie' }])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'movie1', parentId: 'root', type: 'file', entityId: 'e1' }
    ])

    const result = await setImage('movie1', 'backdrop', {
      type: 'local',
      buffer: fakePngBuffer(),
      originalName: 'custom-backdrop.jpg'
    } as any)

    expect(result).not.toBeNull()
    expect(result!.backdropPath).toMatch(/movie1-backdrop.*\.jpg$/)

    const filePath = path.join(tmpDir, 'images', result!.backdropPath!)
    const stat = await fs.stat(filePath)
    expect(stat.size).toBeGreaterThan(0)
  })

  it('saves a logo from a buffer for a real file item', async () => {
    ctx.seedEntities([{ id: 'e1', mediaType: 'movie', title: 'Test Movie' }])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'movie1', parentId: 'root', type: 'file', entityId: 'e1' }
    ])

    const result = await setImage('movie1', 'logo', {
      type: 'local',
      buffer: fakePngBuffer(),
      originalName: 'logo.svg'
    } as any)

    expect(result).not.toBeNull()
    expect(result!.logoPath).toMatch(/movie1-logo.*\.svg$/)

    const filePath = path.join(tmpDir, 'images', result!.logoPath!)
    const stat = await fs.stat(filePath)
    expect(stat.size).toBeGreaterThan(0)
  })

  it('saves a poster from a buffer for a virtual grouping folder', async () => {
    ctx.seedEntities([
      { id: 'e1', mediaType: 'movie', title: 'Spirited Away' },
      { id: 'e2', mediaType: 'movie', title: 'The Godfather' }
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'movie1', parentId: 'root', type: 'file', entityId: 'e1' },
      { id: 'movie2', parentId: 'root', type: 'file', entityId: 'e2' }
    ])
    ctx.seedGenres('e1', ['Animation'])
    ctx.seedGenres('e2', ['Crime'])

    // Create grouping virtual folders
    applyGrouping('root', 'genre')

    // Find the Animation virtual folder
    const groups = ctx.db.prepare(
      `SELECT id FROM media_items WHERE parent_item_id = 'root' AND is_virtual = 1`
    ).all() as { id: string }[]
    expect(groups.length).toBeGreaterThan(0)

    const animationFolder = groups[0]

    const result = await setImage(animationFolder.id, 'poster', {
      type: 'local',
      buffer: fakePngBuffer(),
      originalName: 'animation-poster.png'
    } as any)

    expect(result).not.toBeNull()
    expect(result!.posterPath).toMatch(/\.png$/)

    // File should exist on disk
    const filePath = path.join(tmpDir, 'images', result!.posterPath!)
    const stat = await fs.stat(filePath)
    expect(stat.size).toBeGreaterThan(0)
  })

  it('saves a backdrop for a real folder', async () => {
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' }
    ])

    const result = await setImage('root', 'backdrop', {
      type: 'local',
      buffer: fakePngBuffer(),
      originalName: 'folder-backdrop.jpg'
    } as any)

    expect(result).not.toBeNull()
    expect(result!.backdropPath).toMatch(/root-backdrop.*\.jpg$/)

    const filePath = path.join(tmpDir, 'images', result!.backdropPath!)
    const stat = await fs.stat(filePath)
    expect(stat.size).toBeGreaterThan(0)
  })

  it('updates _v for cache busting after upload', async () => {
    ctx.seedEntities([{ id: 'e1', mediaType: 'movie', title: 'Test' }])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'movie1', parentId: 'root', type: 'file', entityId: 'e1' }
    ])

    const before = getItemById('movie1')
    const vBefore = before?._v ?? 0

    const result = await setImage('movie1', 'poster', {
      type: 'local',
      buffer: fakePngBuffer(),
      originalName: 'poster.png'
    } as any)

    expect(result).not.toBeNull()
    expect(result!._v).toBeGreaterThan(vBefore)
  })
})

describe('TV show structural sync — background processing (no user context)', () => {
  it('does not throw when synced season items (which have watched=null from CORE_FIELDS) are passed to updateIfChangedAndBroadcast', async () => {
    // Regression: watched is in CORE_FIELDS, so items fetched via find() without a userId
    // have watched=null (1=0 JOIN returns NULL). _updateItem sees null !== undefined and
    // throws "userId required when updating user state fields". This broke Phase 2 enrichment
    // for all TV shows after the multi-account refactor.
    ctx.seedEntities([{ id: 'e-show', mediaType: 'tv', title: 'Smiling Friends' }])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      // The show has mediaType: tv so syncTvShowStructure will process it
      { id: 'show-1', parentId: 'root', type: 'folder', entityId: 'e-show', name: 'Smiling Friends' },
      // Season folder has no mediaType yet — sync will assign mediaType='season', making it "modified"
      { id: 'season-1', parentId: 'show-1', type: 'folder', name: 'Season 01' }
    ])

    const show = getItemById('show-1') as MediaFolder
    // syncTvShowStructure internally calls getChildren() without userId, returning items with watched=null
    const modified = await syncTvShowStructure(show)

    // The season was recognized and assigned mediaType='season', so it is in modified
    expect(modified.length).toBeGreaterThan(0)

    // Phase 2 enrichment calls updateIfChangedAndBroadcast(allModifiedItems) — no userId.
    // This must NOT throw even though modified[0].watched === null.
    await expect(
      updateIfChangedAndBroadcast(modified)
    ).resolves.toBeUndefined()
  })
})

describe('clearItemMetadata — virtual season folder cleanup', () => {
  it('preserves folder settings when clearing metadata for the folder itself', async () => {
    ctx.seedEntities([{ id: 'e-show', mediaType: 'tv', title: 'Configured Show' }])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'show', parentId: 'root', type: 'folder', entityId: 'e-show', name: 'Configured Show' },
    ])
    ctx.seedFolderSettings([
      {
        itemId: 'show',
        folderSettings: {
          retrieveChildrenMetadata: true,
          childrenTypeHint: 'tv',
          processTvChildren: false,
        },
      },
    ])

    await clearItemMetadata('show', {})

    const settings = ctx.db.prepare(`
      SELECT retrieve_children_metadata, children_type_hint, process_tv_children
      FROM folder_settings
      WHERE item_id = ?
    `).get('show') as any

    expect(settings).toEqual({
      retrieve_children_metadata: 1,
      children_type_hint: 'tv',
      process_tv_children: 0,
    })
  })

  it('preserves descendant folder settings when clearing metadata children-only', async () => {
    ctx.seedEntities([
      { id: 'e-root', mediaType: 'tv', title: 'Parent Show' },
      { id: 'e-season', mediaType: 'season', seasonNumber: 1 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'show', parentId: 'root', type: 'folder', entityId: 'e-root', name: 'Parent Show' },
      { id: 'season', parentId: 'show', type: 'folder', entityId: 'e-season', name: 'Season 01' },
    ])
    ctx.seedFolderSettings([
      {
        itemId: 'season',
        folderSettings: {
          retrieveChildrenMetadata: true,
          childrenTypeHint: 'tv',
          processTvChildren: false,
        },
      },
    ])

    await clearItemMetadata('show', { childrenOnly: true })

    const settings = ctx.db.prepare(`
      SELECT retrieve_children_metadata, children_type_hint, process_tv_children
      FROM folder_settings
      WHERE item_id = ?
    `).get('season') as any

    expect(settings).toEqual({
      retrieve_children_metadata: 1,
      children_type_hint: 'tv',
      process_tv_children: 0,
    })
  })

  it('removes virtual season folders when clearing a tv show', async () => {
    ctx.seedEntities([
      { id: 'e-show', mediaType: 'tv', title: 'Some Show' },
      { id: 'e-ep1', mediaType: 'episode', seasonNumber: 1, episodeNumber: 1 },
      { id: 'e-ep2', mediaType: 'episode', seasonNumber: 1, episodeNumber: 2 },
    ])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'show', parentId: 'root', type: 'folder', entityId: 'e-show', name: 'Some Show' },
      { id: 'ep1', parentId: 'show', type: 'file', entityId: 'e-ep1', name: 'S01E01.mkv' },
      { id: 'ep2', parentId: 'show', type: 'file', entityId: 'e-ep2', name: 'S01E02.mkv' },
    ])
    syncVirtualSeasonFolders('show')

    const before = find({ where: { parentId: 'show' }, rawConditions: ["virtual_type = 'season'"] })
    expect(before.length).toBe(1)

    await clearItemMetadata('show', {})

    const after = find({ where: { parentId: 'show' }, rawConditions: ["virtual_type = 'season'"] })
    expect(after.length).toBe(0)
  })
})

describe('removeImage', () => {
  it('clears the posterPath after removal', async () => {
    ctx.seedEntities([{ id: 'e1', mediaType: 'movie', title: 'Test' }])
    ctx.seedItems([
      { id: 'root', parentId: null, type: 'folder' },
      { id: 'movie1', parentId: 'root', type: 'file', entityId: 'e1' }
    ])

    // First set an image via buffer
    await setImage('movie1', 'poster', {
      type: 'local',
      buffer: fakePngBuffer(),
      originalName: 'poster.png'
    } as any)

    // Then remove it
    const result = await removeImage('movie1', 'poster')
    expect(result).not.toBeNull()
    expect(result!.posterPath).toBeNull()
  })
})

describe('automatic title identification', () => {
  function providerFixture() {
    const calls: unknown[][] = []
    const details: number[] = []
    const provider: MetadataProvider = {
      name: 'fixture',
      async match(query, type, year, alternate) {
        calls.push([query, type, year, alternate])
        return { id: 82, type: type === 'tv' ? 'tv' : 'movie' }
      },
      async details({ id }) {
        details.push(id)
        return {
          title: 'The Thing', originalTitle: 'The Thing', overview: null, releaseDate: '1982-06-25',
          year: 1982, runtime: null, genres: [], artwork: {}
        }
      },
      async credits() { return null },
      async episodes() { return null },
    }
    return { provider, calls, details }
  }

  it('passes the cleaned title and year to the provider while preserving path and item identity', async () => {
    const name = 'The.Thing.1982.2160p.UHD.BluRay.REMUX-GRP.mkv'
    ctx.seedItems([{ id: 'feature', name, path: name }])
    const { provider, calls } = providerFixture()
    await fetchAndApplyMetadata(getItemById('feature')!, { provider })
    expect(calls).toEqual([['The Thing', 'movie', 1982, undefined]])
    expect(getItemById('feature')).toMatchObject({ id: 'feature', name, title: 'The Thing', year: 1982, tmdbId: 82 })
  })

  it('uses a typed explicit ID with one details request and no text search', async () => {
    ctx.seedItems([{ id: 'feature', name: 'The Thing (1982) [tmdbid-1091].mkv' }])
    const { provider, calls, details } = providerFixture()
    await fetchAndApplyMetadata(getItemById('feature')!, { provider })
    expect(calls).toEqual([])
    expect(details).toEqual([1091])
    expect(getItemById('feature')?.tmdbId).toBe(1091)
  })

  it('keeps a loose episode ID out of typed movie lookup', async () => {
    ctx.seedItems([{ id: 'loose', name: 'Dark.S02E05.[tmdbid-95327].mkv' }])
    const { provider, calls, details } = providerFixture()
    await fetchAndApplyMetadata(getItemById('loose')!, { provider })
    expect(calls).toEqual([['Dark S02E05', 'movie', undefined, undefined]])
    expect(details).toEqual([82])
  })

  it('uses the title when local IDs conflict or a folder type is unknown', async () => {
    ctx.seedItems([
      { id: 'feature', name: 'The Thing (1982) [tmdbid-1091] {tmdbid=800}.mkv' },
      { id: 'folder', type: 'folder', name: 'The Thing (1982) [tmdbid-1091]' }
    ])
    const { provider, calls } = providerFixture()
    for (const id of ['feature', 'folder']) await fetchAndApplyMetadata(getItemById(id)!, { provider })
    expect(calls).toEqual([['The Thing', 'movie', 1982, undefined], ['The Thing', 'multi', 1982, undefined]])
  })

  it.each([
    ['Release', ['The.Thing.1982.1080p.BluRay.mkv', 'Sample.1080p.mkv', 'The Thing-trailer.mkv'], [['The Thing', 'movie', 1982, undefined]]],
    ['Release', ['The.Thing.1982.1080p.BluRay.mkv', 'The.Thing.1982.2160p.BluRay.mkv'], [['The Thing', 'movie', 1982, undefined]]],
    ['Release', ['The.Thing.1982.1080p.BluRay.mkv', 'The.Thing.2011.2160p.BluRay.mkv'], []],
    ['Release', ['The.Thing.1982.1080p.BluRay.mkv', 'Alien (1979).mkv'], []],
    ['Release', ['Sample.1080p.mkv', 'Dark.S01E03.mkv'], []],
    ['Organized Feature (1993)', ['Alien (1979).mkv'], [['Organized Feature', 'multi', 1993, undefined]]]
  ] as [string, string[], unknown[][]][])('uses the containing folder and only falls back to consistent features (%s / %j)', async (name, files, expected) => {
    ctx.seedItems([
      { id: 'folder', type: 'folder', name },
      ...files.map((file, i) => ({ id: `file-${i}`, parentId: 'folder', name: file }))
    ])
    const { provider, calls } = providerFixture()
    await fetchAndApplyMetadata(getItemById('folder')!, { provider })
    expect(calls).toEqual(expected)
  })

  it('keeps the normal lookup eligibility for already-attempted items and respects type locks', async () => {
    ctx.seedItems([{ id: 'attempted', name: 'The Thing (1982).mkv' }, { id: 'locked', name: 'The Thing (1982).mkv' }])
    upsertMetadata('attempted', { lastRefreshedAt: 123 })
    upsertMetadata('locked', { mediaType: null, lockedFields: ['mediaType'] })
    const { provider, calls, details } = providerFixture()
    for (const id of ['attempted', 'locked']) await fetchAndApplyMetadata(getItemById(id)!, { provider })
    expect(calls).toEqual([])
    expect(details).toEqual([])
  })
})
