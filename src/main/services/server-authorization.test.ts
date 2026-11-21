/**
 * HTTP Authorization Tests — Capability Enforcement
 *
 * Strategy:
 * - Normal-user tests: every protected route individually (full coverage).
 * - Admin-user tests: one clean representative per capability group, sufficient
 *   to prove the guard is two-directional without noisy service errors.
 */
import type { PlaybackDefaultsEditor, WebPlaybackInfo } from '@shared/web-playback'
import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { buildApp } from '../http-app'
import * as accountRepo from '../database/repositories/account.repo'
import * as authService from './auth.service'
import * as settingsService from './settings.service'
import { closeTranscodingSessions } from './transcoding.service'
import { conversionAvailable, ffmpeg, ffprobe } from './transcoding/runtime'

describe('HTTP authorization — capability enforcement', () => {
  let ctx: ServiceTestContext
  let normalToken: string
  let adminToken: string
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    ctx = createServiceTestContext()
    app = buildApp()

    const hash = await bcrypt.hash('password', 1)
    accountRepo.createAccount('admin-1', 'alice', hash, 'admin')
    accountRepo.createAccount('normal-1', 'bob', hash, 'normal')

    normalToken = (await authService.login('bob', 'password'))!.token
    adminToken = (await authService.login('alice', 'password'))!.token
  })

  afterAll(() => {
    authService.logout(normalToken)
    authService.logout(adminToken)
    ctx.cleanup()
  })

  function req(method: string, url: string, body?: any, token = normalToken): Request {
    return new Request(`http://localhost${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
  }

  const expect403 = async (method: string, url: string, body?: any) =>
    expect((await app.handle(req(method, url, body))).status).toBe(403)

  const expectNotBlocked = async (method: string, url: string, body?: any) =>
    expect((await app.handle(req(method, url, body, adminToken))).status).not.toBe(403)

  it('keeps playlist entries on HTTPS behind a reverse proxy', async () => {
    ctx.seedItems([{ id: 'proxy-movie', name: 'Movie.mkv' }])
    const query = new URLSearchParams({ token: adminToken })
    const response = await app.handle(new Request(`http://kinome.example/api/playlist/proxy-movie.m3u?${query}`, {
      headers: { 'X-Forwarded-Proto': 'https' }
    }))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(
      `https://kinome.example/api/stream/proxy-movie/Movie.mkv?token=${adminToken}&watch=1`
    )
  })

  it('shares personal season defaults between physical and virtual seasons without inheriting browsing folders', async () => {
    ctx.seedEntities([
      { id: 'defaults-show-entity', mediaType: 'tv' },
      { id: 'defaults-season-entity', mediaType: 'season', seasonNumber: 1 },
      { id: 'defaults-episode-entity', mediaType: 'episode', seasonNumber: 1 },
      { id: 'defaults-movie-entity', mediaType: 'movie' }
    ])
    ctx.seedItems([
      { id: 'defaults-show', type: 'folder', entityId: 'defaults-show-entity' },
      { id: 'defaults-physical-season', parentId: 'defaults-show', type: 'folder', entityId: 'defaults-season-entity' },
      { id: 'defaults-virtual-season', parentId: 'defaults-show', type: 'folder',
        entityId: 'defaults-season-entity', isVirtual: 1, virtualType: 'season' },
      { id: 'defaults-episode', parentId: 'defaults-show', name: 'episode.mkv', sourceId: 'defaults-source', entityId: 'defaults-episode-entity' },
      { id: 'defaults-movie', name: 'movie.mp4', entityId: 'defaults-movie-entity' },
      { id: 'defaults-group', type: 'folder', isVirtual: 1, virtualType: 'user' }
    ])
    ctx.db.exec(`
      INSERT INTO local_media (location_id, failures)
      SELECT id, 0 FROM media_locations WHERE item_id = 'defaults-episode';
      INSERT INTO local_media_tracks (location_id, stream_index, kind, codec, language, is_default, forced, hearing_impaired)
      SELECT id, 0, 'audio', 'aac', 'jpn', 0, 0, 0 FROM media_locations WHERE item_id = 'defaults-episode'
      UNION ALL
      SELECT id, 1, 'subtitle', 'subrip', 'eng', 0, 0, 0 FROM media_locations WHERE item_id = 'defaults-episode';
    `)
    const endpoint = (id: string) => `/api/playback/${id}/defaults`
    const put = (id: string, data: object) => app.handle(req('PUT', endpoint(id), data))
    const editor = async (id: string, token = normalToken) =>
      (await (await app.handle(req('GET', endpoint(id), undefined, token))).json()) as PlaybackDefaultsEditor
    const get = async (id: string, token = normalToken) => (await editor(id, token)).defaults

    const source = spyOn(settingsService, 'getAbsoluteSourcePath').mockResolvedValue(tmpdir())
    try {
      expect((await editor('defaults-episode')).languages).toEqual({ audio: ['jpn'], subtitles: ['eng'] })
    } finally {
      source.mockRestore()
    }
    expect((await editor('defaults-virtual-season')).languages).toBeNull()
    expect((await editor('defaults-physical-season')).languages).toBeNull()
    expect((await editor('defaults-show')).languages).toBeNull()

    expect((await put('defaults-show', { audioLanguage: 'ja' })).status).toBe(200)
    expect((await put('defaults-episode', { scope: 'season', subtitleLanguage: 'EN' })).status).toBe(200)
    const languages = async (token = normalToken) =>
      (await app.handle(req('GET', '/api/playback/defaults-episode/languages', undefined, token))).json()
    expect(await languages()).toEqual({ audioLanguage: 'ja', subtitleLanguage: 'en' })
    expect(await languages(adminToken)).toEqual({ audioLanguage: null, subtitleLanguage: null })
    expect(await get('defaults-virtual-season')).toEqual({ audioLanguage: null, subtitleLanguage: 'en' })
    expect(await get('defaults-physical-season')).toEqual({ audioLanguage: null, subtitleLanguage: 'en' })
    expect(await get('defaults-physical-season', adminToken)).toEqual({ audioLanguage: null, subtitleLanguage: null })
    expect((await put('defaults-physical-season', { audioLanguage: 'jpn' })).status).toBe(200)
    expect(await get('defaults-virtual-season')).toEqual({ audioLanguage: 'jpn', subtitleLanguage: 'en' })
    expect((await put('defaults-virtual-season', { subtitleLanguage: null })).status).toBe(200)
    expect(await get('defaults-physical-season')).toEqual({ audioLanguage: 'jpn', subtitleLanguage: null })
    expect((await put('defaults-episode', { subtitleLanguage: 'off' })).status).toBe(200)
    expect(await get('defaults-episode')).toEqual({ audioLanguage: null, subtitleLanguage: 'off' })
    expect((await put('defaults-physical-season', { subtitleLanguage: 'en' })).status).toBe(200)
    expect(await languages()).toEqual({ audioLanguage: 'jpn,ja', subtitleLanguage: null })
    expect((await put('defaults-episode', { audioLanguage: ' ENG,en, Ja ', subtitleLanguage: 'FR , ja' })).status).toBe(200)
    expect(await get('defaults-episode')).toEqual({ audioLanguage: 'eng, en, ja', subtitleLanguage: 'fr, ja' })
    expect(await languages()).toEqual({ audioLanguage: 'eng,en,ja,jpn', subtitleLanguage: 'fr,ja,en' })
    expect((await put('defaults-episode', { audioLanguage: 'en,,ja' })).status).toBe(422)
    expect((await put('defaults-episode', { subtitleLanguage: 'en, Off' })).status).toBe(422)
    expect(await get('defaults-group')).toBeNull()
    expect((await put('defaults-group', { audioLanguage: 'ja' })).status).toBe(404)
    expect((await put('defaults-movie', { scope: 'movie', audioLanguage: 'ja' })).status).toBe(404)
    expect((await put('defaults-movie', { scope: 'file', audioLanguage: 'ja' })).status).toBe(200)
  })

  it('serves matching subtitle sidecars and saves playback progress per account', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kinome-web-playback-'))
    const source = spyOn(settingsService, 'getAbsoluteSourcePath').mockResolvedValue(directory)
    const base = '/api/playback/web-movie'
    try {
      await Promise.all([
        Bun.write(join(directory, 'film.mp4'), ''),
        Bun.write(join(directory, 'film.en.forced.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n'),
        Bun.write(join(directory, 'other.en.vtt'), 'WEBVTT\n')
      ])
      ctx.seedItems([
        { id: 'web-folder', type: 'folder', sourceId: 'web-source' },
        { id: 'web-movie', parentId: 'web-folder', name: 'film.mp4', sourceId: 'web-source', path: 'film.mp4' }
      ])
      expect((await app.handle(new Request(`http://localhost${base}/info`))).status).toBe(401)
      expect((await app.handle(req('PUT', base + '/defaults', { audioLanguage: 'eng' }))).status).toBe(200)
      const editor = await (await app.handle(req('GET', base + '/defaults'))).json() as PlaybackDefaultsEditor
      expect(editor.languages?.subtitles).toEqual(['en'])
      const info = await (await app.handle(req('GET', base + '/info'))).json() as WebPlaybackInfo
      expect(info.languageDefaults).toEqual([{ scope: 'file', audioLanguage: 'eng', subtitleLanguage: null }])
      expect(info.position).toBe(0)
      expect(info.subtitles).toEqual([
        expect.objectContaining({ format: 'text', language: 'en', forced: true, sidecar: true })
      ])
      const track = base + '/subtitle/' + info.subtitles[0].id + '/track'
      const response = await app.handle(req('GET', track))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toStartWith('text/vtt')
      expect(await response.text()).toContain('Hello')
      const unrelated = 's-' + Buffer.from('other.en.vtt').toString('base64url')
      expect((await app.handle(req('GET', base + '/subtitle/' + unrelated + '/track'))).status).toBe(404)
      expect((await app.handle(req('POST', base + '/progress', { position: 75, completed: false }))).status).toBe(200)
      expect(await (await app.handle(req('GET', base + '/info'))).json()).toMatchObject({ position: 75 })
      expect(await (await app.handle(req('GET', base + '/info', undefined, adminToken))).json()).toMatchObject({ position: 0 })
      expect(await (await app.handle(req('GET', '/api/items/web-movie'))).json()).not.toMatchObject({ watched: true })
      expect((await app.handle(req('POST', base + '/progress', { position: 95, completed: true }))).status).toBe(200)
      expect(await (await app.handle(req('GET', base + '/info'))).json()).toMatchObject({ position: 0 })
      expect(await (await app.handle(req('GET', '/api/items/web-movie'))).json()).toMatchObject({ watched: true })
      expect((await app.handle(req('POST', base + '/progress', { position: 24, completed: false }, adminToken))).status).toBe(200)
      for (const itemId of ['web-movie', 'web-folder']) {
        for (const watched of [false, true]) {
          expect((await app.handle(req('POST', base + '/progress', { position: 35, completed: false }))).status).toBe(200)
          expect((await app.handle(req('POST', watched ? '/api/mark-watched' : '/api/mark-unwatched', { itemId }))).status).toBe(200)
          expect(await (await app.handle(req('GET', base + '/info'))).json()).toMatchObject({ position: 0 })
          expect(await (await app.handle(req('GET', '/api/items/web-movie'))).json()).toMatchObject({ watched })
        }
      }
      expect((await app.handle(req('POST', base + '/progress', { position: 15, completed: false }))).status).toBe(200)
      expect(await (await app.handle(req('GET', base + '/info'))).json()).toMatchObject({ position: 15 })
      expect(await (await app.handle(req('GET', '/api/items/web-movie'))).json()).toMatchObject({ watched: true })
      expect(await (await app.handle(req('GET', base + '/info', undefined, adminToken))).json()).toMatchObject({ position: 24 })
    } finally {
      source.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(!conversionAvailable)('serves indexed text and styled subtitles around the playhead, including an overlapping cue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kinome-subrip-'))
    const source = spyOn(settingsService, 'getAbsoluteSourcePath').mockResolvedValue(directory)
    const logs = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const subtitle = join(directory, 'source.srt')
      await Bun.write(subtitle, '1\n00:00:28,000 --> 00:00:34,000\n<i>Carry over</i>\nSecond line\n\n' +
        '2\n00:01:01,000 --> 00:01:03,000\nLater\n')
      const fixture = Bun.spawnSync([ffmpeg!, '-v', 'error', '-f', 'lavfi', '-i', 'color=size=16x16:rate=1',
        '-i', subtitle, '-t', '65', '-map', '0:v', '-map', '1:s', '-map', '1:s', '-map', '1:s',
        '-c:v', 'mpeg4', '-bf', '0', '-g', '10', '-c:s:0', 'copy', '-c:s:1', 'webvtt', '-c:s:2', 'ass',
        '-metadata:s:s', 'NUMBER_OF_FRAMES=2', join(directory, 'movie.mkv')])
      expect(fixture.exitCode).toBe(0)
      ctx.seedItems([{ id: 'indexed-text', sourceId: 'text-source', path: 'movie.mkv' }])
      const base = '/api/playback/indexed-text'
      const info = await (await app.handle(req('GET', base + '/info'))).json() as WebPlaybackInfo
      expect(info.subtitles.map((track) => track.format)).toEqual(['text', 'text', 'ass'])
      for (const track of info.subtitles) {
        const url = base + '/subtitle/' + track.id + '/track?window='
        for (const window of [2, 1, 3]) {
          const response = await app.handle(req('GET', url + window))
          expect(response.status).toBe(200)
          expect(response.headers.get('X-Kinome-Subtitle-Window')).toBe(String(window))
          const body = await response.text()
          expect(body.includes('Later')).toBe(window === 2)
          expect(body.includes('Carry over')).toBe(window === 1)
          if (track.format === 'text' && window === 1) {
            expect(body).toContain('00:28.000 --> 00:34.000\n<i>Carry over</i>\nSecond line')
          }
        }
      }
    } finally {
      logs.mockRestore()
      source.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(!conversionAvailable)('serves authenticated byte ranges from seekable fragmented MP4 remuxes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kinome-hls-'))
    const source = spyOn(settingsService, 'getAbsoluteSourcePath').mockResolvedValue(directory)
    const defaults = await settingsService.readSettings()
    const settings = spyOn(settingsService, 'readSettings').mockResolvedValue({
      ...defaults, playbackConversion: 'full', playbackConversionAvailable: true
    })
    const logging = (['log', 'info', 'warn'] as const).map((method) => spyOn(console, method).mockImplementation(() => {}))
    try {
      const chapterFile = join(directory, 'chapters.ffmeta')
      const subtitleFile = join(directory, 'subtitles.srt')
      await Bun.write(chapterFile, [
        ';FFMETADATA1', '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=2000', 'title=Opening',
        '[CHAPTER]', 'TIMEBASE=1/1000', 'START=2000', 'END=5000', 'title=Scene', ''
      ].join('\n'))
      await Bun.write(subtitleFile, '1\n00:00:01,000 --> 00:00:02,000\nHello from ASS\n')
      const fixture = Bun.spawnSync([
        ffmpeg!, '-v', 'error', '-f', 'lavfi', '-i', 'color=size=64x64:rate=24',
        '-f', 'lavfi', '-i', 'sine=sample_rate=48000', '-f', 'ffmetadata', '-i', chapterFile,
        '-i', subtitleFile,
        '-map_chapters', '2', '-t', '12',
        '-c:v', 'mpeg4', '-g', '48', '-c:a', 'flac', '-ac', '8', '-c:s', 'ass', join(directory, 'movie.mkv')
      ])
      expect(fixture.stderr.toString()).toBe('')
      expect(fixture.exitCode).toBe(0)
      ctx.seedItems([{ id: 'fragmented-movie', sourceId: 'hls-source', path: 'movie.mkv' }])
      const info = await app.handle(req('GET', '/api/playback/fragmented-movie/info', undefined, adminToken))
      expect(info.status).toBe(200)
      const { media: sourceInfo, subtitles } = (await info.json()) as WebPlaybackInfo
      expect(sourceInfo?.chapters).toEqual([
        { startSeconds: 0, endSeconds: 2, title: 'Opening' },
        { startSeconds: 2, endSeconds: 5, title: 'Scene' }
      ])
      expect(subtitles).toEqual([expect.objectContaining({ format: 'ass' })])
      const subtitlePath = `/api/playback/fragmented-movie/subtitle/${subtitles[0].id}/track?window=0`
      expect((await app.handle(new Request(`http://localhost${subtitlePath}`))).status).toBe(401)
      const fallback = await app.handle(req('GET', subtitlePath, undefined, adminToken))
      expect(fallback.status).toBe(200)
      expect(fallback.headers.has('X-Kinome-Subtitle-Window')).toBe(false)
      expect(await fallback.text()).toContain('Hello from ASS')
      const master = new URL('http://localhost/api/hls/fragmented-movie/remux/master.m3u8')
      master.searchParams.set('token', adminToken)
      const playlist = await app.handle(new Request(master.href))
      expect(playlist.status).toBe(200)
      const text = await playlist.text()
      const init = new URL(text.match(/#EXT-X-MAP:URI="([^"]+)"/)![1], master)
      const media = new URL(text.split('\n').filter((line) => line.startsWith('segment-')).at(-1)!, master)
      expect(media.pathname).toEndWith('segment-5.m4s')
      const unauthorized = new URL(media)
      unauthorized.searchParams.delete('token')
      expect((await app.handle(new Request(unauthorized.href))).status).toBe(401)
      const segment = await app.handle(new Request(media.href))
      const data = await segment.arrayBuffer()
      expect(segment.status).toBe(200)
      expect(Number(segment.headers.get('Content-Length'))).toBe(data.byteLength)
      expect(Buffer.from(data).toString('ascii', 4, 8)).toBe('moof')
      const webMaster = new URL(master)
      webMaster.searchParams.set('web', '1')
      webMaster.searchParams.set('sound', 'stereo')
      webMaster.pathname = webMaster.pathname.replace('/remux/', '/audio/')
      const audioPlaylist = await app.handle(new Request(webMaster.href))
      expect(audioPlaylist.status).toBe(200)
      const audioText = await audioPlaylist.text()
      expect(Number(audioText.match(/#EXTINF:([^,]+),/)?.[1])).toBeCloseTo(2, 3)
      const audioSegmentUrl = new URL(audioText.split('\n').find((line) => line.startsWith('segment-'))!, webMaster)
      expect(audioSegmentUrl.searchParams.get('web')).toBe('1')
      const audioSegment = await app.handle(new Request(audioSegmentUrl.href))
      expect(audioSegment.status).toBe(200)
      const audioData = await audioSegment.arrayBuffer()
      const codecs = Bun.spawnSync([ffprobe!, '-v', 'error', '-show_entries', 'stream=codec_name',
        '-of', 'csv=p=0', '-i', 'pipe:0'], { stdin: Buffer.from(audioData) })
      expect(codecs.exitCode).toBe(0)
      expect(codecs.stdout.toString()).toContain('mpeg4')
      expect(codecs.stdout.toString()).toContain('aac')
      // The fifth two-second segment starts a new copy-video/AAC job.
      // A continuous input tone must have adjacent AAC packet timestamps.
      const audioSegments = audioText.split('\n').filter((line) => line.startsWith('segment-'))
      const audioTimes = async (index: number) => {
        const response = await app.handle(new Request(new URL(audioSegments[index], webMaster).href))
        expect(response.status).toBe(200)
        const probe = Bun.spawnSync([ffprobe!, '-v', 'error', '-select_streams', 'a:0',
          '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', '-i', 'pipe:0'],
          { stdin: Buffer.from(await response.arrayBuffer()) })
        expect(probe.exitCode).toBe(0)
        return JSON.parse(probe.stdout.toString()).packets as { pts_time: string; duration_time: string }[]
      }
      const last = (await audioTimes(3)).at(-1)!
      const first = (await audioTimes(4))[0]
      expect(Math.abs(Number(first.pts_time) - Number(last.pts_time) - Number(last.duration_time))).toBeLessThan(1 / 48000)
      // An independently encoded picture can still carry the exact source soundtrack.
      const converted = new URL(webMaster)
      converted.pathname = converted.pathname.replace('/audio/', '/480p/')
      converted.searchParams.set('sound', 'copy')
      converted.searchParams.set('audio', '1')
      async function firstFragment(url: URL) {
        const rendition = await app.handle(new Request(url.href))
        expect(rendition.status).toBe(200)
        const lines = (await rendition.text()).split('\n')
        const initPath = lines.find(line => line.startsWith('#EXT-X-MAP:'))!.split('"')[1]
        const segmentPath = lines.find(line => line.startsWith('segment-'))!
        const buffers = await Promise.all([initPath, segmentPath].map(async path => {
          const resource = new URL(path, url)
          expect(resource.searchParams.get('sound')).toBe(url.searchParams.get('sound'))
          const response = await app.handle(new Request(resource.href))
          expect(response.status).toBe(200)
          return Buffer.from(await response.arrayBuffer())
        }))
        return Buffer.concat(buffers)
      }
      const fragment = await firstFragment(converted)
      const hashArgs = ['-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'sha256',
        '-show_entries', 'packet=data_hash', '-of', 'csv=p=0']
      const originalHashes = Bun.spawnSync([ffprobe!, ...hashArgs, join(directory, 'movie.mkv')]).stdout.toString().trim().split('\n')
      const copied = Bun.spawnSync([ffprobe!, ...hashArgs, 'pipe:0'], { stdin: fragment })
      expect(copied.exitCode).toBe(0)
      const copiedHashes = copied.stdout.toString().trim().split('\n')
      expect(copiedHashes.length).toBeGreaterThan(1)
      expect(copiedHashes).toEqual(originalHashes.slice(0, copiedHashes.length))
      // AAC 7.1 needs an MP4 fragment for channel configurations unsupported by ADTS.
      converted.searchParams.delete('sound')
      const surround = Bun.spawnSync([ffprobe!, '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,channels', '-of', 'csv=p=0', 'pipe:0'],
        { stdin: await firstFragment(converted) })
      expect(surround.exitCode).toBe(0)
      expect(surround.stdout.toString().trim()).toBe('aac,8')
      // Browsers need timestamped MP3 packets, including audio before
      // the first video keyframe. Check the bytes the player receives.
      const delayed = Bun.spawnSync([ffmpeg!, '-v', 'error', '-itsoffset', '1', '-i', join(directory, 'movie.mkv'),
        '-i', join(directory, 'movie.mkv'), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
        '-c:a', 'libmp3lame', '-ac', '1', '-t', '4', join(directory, 'lead.mp4')])
      expect(delayed.exitCode).toBe(0)
      ctx.seedItems([{ id: 'delayed-movie', sourceId: 'hls-source', path: 'lead.mp4' }])
      const lead = new URL('/api/hls/delayed-movie/remux/master.m3u8', master)
      lead.search = new URLSearchParams({ token: adminToken, web: '1', audio: '1' }).toString()
      const timing = Bun.spawnSync([ffprobe!, '-v', 'error', '-show_entries', 'stream=codec_name,start_time',
        '-of', 'json', 'pipe:0'], { stdin: await firstFragment(lead) })
      expect(timing.exitCode).toBe(0)
      const [picture, sound] = JSON.parse(timing.stdout.toString()).streams
      expect(sound.codec_name).toBe('mp3')
      expect(Number(picture.start_time) - Number(sound.start_time)).toBeCloseTo(1, 1)
      const initialization = await app.handle(new Request(init.href, { headers: { Range: 'bytes=0-7' } }))
      expect(initialization.status).toBe(206)
      expect(Buffer.from(await initialization.arrayBuffer()).toString('ascii', 4, 8)).toBe('ftyp')
    } finally {
      source.mockRestore()
      settings.mockRestore()
      await closeTranscodingSessions()
      for (const logger of logging) logger.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  // ─── editSettings ────────────────────────────────────────────────────────────

  describe('editSettings — normal user blocked', () => {
    it('POST /api/save-settings',           () => expect403('POST', '/api/save-settings', {}))
    it('POST /api/save-source',             () => expect403('POST', '/api/save-source', { source: {} }))
    it('GET  /api/list-directory',          () => expect403('GET',  '/api/list-directory?path=/'))
    it('POST /api/resolve-media-source-path', () => expect403('POST', '/api/resolve-media-source-path', { path: '/', isRelative: false }))
    it('POST /api/reveal-in-explorer',      () => expect403('POST', '/api/reveal-in-explorer', { path: '/' }))
  })

  it('editSettings — admin is not blocked (list-directory)', () =>
    // Listing '/' is a real FS call that always succeeds cleanly.
    expectNotBlocked('GET', '/api/list-directory?path=/'))

  // ─── triggerLibraryScan ──────────────────────────────────────────────────────

  describe('triggerLibraryScan — normal user blocked', () => {
    it('POST /api/perform-scan',                    () => expect403('POST', '/api/perform-scan', {}))
    it('POST /api/apply-initial-folder-settings',   () => expect403('POST', '/api/apply-initial-folder-settings', { settings: [] }))
  })

  it('triggerLibraryScan — admin is not blocked (apply-initial-folder-settings)', () =>
    // Empty settings list is a no-op that completes without errors.
    expectNotBlocked('POST', '/api/apply-initial-folder-settings', { settings: [] }))

  // ─── editMetadata ────────────────────────────────────────────────────────────

  describe('editMetadata — normal user blocked', () => {
    it('PATCH /api/items',                            () => expect403('PATCH', '/api/items', { id: 'x' }))
    it('POST /api/items/:id/grouping',                () => expect403('POST', '/api/items/x/grouping', { groupByKey: null }))
    it('POST /api/items/:id/virtual-folders',         () => expect403('POST', '/api/items/x/virtual-folders', { name: 'Test' }))
    it('POST /api/clear-item-metadata',               () => expect403('POST', '/api/clear-item-metadata', { itemId: 'x', childrenOnly: false }))
    it('POST /api/clear-virtual-folder-metadata',     () => expect403('POST', '/api/clear-virtual-folder-metadata', { itemIds: [] }))
    it('POST /api/fetch-credits',                     () => expect403('POST', '/api/fetch-credits', { itemId: 'x' }))
    it('POST /api/manual-search',                     () => expect403('POST', '/api/manual-search', { query: '', type: 'movie' }))
    it('POST /api/get-tmdb-images',                   () => expect403('POST', '/api/get-tmdb-images', { tmdbId: 1, mediaType: 'movie', language: 'en' }))
    it('POST /api/user-apply-tmdb-result',            () => expect403('POST', '/api/user-apply-tmdb-result', { itemId: 'x', result: {}, mediaType: 'movie' }))
    it('POST /api/user-set-image',                    () => expect403('POST', '/api/user-set-image', { itemId: 'x', imageType: 'poster', source: {} }))
    it('POST /api/remove-image',                      () => expect403('POST', '/api/remove-image', { itemId: 'x', imageType: 'poster' }))
    it('POST /api/upload-image',                      () => expect403('POST', '/api/upload-image', { itemId: 'x', imageType: 'poster' }))
    it('POST /api/assign-seasons-and-episodes',       () => expect403('POST', '/api/assign-seasons-and-episodes', { showId: 'x', seasonStrategy: 'smart', episodeStrategy: 'smart', fetchMetadata: false }))
    it('POST /api/rename-item',                       () => expect403('POST', '/api/rename-item', { itemId: 'x', newName: 'y' }))
    it('POST /api/delete-item-from-db',               () => expect403('POST', '/api/delete-item-from-db', { itemId: 'x' }))
    it('POST /api/trash-item',                        () => expect403('POST', '/api/trash-item', { itemId: 'x' }))
    it('POST /api/execute-custom-action',             () => expect403('POST', '/api/execute-custom-action', { itemId: 'x', commandId: 'y' }))
  })

  it('editMetadata — admin is not blocked (clear-virtual-folder-metadata)', () =>
    // Empty itemIds is a no-op that completes without errors.
    expectNotBlocked('POST', '/api/clear-virtual-folder-metadata', { itemIds: [] }))

  // ─── manageAccounts ──────────────────────────────────────────────────────────

  describe('manageAccounts — normal user blocked', () => {
    it('GET /api/accounts',                           () => expect403('GET',    '/api/accounts'))
    it('POST /api/accounts',                          () => expect403('POST',   '/api/accounts', { username: 'x', password: 'y', role: 'normal' }))
    it('PUT /api/accounts/:id/role',                  () => expect403('PUT',    '/api/accounts/other-1/role', { role: 'admin' }))
    it('DELETE /api/accounts/:id',                    () => expect403('DELETE', '/api/accounts/other-1'))
    it('POST /api/accounts/:id/password (other user)', () => expect403('POST',  '/api/accounts/admin-1/password', { password: 'newpw' }))
  })

  it('manageAccounts — admin is not blocked (list accounts)', () =>
    expectNotBlocked('GET', '/api/accounts'))

  it('manageAccounts — normal user CAN change own password', async () => {
    expect((await app.handle(req('POST', '/api/accounts/normal-1/password', { password: 'newpw' }))).status).not.toBe(403)
  })

  // ─── Unauthenticated requests ────────────────────────────────────────────────

  describe('unauthenticated', () => {
    it('request without token returns 401', async () => {
      expect((await app.handle(new Request('http://localhost/api/items'))).status).toBe(401)
    })

    it('login endpoint is public (body shows auth result, not middleware rejection)', async () => {
      const res = await app.handle(new Request('http://localhost/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'nobody', password: 'x' })
      }))
      expect(await res.json()).toHaveProperty('authenticated', false)
    })

    it('check-auth endpoint is public', async () => {
      expect((await app.handle(new Request('http://localhost/api/check-auth'))).status).not.toBe(403)
    })
  })
})
