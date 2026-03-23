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
import { setImage, removeImage } from './metadata.service'
import { syncTvShowStructure } from './tv-show.service'
import { updateIfChangedAndBroadcast } from './item-update.service'
import { getItemById } from './repository.service'
import { setLibraryDataPath } from './paths.service'
import { applyGrouping } from './grouping.service'
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
      `SELECT id FROM items WHERE parent_id = 'root' AND is_virtual = 1`
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
