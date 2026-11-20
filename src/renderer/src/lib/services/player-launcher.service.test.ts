import { beforeAll, describe, expect, test } from 'bun:test'
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

  test('enables built-in copy players by default in playlist-then-link order', () => {
    expect(launcher.resolveClientPlayers([], []).map((p) => p.id)).toEqual([
      launcher.BUILTIN_COPY_PLAYLIST_LINK.id,
      launcher.BUILTIN_COPY_LINK.id
    ])
  })

  test('appends missing built-ins after configured players in default order', () => {
    expect(launcher.resolveClientPlayers([mpv], [mpv.id]).map((p) => p.id)).toEqual([
      mpv.id,
      launcher.BUILTIN_COPY_PLAYLIST_LINK.id,
      launcher.BUILTIN_COPY_LINK.id
    ])
  })

  test('preserves explicit client ordering for custom and built-in players', () => {
    expect(
      launcher
        .resolveClientPlayers(
          [mpv, vlc],
          [launcher.BUILTIN_COPY_LINK.id, vlc.id, launcher.BUILTIN_COPY_PLAYLIST_LINK.id]
        )
        .map((p) => p.id)
    ).toEqual([launcher.BUILTIN_COPY_LINK.id, vlc.id, launcher.BUILTIN_COPY_PLAYLIST_LINK.id])
  })

  test('drops stale custom player ids while keeping built-ins available', () => {
    expect(launcher.resolveClientPlayers([mpv], ['deleted', mpv.id]).map((p) => p.id)).toEqual([
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
    await launcher.playerLauncherService.playItem(
      { id: 'movie', type: 'file', name: 'movie.mkv' },
      [{ id: 'test-player', name: 'Test Player', command: template }],
      undefined,
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
