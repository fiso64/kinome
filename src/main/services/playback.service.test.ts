import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServiceTestContext } from '../database/test-helpers'
import { createAccount } from '../database/repositories/account.repo'
import { setFilterRule } from '../database/repositories/account-filter.repo'
import { runWithAccount } from '../request-context'
import { generateM3UPlaylist, generatePlaylist, handleFileStreamFast } from './playback.service'
import { prepareHlsPlaylist } from './transcoding.service'

describe('direct media streaming', () => {
  let directory: string
  let file: Bun.BunFile

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kinome-range-'))
    const filePath = join(directory, 'video.mp4')
    await Bun.write(filePath, '0123456789')
    file = Bun.file(filePath)
  })

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it.each([
    [null, 200, null, '0123456789'],
    ['bytes=2-4', 206, 'bytes 2-4/10', '234'],
    ['bytes=6-', 206, 'bytes 6-9/10', '6789'],
    ['bytes=-3', 206, 'bytes 7-9/10', '789'],
    ['bytes=-20', 206, 'bytes 0-9/10', '0123456789'],
    ['bytes=8-999999999999999999999', 206, 'bytes 8-9/10', '89'],
    ['bytes=10-', 416, 'bytes */10', ''],
    ['bytes=-0', 416, 'bytes */10', ''],
    ['bytes=9-8', 200, null, '0123456789'],
    ['bytes=0-1,4-5', 200, null, '0123456789'],
    ['frames=0-1', 200, null, '0123456789']
  ])('serves direct media for Range %s', async (range, status, contentRange, body) => {
    const response = handleFileStreamFast(file, file.size, 'video/mp4', range)
    expect(response.status).toBe(status)
    expect(response.headers.get('Content-Range')).toBe(contentRange)
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    if (status !== 416) expect(response.headers.get('Content-Length')).toBe(String(body.length))
    expect(await response.text()).toBe(body)
  })

  it('returns full representation headers and no body for a HEAD request with Range', () => {
    const response = handleFileStreamFast(file, file.size, 'video/mp4', 'bytes=2-4', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('10')
    expect(response.headers.has('Content-Range')).toBe(false)
    expect(response.body).toBeNull()
  })
})

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

    const converted = await generateM3UPlaylist('start.m3u', 'localhost:3000', 'http:', 'example-token', '720p', 'viewer')
    expect(converted).toContain('/api/hls/start/720p/master.m3u8?token=example-token&clientId=viewer')
    expect(converted).toContain('/api/hls/next-season/720p/master.m3u8?token=example-token&clientId=viewer')

    createAccount('restricted', 'restricted', 'unused', 'normal')
    setFilterRule('restricted', 'deny', { conditions: [{ field: 'sourceId', op: 'eq', value: 'second-drive' }] })
    const restricted = await runWithAccount('restricted', () => generatePlaylist('start'))
    expect(restricted.map(({ id }) => id)).toEqual(['start', 'recap', 'loose-episode'])
    expect(await runWithAccount('restricted', () => generatePlaylist('next-season'))).toEqual([])
  } finally {
    ctx.cleanup()
  }
})

it('keeps the selected HLS rendition and its audio tracks within the authenticated playback URL', () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a-original",NAME="English",URI="audio/0/original/index.m3u8?clientId=private"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a-192k",NAME="English",URI="audio/0/192k/index.m3u8?clientId=private"
#EXT-X-STREAM-INF:BANDWIDTH=4000000,AUDIO="a-original"
0/original/index.m3u8?clientId=private
#EXT-X-STREAM-INF:BANDWIDTH=2400000,AUDIO="a-192k"
0/720p/index.m3u8?clientId=private
`
  const query = new URLSearchParams({ token: 'login-token', clientId: 'viewer' })
  const converted = prepareHlsPlaylist(master, 'master.m3u8', '720p', query)
  expect(converted).toContain('0/720p/index.m3u8?token=login-token&clientId=viewer')
  expect(converted).toContain('audio/0/192k/index.m3u8?token=login-token&clientId=viewer')
  expect(converted).not.toContain('original/index.m3u8')
  expect(converted).not.toContain('clientId=private')
  for (const quality of ['remux', '1080p'] as const) {
    const remuxed = prepareHlsPlaylist(master, 'master.m3u8', quality, query)
    expect(remuxed).toContain('0/original/index.m3u8?token=login-token&clientId=viewer')
    expect(remuxed).not.toContain('720p/index.m3u8')
  }

  const media = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?ignored=true"\n#EXTINF:3.0,\nsegment-0.mp4?ignored=true\n'
  const result = prepareHlsPlaylist(media, '0/720p/index.m3u8', '720p', query)
  expect(result).toContain('URI="init.mp4?token=login-token&clientId=viewer"')
  expect(result).toContain('segment-0.mp4?token=login-token&clientId=viewer')
  expect(() => prepareHlsPlaylist(media.replace('segment-0.mp4', '../../../other.mp4'),
    '0/720p/index.m3u8', '720p', query)).toThrow('Unexpected gocoder playlist resource')
})

it('opens a growing HLS playlist near the beginning before exposing the rest of its timeline', () => {
  const event = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-START:TIME-OFFSET=0
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2.0,
segment-0.mp4
#EXTINF:2.0,
segment-1.mp4
#EXTINF:3.0,
segment-2.mp4
`
  const query = new URLSearchParams({ token: 'login-token' })
  const resource = 'audio/0/128k/index.m3u8'
  const initial = prepareHlsPlaylist(event, resource, '480p', query, true)
  const refreshed = prepareHlsPlaylist(event, resource, '480p', query)
  expect(initial).toContain('URI="init.mp4?token=login-token"')
  expect(initial).toEndWith('segment-1.mp4?token=login-token\n')
  expect(initial).not.toContain('segment-2.mp4')
  expect(refreshed).toStartWith(initial)
  const complete = event + '#EXT-X-ENDLIST\n'
  expect(prepareHlsPlaylist(complete, resource, '480p', query, true))
    .toBe(refreshed + '#EXT-X-ENDLIST\n')
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
