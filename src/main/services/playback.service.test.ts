import { expect, it } from 'bun:test'
import { createServiceTestContext } from '../database/test-helpers'
import { createAccount } from '../database/repositories/account.repo'
import { setFilterRule } from '../database/repositories/account-filter.repo'
import { runWithAccount } from '../request-context'
import { generateM3UPlaylist, generatePlaylist } from './playback.service'

it('continues an external playlist through later episodes and seasons of the same show', async () => {
  const ctx = createServiceTestContext()
  try {
    ctx.seedEntities([
      { id: 'tv', mediaType: 'tv' },
      { id: 's2', mediaType: 'season', seasonNumber: 2 },
      { id: 's3', mediaType: 'season', seasonNumber: 3 },
      { id: 's2e1', mediaType: 'episode', seasonNumber: 2, episodeNumber: 1 },
      { id: 's2e2', mediaType: 'episode', seasonNumber: 2, episodeNumber: 2 },
      { id: 's2e25', mediaType: 'episode', seasonNumber: 2, episodeNumber: 2.5 },
      { id: 's3e1', mediaType: 'episode', seasonNumber: 3, episodeNumber: 1 },
      { id: 's3e2', mediaType: 'episode', seasonNumber: 3, episodeNumber: 2 },
      { id: 's3e3', mediaType: 'episode', seasonNumber: 3, episodeNumber: 3 },
      { id: 's4e1', mediaType: 'episode', seasonNumber: 4, episodeNumber: 1 },
    ])
    ctx.seedItems([
      { id: 'show', type: 'folder', entityId: 'tv' },
      { id: 'other-show', type: 'folder', entityId: 'tv' },
      { id: 'season-2', type: 'folder', parentId: 'show', entityId: 's2' },
      { id: 'season-3', type: 'folder', parentId: 'show', entityId: 's3' },
      { id: 'earlier', parentId: 'season-2', entityId: 's2e1' },
      { id: 'recap', parentId: 'season-2', entityId: 's2e25' },
      { id: 'start', parentId: 'season-2', entityId: 's2e2', name: 'Episode 2.mkv' },
      { id: 'extra', parentId: 'season-2' },
      { id: 'missing', parentId: 'season-3', entityId: 's3e1', isMissing: 1 },
      { id: 'hidden', parentId: 'season-3', entityId: 's3e2', isHidden: 1 },
      { id: 'next-season', parentId: 'season-3', entityId: 's3e3', sourceId: 'second-drive' },
      { id: 'loose-episode', parentId: 'show', entityId: 's4e1' },
      { id: 'unrelated', parentId: 'other-show', entityId: 's3e1' }
    ])

    const playlist = await generateM3UPlaylist('start.m3u', 'localhost:3000', 'http:', 'example-token')
    const urls = playlist?.split('\n').filter((line) => line.startsWith('http:')).map((line) => new URL(line))
    expect(urls?.map((url) => url.pathname.split('/')[3])).toEqual([
      'start', 'recap', 'next-season', 'loose-episode'
    ])
    expect(urls?.map((url) => url.search)).toEqual(Array(4).fill('?token=example-token&watch=1'))
    expect(urls?.[0].pathname).toBe('/api/stream/start/Episode%202.mkv')

    createAccount('restricted', 'restricted', 'unused', 'normal')
    setFilterRule('restricted', 'deny', { conditions: [{ field: 'sourceId', op: 'eq', value: 'second-drive' }] })
    const restricted = await runWithAccount('restricted', () => generatePlaylist('start'))
    expect(restricted.map(({ id }) => id)).toEqual(['start', 'recap', 'loose-episode'])
    expect(await runWithAccount('restricted', () => generatePlaylist('next-season'))).toEqual([])
  } finally {
    ctx.cleanup()
  }
})

it.each([false, true])('keeps unclassified files in their current folder (TV ancestor: %s)', async (knownShow) => {
  const ctx = createServiceTestContext()
  try {
    ctx.seedEntities([{ id: 'tv', mediaType: 'tv' }])
    ctx.seedItems([
      { id: 'collection', type: 'folder', entityId: knownShow ? 'tv' : null },
      { id: 'folder', type: 'folder', parentId: 'collection' },
      { id: 'next-folder', type: 'folder', parentId: 'collection' },
      { id: 'last', parentId: 'folder', name: 'Video 10.mkv' },
      { id: 'first', parentId: 'folder', name: 'Video 1.mkv' },
      { id: 'start', parentId: 'folder', name: 'Video 2.mkv' },
      { id: 'missing', parentId: 'folder', name: 'Video 3.mkv', isMissing: 1 },
      { id: 'outside', parentId: 'next-folder', name: 'Video 11.mkv' }
    ])
    const playlist = await generateM3UPlaylist('start.m3u', 'localhost:3000', 'http:')
    const paths = playlist?.split('\n')
      .filter((line) => line.startsWith('http:'))
      .map((line) => new URL(line).pathname)
    expect(paths).toEqual(['/api/stream/start/Video%202.mkv', '/api/stream/last/Video%2010.mkv'])
  } finally {
    ctx.cleanup()
  }
})
