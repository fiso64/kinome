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
