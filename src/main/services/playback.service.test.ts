import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServiceTestContext } from '../database/test-helpers'
import { createAccount } from '../database/repositories/account.repo'
import { setFilterRule } from '../database/repositories/account-filter.repo'
import { runWithAccount } from '../request-context'
import { getWebPlaybackQueue } from './web-playback.service'
import { generateM3UPlaylist, generatePlaylist, handleFileStreamFast } from './playback.service'
import { readMatroskaSubtitleIndexes, readMatroskaAssWindow, readMatroskaPgsWindow } from './transcoding/matroska-cues'
import { createTimeline, segmentPlaylist } from './transcoding/timeline'
import { indexSupWindows } from './transcoding/sup-windows'
import { inspectMp4Segment } from './transcoding/mp4-keyframes'

it('publishes the legacy x264 decoder hint before the picture without shifting fragment offsets', async () => {
  const word = (value: number) => {
    const bytes = Buffer.alloc(4)
    bytes.writeUInt32BE(value)
    return bytes
  }
  const box = (type: string, ...parts: Buffer[]) => {
    const payload = Buffer.concat(parts)
    return Buffer.concat([word(payload.length + 8), Buffer.from(type), payload])
  }
  const nal = (type: number, data: string) => {
    const payload = Buffer.from(data)
    return Buffer.concat([word(payload.length + 1), Buffer.from([type]), payload])
  }
  const picture = nal(5, 'first picture')
  const version = nal(6, 'x264 - core 142')
  const next = nal(1, 'next picture')
  const init = Buffer.concat([box('ftyp'), box('moov')])
  const tfhd = box('tfhd', word(0x020010), word(1), word(picture.length + version.length))
  const fragment = (dataOffset: number) => box('moof', box('traf', tfhd,
    box('trun', word(1), word(2), word(dataOffset))))
  const moof = fragment(fragment(0).length + 8)
  const dir = await mkdtemp(join(tmpdir(), 'kinome-avc-fragment-'))
  try {
    const path = join(dir, 'segment.mp4')
    await Bun.write(path, Buffer.concat([init, moof, box('mdat', picture, version, next)]))
    expect(await inspectMp4Segment(path, true, 142)).toEqual({ offset: init.length, initialization: init })
    expect(Buffer.from(await Bun.file(path).arrayBuffer())).toEqual(
      Buffer.concat([init, moof, box('mdat', version, picture, next)]))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('replays bitmap state across empty SUP windows and preserves unordered tracks for full playback', async () => {
  const packet = (seconds: number, state: number) => {
    const bytes = Buffer.alloc(24)
    bytes.write('PG')
    bytes.writeUInt32BE(seconds * 90_000, 2)
    bytes[10] = 0x16
    bytes.writeUInt16BE(11, 11)
    bytes[20] = state
    return bytes
  }
  const dir = await mkdtemp(join(tmpdir(), 'kinome-sup-'))
  try {
    const path = join(dir, 'track')
    await Bun.write(path, Buffer.concat([packet(45, 128), packet(52, 0), packet(95, 128), packet(100, 0)]))
    const range = await indexSupWindows(path)
    expect(range?.(0)).toEqual([0, 0])
    expect(range?.(2)).toEqual([0, 48])
    expect(range?.(3)).toEqual([0, 96])
    expect(range?.(4)).toEqual([48, 96])
    await Bun.write(path, Buffer.concat([packet(48, 128), packet(12, 0)]))
    expect(await indexSupWindows(path)).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function element(id: string, ...parts: (Buffer | string | number)[]): Buffer {
  const data = Buffer.concat(parts.map((part) => {
    if (Buffer.isBuffer(part)) return part
    if (typeof part === 'string') return Buffer.from(part)
    const integer = Buffer.alloc(4)
    integer.writeUInt32BE(part)
    return integer
  }))
  return Buffer.concat([Buffer.from(id, 'hex'), Buffer.from([0x40 | (data.length >> 8), data.length & 255]), data])
}

it('reads indexed ASS cues for a seek, including lines already on screen', async () => {
  const video = element('ae', element('d7', 1), element('83', 1))
  const subtitle = element('ae', element('d7', 2), element('83', 17), element('86', 'S_TEXT/ASS'),
    element('63a2', '[Script Info]\nScriptType: v4.00+\n\n[Events]\n'))
  const info = element('1549a966', element('5741', 'mkvmerge fixture'))
  const tracks = element('1654ae6b', video, subtitle)
  const ongoing = element('a0', element('a1', Buffer.from([0x82, 0, 0, 0]), '0,0,Default,,0,0,0,,Long cue'))
  const later = element('a3', Buffer.from([0x82, 0, 0, 0]), '1,0,Default,,0,0,0,,Later cue')
  const makeCues = (cluster: number) => element('1c53bb6b',
    element('bb', element('b3', 0), element('b7', element('f7', 1))),
    element('bb', element('b3', 20_000), element('b7', element('f7', 2), element('f1', cluster),
      element('f0', 0), element('b2', 20_000))),
    element('bb', element('b3', 60_000), element('b7', element('f7', 2), element('f1', cluster),
      element('f0', ongoing.length), element('b2', 1000))))
  const cues = makeCues(info.length + tracks.length + makeCues(0).length)
  const directory = await mkdtemp(join(tmpdir(), 'kinome-ass-index-'))
  try {
    const path = join(directory, 'indexed.mkv')
    await Bun.write(path, element('18538067', info, tracks, cues, element('1f43b675', ongoing, later)))
    const flags = { default: false, forced: false, hearingImpaired: false }
    const index = (await readMatroskaSubtitleIndexes(path, [
      { index: 0, kind: 'video', ...flags }, { index: 1, kind: 'subtitle', codec: 'ass', ...flags }
    ])).get(1)!
    const signal = new AbortController().signal
    if (!('header' in index)) throw new Error('Expected indexed ASS')
    const seek = await readMatroskaAssWindow(path, index, 30_000, 60_000, signal)
    expect(seek).toContain('Dialogue: 0,0:00:20.00,0:00:40.00,Default,,0,0,0,,Long cue')
    expect(seek).not.toContain('Later cue')
    const next = await readMatroskaAssWindow(path, index, 60_000, 90_000, signal)
    expect(next).toContain('Dialogue: 0,0:01:00.00,0:01:01.00,Default,,0,0,0,,Later cue')
    expect(next).not.toContain('Long cue')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('restores the previous bitmap epoch on seek and declines incomplete subtitle indexes', async () => {
  const info = element('1549a966', element('5741', 'mkvmerge fixture'))
  const tracks = element('1654ae6b', element('ae', element('d7', 1), element('83', 1)),
    element('ae', element('d7', 2), element('83', 17), element('86', 'S_HDMV/PGS')))
  const epoch = Buffer.from('16000b0780043810000080000000', 'hex')
  const clear = Buffer.from('800000', 'hex')
  const blocks = [epoch, clear].map((data) => element('a3', Buffer.from([0x82, 0, 0, 0]), data))
  const cuesAt = (position: number) => element('1c53bb6b',
    element('bb', element('b3', 0), element('b7', element('f7', 1))),
    ...[0, 1000].map((time, i) => element('bb', element('b3', time), element('b7',
      element('f7', 2), element('f1', position), element('f0', i ? blocks[0].length : 0)))))
  const directory = await mkdtemp(join(tmpdir(), 'kinome-pgs-index-'))
  try {
    const path = join(directory, 'indexed.mkv')
    const cues = cuesAt(info.length + tracks.length + cuesAt(0).length)
    await Bun.write(path, element('18538067', info, tracks, cues, element('1f43b675', ...blocks)))
    const flags = { default: false, forced: false, hearingImpaired: false }
    const indexes = (packetCount: number) => readMatroskaSubtitleIndexes(path, [
      { index: 0, kind: 'video', ...flags }, { index: 1, kind: 'subtitle', codec: 'hdmv_pgs_subtitle', packetCount, ...flags }
    ])
    expect((await indexes(3)).size).toBe(0)
    const index = (await indexes(2)).get(1)
    if (index?.format !== 'pgs') throw new Error('Expected indexed PGS')
    const data = await readMatroskaPgsWindow(path, index, 1100, 2000, new AbortController().signal)
    expect(data).toEqual(Buffer.concat([
      Buffer.from('50470000000000000000', 'hex'), epoch, Buffer.from('504700015f9000015f90', 'hex'), clear
    ]))
    await expect(readMatroskaPgsWindow(path, index, 1100, 2000, AbortSignal.abort())).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('direct media streaming', () => {
  let directory: string
  let filePath: string

  function streamRequest(range: string | null, init?: RequestInit) {
    const headers = new Headers(init?.headers)
    if (range !== null) headers.set('Range', range)
    return new Request('http://localhost/stream', { ...init, headers })
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kinome-range-'))
    filePath = join(directory, 'video.mp4')
    await Bun.write(filePath, '0123456789')
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
    const response = handleFileStreamFast(streamRequest(range), filePath, 10, 'video/mp4')
    expect(response.status).toBe(status)
    expect(response.headers.get('Content-Range')).toBe(contentRange)
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    if (status !== 416) expect(response.headers.get('Content-Length')).toBe(String(body.length))
    expect(await response.text()).toBe(body)
  })

  it('returns full representation headers and no body for a HEAD request with Range', () => {
    const response = handleFileStreamFast(streamRequest('bytes=2-4', { method: 'HEAD' }), filePath, 10, 'video/mp4')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('10')
    expect(response.headers.has('Content-Range')).toBe(false)
    expect(response.body).toBeNull()
  })

  it('serves empty media without opening a read stream', async () => {
    const empty = join(directory, 'empty.mp4')
    await Bun.write(empty, '')
    const response = handleFileStreamFast(streamRequest(null), empty, 0, 'video/mp4')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('0')
    expect(response.body).toBeNull()
  })

  it('stops a direct read when the request is aborted', async () => {
    const controller = new AbortController()
    const response = handleFileStreamFast(streamRequest(null, { signal: controller.signal }), filePath, 10, 'video/mp4')
    controller.abort()
    await expect(response.arrayBuffer()).rejects.toThrow()
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
      { id: 'earlier', name: 'Earlier.mkv', parentId: 'season-2', entityId: 's2e1' },
      { id: 'recap', name: 'Recap.mkv', parentId: 'season-2', entityId: 's2e25' },
      { id: 'start', parentId: 'season-2', entityId: 's2e2', name: 'Episode 2.mkv' },
      { id: 'extra', parentId: 'season-2' },
      { id: 'missing', parentId: 'season-3', entityId: 's3e1', isMissing: 1 },
      { id: 'hidden', parentId: 'season-3', entityId: 's3e2', isHidden: 1 },
      { id: 'next-season', name: 'Next Season.mkv', parentId: 'season-3', entityId: 's3e3', sourceId: 'second-drive' },
      { id: 'loose-episode', name: 'Loose Episode.mkv', parentId: 'show', entityId: 's4e1' },
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
    const webQueue = await runWithAccount('restricted', () => getWebPlaybackQueue('start', 'restricted'))
    expect(webQueue.map(({ id }) => id)).toEqual(['earlier', 'start', 'recap', 'loose-episode'])
    expect(await runWithAccount('restricted', () => generatePlaylist('next-season'))).toEqual([])
  } finally {
    ctx.cleanup()
  }
})

it('advertises the complete seek timeline with individually playable segments', () => {
  const timeline = createTimeline(15, [0, 3, 7, 11])
  const query = new URLSearchParams({ token: 'login-token', clientId: 'viewer' })
  const playlist = segmentPlaylist(timeline, (index) => `segment-${index}.ts?${query}`)
  expect(playlist).toContain('#EXT-X-TARGETDURATION:5')
  expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
  expect(playlist).toContain('#EXTINF:2.750000,\nsegment-0.ts?token=login-token&clientId=viewer')
  expect(playlist).toContain('#EXTINF:4.250000,\nsegment-3.ts?token=login-token&clientId=viewer')
  expect(playlist).toEndWith('#EXT-X-ENDLIST\n')
})

it('keeps trailing audio in the last segment that contains a video frame', () => {
  const timeline = createTimeline(6.5, undefined, 4.1)
  expect(timeline.starts).toEqual([0, 1, 2, 3])
  expect(segmentPlaylist(timeline, String)).toContain('#EXTINF:3.500000,\n3')
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
