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

test('tries the original before lossy fallback and preserves compatible audio at source resolution', async () => {
  const { playbackAttempts } = await import('./web-playback.service')
  const flags = { default: true, forced: false, hearingImpaired: false }
  const video = { index: 0, kind: 'video' as const, codec: 'mpeg4', height: 2160, ...flags }
  const audio = { index: 1, kind: 'audio' as const, codec: 'aac', channels: 6, ...flags }
  const info: WebPlaybackInfo = {
    languageDefaults: [],
    preferences: { audioLanguage: null, subtitleLanguage: null, subtitles: 'default' },
    media: { container: 'avi', tracks: [video, audio] },
    qualities: ['original', 'remux', '4k', '1080p'],
    position: 0, subtitles: [], audioConversion: true
  }
  const player = { canPlayType: (type: string) =>
    type.includes('mpegurl') || type.includes('mp4a') ? 'probably' : '' } as HTMLVideoElement
  expect(playbackAttempts(player, { ...info, qualities: ['original'], audioConversion: false }, audio, audio, 'source')
    .map(attempt => attempt.mode)).toEqual(['original'])
  const attempts = playbackAttempts(player, info, audio, audio, 'source')
  expect(attempts.map(attempt => attempt.mode).slice(0, 2)).toEqual(['original', 'remux'])
  expect(attempts[2]).toMatchObject({ mode: '4k', sound: 'copy' })
  expect(attempts.findIndex(attempt => attempt.mode === '1080p')).toBeGreaterThan(1)

  const unsupported = { ...audio, codec: 'dts' }
  info.media = { container: 'avi', tracks: [video, unsupported, { ...audio, index: 2, default: false }] }
  // This client cannot identify or select the track that its native demuxer picked.
  expect(playbackAttempts(player, info, unsupported, unsupported, 'auto').some(attempt => attempt.mode === 'original')).toBe(false)
  const vorbis = { ...audio, codec: 'vorbis' }
  const opus = { ...audio, index: 2, codec: 'opus', default: false }
  const webm = { ...info, media: { container: 'matroska', tracks: [{ ...video, codec: 'vp8' }, vorbis, opus] } }
  const webmPlayer = { canPlayType: (type: string) => type.startsWith('audio/webm') ? 'probably' : '' } as HTMLVideoElement
  expect(playbackAttempts(webmPlayer, webm, vorbis, vorbis, 'source')[0]).toEqual({ mode: 'original', checkAudio: false })
  expect(playbackAttempts(webmPlayer, webm, opus, vorbis, 'source').some(attempt => attempt.mode === 'original')).toBe(false)
  const h264 = { ...video, codec: 'h264' }
  const hlsPlayer = { canPlayType: (type: string) => type.includes('avc1') ? 'probably' : player.canPlayType(type) } as HTMLVideoElement
  const compatibleVideo = { ...info, media: { container: 'matroska', tracks: [h264, unsupported, { ...audio, index: 2 }] } }
  expect(playbackAttempts(hlsPlayer, compatibleVideo, unsupported, unsupported, 'source').slice(0, 3)
    .map(attempt => attempt.mode)).toEqual(['remux', 'audio', 'audio'])
  expect(playbackAttempts(player, info, audio, audio, '1080p').map(attempt => attempt.mode)).toEqual(['1080p', '1080p', '1080p'])
  const hd = { ...info, media: { container: 'avi', tracks: [{ ...video, height: 720 }, audio] } }
  expect(playbackAttempts(player, hd, audio, audio, 'auto').some(attempt => attempt.mode === '4k')).toBe(false)
  expect(playbackAttempts(player, hd, audio, audio, '4k').map(attempt => attempt.mode)).toEqual(['4k', '4k', '4k'])
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
