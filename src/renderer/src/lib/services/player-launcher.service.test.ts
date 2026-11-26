import { beforeAll, describe, expect, test } from 'bun:test'
import type { WebPlaybackInfo } from '@shared/web-playback'
import type { PlayerCommandConfig } from '@shared/types'

type PlayerLauncherModule = typeof import('./player-launcher.service')

let launcher: PlayerLauncherModule

beforeAll(async () => {
  Object.assign(globalThis, {
    $state: <T>(value: T) => value,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    window: {
      location: {
        protocol: 'http:',
        host: 'localhost:3000',
        origin: 'http://localhost:3000'
      }
    },
    fetch: async () => new Response(JSON.stringify({ authenticated: false }), { status: 401 })
  })

  launcher = await import('./player-launcher.service')
})

describe('resolveClientPlayers', () => {
  const mpv: PlayerCommandConfig = {
    id: 'mpv',
    name: 'MPV',
    command: 'mpv <url>'
  }

  const vlc: PlayerCommandConfig = {
    id: 'vlc',
    name: 'VLC',
    command: 'vlc <url>'
  }

  test('puts the web player first on a new device', () => {
    expect(launcher.resolveClientPlayers([], []).map((p) => p.id)).toEqual([
      launcher.BUILTIN_WEB_PLAYER.id,
      launcher.BUILTIN_COPY_PLAYLIST_LINK.id,
      launcher.BUILTIN_COPY_LINK.id
    ])
  })

  test('adds the web player first while preserving the saved order of existing players', () => {
    expect(launcher.resolveClientPlayers([mpv], [mpv.id, launcher.BUILTIN_COPY_LINK.id]).map((p) => p.id)).toEqual([
      launcher.BUILTIN_WEB_PLAYER.id,
      mpv.id,
      launcher.BUILTIN_COPY_LINK.id,
      launcher.BUILTIN_COPY_PLAYLIST_LINK.id
    ])
  })

  test('preserves explicit client ordering for custom and built-in players', () => {
    expect(
      launcher
        .resolveClientPlayers(
          [mpv, vlc],
          [launcher.BUILTIN_COPY_LINK.id, launcher.BUILTIN_WEB_PLAYER.id, vlc.id, launcher.BUILTIN_COPY_PLAYLIST_LINK.id]
        )
        .map((p) => p.id)
    ).toEqual([launcher.BUILTIN_COPY_LINK.id, launcher.BUILTIN_WEB_PLAYER.id, vlc.id, launcher.BUILTIN_COPY_PLAYLIST_LINK.id])
  })

  test('drops stale custom player ids while keeping built-ins available', () => {
    expect(launcher.resolveClientPlayers([mpv], ['deleted', mpv.id]).map((p) => p.id)).toEqual([
      launcher.BUILTIN_WEB_PLAYER.id,
      mpv.id,
      launcher.BUILTIN_COPY_PLAYLIST_LINK.id,
      launcher.BUILTIN_COPY_LINK.id
    ])
  })
})

test.each([
  ['mpv <url>', /^mpv "(https:\/\/[^"]+)"$/],
  ['vlc "<url>"', /^vlc "(https:\/\/[^"]+)"$/],
  ["vlc '<url>'", /^vlc '(https:\/\/[^']+)'$/],
  ['mpv "--playlist=<url>"', /^mpv "--playlist=(https:\/\/[^"]+)"$/]
])('passes the selected quality as part of one player argument for %s', async (template, expected) => {
  const { authStore } = await import('../auth-store.svelte')
  const originalToken = authStore.token
  const { fetch, localStorage, window } = globalThis
  const location = { origin: 'https://kinome.example', href: '' }
  try {
    authStore.token = 'login-token'
    Object.assign(globalThis, {
      localStorage: { getItem: () => 'handler-secret' },
      window: { location },
      fetch: async (input: string) => {
        expect(input).toStartWith('https://')
        return new Response('#EXTM3U', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })
      }
    })
    await launcher.playerLauncherService.launchExternal(
      { id: 'movie', type: 'file', name: 'movie.mkv' },
      { id: 'test-player', name: 'Test Player', command: template },
      '480p'
    )
    const launch = new URL(location.href)
    const command = atob(launch.searchParams.get('command')!)
    expect(command).toMatch(expected)
    const playerUrl = new URL(expected.exec(command)![1])
    expect(playerUrl.pathname).toBe('/api/playlist/movie.m3u')
    expect(playerUrl.searchParams.get('token')).toBe('login-token')
    expect(playerUrl.searchParams.get('quality')).toBe('480p')
    expect(playerUrl.searchParams.get('clientId')).toBeTruthy()
  } finally {
    authStore.token = originalToken
    Object.assign(globalThis, { fetch, localStorage, window })
  }
})

test('expands saved language priorities once per launch and preserves empty arguments', async () => {
  const { authStore } = await import('../auth-store.svelte')
  const originalToken = authStore.token
  const { fetch, localStorage, window } = globalThis
  const location = { origin: 'https://kinome.example', href: '' }
  const requests: string[] = []
  try {
    authStore.token = 'login-token'
    Object.assign(globalThis, {
      localStorage: { getItem: () => 'handler-secret' },
      window: { location },
      fetch: async (input: string, init: RequestInit) => {
        requests.push(input)
        expect(init.headers).toEqual({ Authorization: 'Bearer login-token' })
        return Response.json({ audioLanguage: 'ja,en', subtitleLanguage: null })
      }
    })
    await launcher.playerLauncherService.launchExternal(
      { id: 'movie', type: 'file', name: 'movie.mkv' },
      { id: 'test-player', name: 'Test Player', command: 'mpv --alang=<alang> "--slang=<slang>" <url>' }
    )
    const launch = new URL(location.href)
    expect(atob(launch.searchParams.get('command')!)).toStartWith('mpv --alang="ja,en" "--slang=" "https://')
    expect(requests).toEqual(['/api/playback/movie/languages'])
  } finally {
    authStore.token = originalToken
    Object.assign(globalThis, { fetch, localStorage, window })
  }
})

test('plays supported MP4 and WebM directly, remuxes other supported streams, and converts the rest', async () => {
  const { playbackAttempts } = await import('./web-playback.service')
  const flags = { default: true, forced: false, hearingImpaired: false }
  const video = { index: 0, kind: 'video' as const, codec: 'mpeg4', height: 2160, ...flags }
  const h264 = { ...video, codec: 'h264' }
  const audio = { index: 1, kind: 'audio' as const, codec: 'aac', channels: 6, ...flags }
  const info: WebPlaybackInfo = {
    languageDefaults: [],
    preferences: { audioLanguage: null, subtitleLanguage: null, subtitles: 'default' },
    media: { container: 'avi', tracks: [video, audio] },
    qualities: ['original', 'remux', '4k', '1080p'],
    position: 0, subtitles: [], audioConversion: true
  }
  const player = { canPlayType: (type: string) =>
    /mpegurl|mp4a|avc1|webm/.test(type) ? 'probably' : '' } as HTMLVideoElement
  const modes = (media: WebPlaybackInfo['media'], selected = audio, quality: 'source' | 'auto' | '1080p' | '4k' = 'source') =>
    playbackAttempts(player, { ...info, media }, selected, media!.tracks[1], quality).map(attempt => attempt.mode)

  expect(playbackAttempts(player, { ...info, qualities: ['original'], audioConversion: false }, audio, audio, 'source')
    .map(attempt => attempt.mode)).toEqual(['original'])
  const attempts = playbackAttempts(player, info, audio, audio, 'source')
  expect(attempts[0]).toEqual({ mode: '4k', videoCodec: undefined, sound: 'copy' })
  expect(attempts.findIndex(attempt => attempt.mode === '1080p')).toBeGreaterThan(0)

  expect(modes({ container: 'mp4', tracks: [h264, audio] }).slice(0, 2)).toEqual(['original', 'remux'])
  expect(modes({ container: 'mp4', tracks: [{ ...h264, startSeconds: 1 }, audio] })[0]).toBe('remux')
  expect(modes({ container: 'matroska', tracks: [h264, audio] })[0]).toBe('remux')
  const unsupported = { ...audio, codec: 'dts' }
  expect(modes({ container: 'matroska', tracks: [h264, unsupported] }, unsupported).slice(0, 3)).toEqual(['audio', 'audio', '4k'])

  const vorbis = { ...audio, codec: 'vorbis' }
  const opus = { ...audio, index: 2, codec: 'opus', default: false }
  const webm = { container: 'webm', tracks: [{ ...video, codec: 'vp8' }, vorbis, opus] }
  expect(modes(webm, vorbis)[0]).toBe('original')
  // This client cannot select a soundtrack that its native demuxer did not pick.
  expect(modes(webm, opus)).not.toContain('original')

  expect(modes(info.media, audio, '1080p')).toEqual(['1080p', '1080p', '1080p'])
  const hd = { container: 'avi', tracks: [{ ...video, height: 720 }, audio] }
  expect(modes(hd, audio, 'auto')).not.toContain('4k')
  expect(modes(hd, audio, '4k')).toEqual(['4k', '4k', '4k'])
})

test('resolves audio and subtitle defaults independently and falls through unavailable languages', async () => {
  const { selectPlaybackAudio, selectPlaybackSubtitle } = await import('./web-playback.service')
  const flags = { default: false, forced: false, hearingImpaired: false }
  const audio = [
    { kind: 'audio' as const, index: 0, language: 'eng', ...flags },
    { kind: 'audio' as const, index: 1, language: 'jpn', ...flags }
  ]
  const subtitles = [
    { id: 'forced', format: 'text' as const, language: 'eng', forced: true },
    { id: 'english', format: 'text' as const, language: 'eng' },
    { id: 'japanese', format: 'text' as const, language: 'jpn' }
  ]
  const defaults = [
    { scope: 'file' as const, audioLanguage: 'fr', subtitleLanguage: 'en' },
    { scope: 'season' as const, audioLanguage: 'ja', subtitleLanguage: 'off' },
    { scope: 'show' as const, audioLanguage: 'en', subtitleLanguage: 'ja' }
  ]
  const account = (audioLanguage: string | null, subtitleLanguage: string | null, mode: 'default' | 'forced' | 'off') =>
    ({ audioLanguage, subtitleLanguage, subtitles: mode })
  expect(selectPlaybackAudio(audio, defaults, account('en', null, 'default'))?.index).toBe(1)
  expect(selectPlaybackSubtitle(subtitles, defaults, account(null, 'ja', 'off'))).toBe('english')
  expect(selectPlaybackSubtitle(subtitles, [{ ...defaults[0], subtitleLanguage: 'fr' }, ...defaults.slice(1)], account(null, 'ja', 'default')))
    .toBe('')
  expect(selectPlaybackAudio(audio, defaults.slice(0, 1), account('en', null, 'default'))?.index).toBe(0)
  const ordered = [{ ...defaults[0], audioLanguage: 'fr, eng, ja', subtitleLanguage: 'fr, ja, en' }, ...defaults.slice(1)]
  expect(selectPlaybackAudio(audio, ordered, account('ja', null, 'default'))?.index).toBe(0)
  expect(selectPlaybackSubtitle(subtitles, ordered, account(null, 'en', 'off'))).toBe('japanese')
  // Account preferences apply only when no saved default matches, and may list several languages.
  expect(selectPlaybackAudio(audio, [], account('fr, ja', null, 'default'))?.index).toBe(1)
  expect(selectPlaybackSubtitle(subtitles, [], account(null, 'fr, ja', 'default'))).toBe('japanese')
  expect(selectPlaybackSubtitle(subtitles, [], account(null, 'en', 'forced'))).toBe('forced')
  expect(selectPlaybackSubtitle(subtitles, [], account(null, 'ja', 'off'))).toBe('')

})

test('casts what every Chromecast decodes: H.264 to 1080p with stereo AAC, converting only what does not fit', async () => {
  const { castPlayback } = await import('./web-playback.service')
  const flags = { default: true, forced: false, hearingImpaired: false }
  const h264 = { index: 0, kind: 'video' as const, codec: 'h264', height: 1080, pixelFormat: 'yuv420p', ...flags }
  const stereo = { index: 1, kind: 'audio' as const, codec: 'aac', channels: 2, ...flags }
  const surround = { ...stereo, codec: 'eac3', channels: 6 }
  const info: WebPlaybackInfo = {
    languageDefaults: [], preferences: { audioLanguage: null, subtitleLanguage: null, subtitles: 'default' },
    media: { container: 'matroska', tracks: [h264, stereo] },
    qualities: ['original', 'remux', '4k', '1080p', '720p'], position: 0, subtitles: [], audioConversion: true
  }
  const cast = (tracks: typeof info.media.tracks, container = 'matroska', base = info) =>
    castPlayback({ ...base, media: { container, tracks } }, tracks.find((track) => track.kind === 'audio'))
  expect(cast([h264, stereo], 'mp4')).toEqual({ mode: 'original' })
  expect(cast([h264, stereo])).toEqual({ mode: 'remux' })
  expect(cast([h264, surround])).toEqual({ mode: 'audio', sound: 'stereo' })
  // HEVC, 4K, ten-bit or HDR is transcoded to H.264 at no more than 1080p.
  expect(cast([{ ...h264, codec: 'hevc', height: 2160, pixelFormat: 'yuv420p10le', colorTransfer: 'smpte2084' }, surround])).toEqual({ mode: '1080p', sound: 'stereo' })
  expect(cast([{ ...h264, codec: 'hevc', height: 720 }, stereo])).toEqual({ mode: '720p', sound: 'stereo' })
  // With conversion off, only a file that already fits can be cast.
  expect(cast([{ ...h264, codec: 'hevc' }, stereo], 'matroska', { ...info, qualities: ['original'], audioConversion: false })).toBeUndefined()
})
