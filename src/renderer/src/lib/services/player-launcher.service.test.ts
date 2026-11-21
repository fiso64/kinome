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
      fetch: async () => new Response('#EXTM3U', {
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
      })
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

test('tries the original before lossy fallback and preserves compatible audio at source resolution', async () => {
  const { playbackAttempts } = await import('./web-playback.service')
  const flags = { default: true, forced: false, hearingImpaired: false }
  const video = { index: 0, kind: 'video' as const, codec: 'mpeg4', height: 2160, ...flags }
  const audio = { index: 1, kind: 'audio' as const, codec: 'aac', channels: 6, ...flags }
  const info: WebPlaybackInfo = {
    media: { container: 'avi', tracks: [video, audio] },
    qualities: ['original', 'remux', '4k', '1080p'],
    position: 0, subtitles: [], audioConversion: true
  }
  const player = { canPlayType: (type: string) =>
    type.includes('mpegurl') || type.includes('mp4a') ? 'probably' : '' } as HTMLVideoElement
  expect(playbackAttempts(player, { ...info, qualities: ['original'], audioConversion: false }, audio, audio)
    .map(attempt => attempt.mode)).toEqual(['original'])
  const attempts = playbackAttempts(player, info, audio, audio)
  expect(attempts.map(attempt => attempt.mode).slice(0, 2)).toEqual(['original', 'remux'])
  expect(attempts[2]).toMatchObject({ mode: '4k', sound: 'copy' })
  expect(attempts.findIndex(attempt => attempt.mode === '1080p')).toBeGreaterThan(1)

  const unsupported = { ...audio, codec: 'dts' }
  info.media = { container: 'avi', tracks: [video, unsupported, { ...audio, index: 2, default: false }] }
  // This client cannot identify or select the track that its native demuxer picked.
  expect(playbackAttempts(player, info, unsupported, unsupported).some(attempt => attempt.mode === 'original')).toBe(false)
})
