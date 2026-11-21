import { availablePlaybackQualities } from '@shared/playback-quality'
import type { PlaybackQuality } from '@shared/playback-quality'
import type { Settings } from '@shared/types'
import { getPlaylistUrl, getPlaybackUrl } from '../api'
import type { MediaFile, PlayerCommandConfig } from '@shared/types'
import { notificationStore } from '../notification-store.svelte'

export const BUILTIN_COPY_PLAYLIST_LINK: PlayerCommandConfig = {
  id: 'builtin:copy-link',
  name: 'Copy Playlist Link',
  command: 'builtin:copy-link',
  isBuiltIn: true
}

export const BUILTIN_COPY_LINK: PlayerCommandConfig = {
  id: 'builtin:copy-stream-link',
  name: 'Copy Link',
  command: 'builtin:copy-stream-link',
  isBuiltIn: true
}

export const BUILTIN_WEB_PLAYER: PlayerCommandConfig = {
  id: 'builtin:web',
  name: 'Web Player',
  command: 'builtin:web',
  isBuiltIn: true
}

export const BUILTIN_PLAYER_COMMANDS = [BUILTIN_WEB_PLAYER, BUILTIN_COPY_PLAYLIST_LINK, BUILTIN_COPY_LINK]

/**
 * Resolves the ordered list of players available on this device.
 *
 * - `enabledPlayerIds` is the client-local ordered list (from clientSettingsStore).
 * - `serverDefs` is the server-side catalog of custom player definitions.
 * - The web player starts first on devices that have yet to position it.
 * - Missing link actions are appended in their default order.
 * - Stale IDs (referring to deleted server definitions) are silently dropped.
 */
export function resolveClientPlayers(
  serverDefs: PlayerCommandConfig[],
  enabledPlayerIds: string[]
): PlayerCommandConfig[] {
  const defsById = new Map(serverDefs.map((p) => [p.id, p]))
  const builtinsById = new Map(BUILTIN_PLAYER_COMMANDS.map((p) => [p.id, p]))
  const result: PlayerCommandConfig[] = []
  const seen = new Set<string>()

  for (const id of enabledPlayerIds) {
    const builtin = builtinsById.get(id)
    if (builtin) {
      result.push(builtin)
      seen.add(id)
    } else {
      const def = defsById.get(id)
      if (def) {
        result.push(def)
        seen.add(id)
      }
    }
  }

  if (!seen.has(BUILTIN_WEB_PLAYER.id)) {
    result.unshift(BUILTIN_WEB_PLAYER)
    seen.add(BUILTIN_WEB_PLAYER.id)
  }

  // Built-ins are always available even if omitted from enabledPlayerIds.
  for (const builtin of BUILTIN_PLAYER_COMMANDS) {
    if (!seen.has(builtin.id)) {
      result.push(builtin)
    }
  }

  return result
}

export function resolvePlaybackQuality(settings?: Settings | null): PlaybackQuality {
  const preferred = settings?.defaultPlaybackQuality ?? 'original'
  return availablePlaybackQualities(settings).includes(preferred) ? preferred : 'original'
}

class PlaybackUnavailableError extends Error {}

async function checkConvertedStream(url: string): Promise<void> {
  const signal = AbortSignal.timeout(95_000)
  try {
    const response = await fetch(url, { signal, redirect: 'error' })
    const contentType = response.headers.get('content-type')
    if (response.ok && contentType === 'application/vnd.apple.mpegurl') {
      await response.body?.cancel()
      return
    }
    if (response.status === 401 || response.status === 403) {
      throw new PlaybackUnavailableError('Access to this stream was denied. Check that you are signed in and have access to the file.')
    }
    if (!response.ok && contentType?.startsWith('text/plain')) {
      const detail = (await response.text()).trim()
      if (detail && detail.length <= 250) throw new PlaybackUnavailableError(detail)
    }
    await response.body?.cancel()
    throw new PlaybackUnavailableError(response.ok
      ? 'Kinome returned an unexpected playback response.'
      : `Kinome could not open the converted stream (HTTP ${response.status}).`)
  } catch (error) {
    if (error instanceof PlaybackUnavailableError) throw error
    throw new PlaybackUnavailableError(signal.aborted
      ? 'Checking the converted stream timed out.'
      : 'Could not reach Kinome to check the converted stream.')
  }
}

async function copyPlaybackLink(url: string, ready?: Promise<void>): Promise<void> {
  if (ready && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    // Safari needs clipboard.write to run during the click, before the network check completes.
    const data = ready.then(() => new Blob([url], { type: 'text/plain' }))
    void data.catch(() => {}) // The browser may refuse the write before consuming the data.
    const results = await Promise.allSettled([
      ready,
      navigator.clipboard.write([new ClipboardItem({ 'text/plain': data })])
    ])
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
    }
    return
  }
  if (ready) await ready
  await navigator.clipboard.writeText(url)
}

export const playerLauncherService = {
  async launchExternal(
    file: MediaFile,
    commandToExecute: PlayerCommandConfig,
    quality: PlaybackQuality = 'original'
  ): Promise<void> {
    const direct = commandToExecute.command === BUILTIN_COPY_LINK.command
    const copy = direct || commandToExecute.command === BUILTIN_COPY_PLAYLIST_LINK.command
    try {
      const secret = copy ? null : localStorage.getItem('kinome_client_secret')
      if (!copy && !secret) {
        notificationStore.add('Kinome handler not set up. Please visit settings.', 'error')
        return
      }
      const playbackUrl = getPlaybackUrl(file.id, file.name, quality)
      const url = direct ? playbackUrl : getPlaylistUrl(file.id, quality)
      const ready = quality === 'original' ? undefined : checkConvertedStream(playbackUrl)
      if (copy) {
        await copyPlaybackLink(url, ready)
        notificationStore.add(direct ? 'Link copied to clipboard!' : 'Playlist link copied to clipboard!', 'success')
        return
      }
      if (ready) await ready
      // Keep the entire URL in one shell argument, including its query string.
      // Templates can already quote the placeholder or an option such as "--playlist=<url>".
      const resolvedCommand = commandToExecute.command.replace(/"(?:\\.|[^"\\])*"|'[^']*'|<url>/g,
        (part) => part === '<url>' ? `"${url}"` : part.replaceAll('<url>', url))
      const encodedCommand = btoa(resolvedCommand)
      const protocolUrl = `kinome://run?secret=${encodeURIComponent(secret!)}&command=${encodeURIComponent(encodedCommand)}`

      window.location.href = protocolUrl
      notificationStore.add(`Launching ${commandToExecute.name}...`, 'success')
    } catch (err) {
      if (err instanceof PlaybackUnavailableError) {
        notificationStore.add(err.message, 'error', 8_000)
      } else {
        notificationStore.add(copy
          ? 'Failed to copy link. Check browser permissions.'
          : 'Failed to launch player. Check handler installation.', 'error')
      }
    }
  }
}
