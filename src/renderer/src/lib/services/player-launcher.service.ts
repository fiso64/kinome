import { getPlaylistUrl } from '../api'
import type { MediaFile, PlayerCommandConfig } from '@shared/types'
import { notificationStore } from '../notification-store.svelte'

export const BUILTIN_COPY_LINK: PlayerCommandConfig = {
  id: 'builtin:copy-link',
  name: 'Copy Playlist Link',
  command: 'builtin:copy-link',
  isBuiltIn: true
}

/**
 * Resolves the ordered list of players available on this device.
 *
 * - `enabledPlayerIds` is the client-local ordered list (from clientSettingsStore).
 * - `serverDefs` is the server-side catalog of custom player definitions.
 * - The built-in copy-link player is always included, appended at the end if not
 *   explicitly positioned in `enabledPlayerIds`.
 * - Stale IDs (referring to deleted server definitions) are silently dropped.
 */
export function resolveClientPlayers(
  serverDefs: PlayerCommandConfig[],
  enabledPlayerIds: string[]
): PlayerCommandConfig[] {
  const defsById = new Map(serverDefs.map((p) => [p.id, p]))
  const result: PlayerCommandConfig[] = []
  const seen = new Set<string>()

  for (const id of enabledPlayerIds) {
    if (id === BUILTIN_COPY_LINK.id) {
      result.push(BUILTIN_COPY_LINK)
      seen.add(id)
    } else {
      const def = defsById.get(id)
      if (def) {
        result.push(def)
        seen.add(id)
      }
    }
  }

  // Built-in is always available even if omitted from enabledPlayerIds
  if (!seen.has(BUILTIN_COPY_LINK.id)) {
    result.push(BUILTIN_COPY_LINK)
  }

  return result
}

export const playerLauncherService = {
  /**
   * Executes the default player or a specific command for a media item.
   * Pass the resolved client player list (from resolveClientPlayers) as `commands`.
   * The first entry in the list is the implicit default.
   */
  async playItem(
    file: MediaFile,
    commands: PlayerCommandConfig[],
    preferredCommand?: PlayerCommandConfig
  ): Promise<void> {
    const playlistUrl = getPlaylistUrl(file.id)

    const commandToExecute = preferredCommand ?? commands[0] ?? BUILTIN_COPY_LINK

    if (commandToExecute.command === 'builtin:copy-link') {
      try {
        await navigator.clipboard.writeText(playlistUrl)
        notificationStore.add('Playlist link copied to clipboard!', 'success')
      } catch (err) {
        console.error('Failed to copy playlist link', err)
        notificationStore.add('Failed to copy link. Check browser permissions.', 'error')
      }
      return
    }

    try {
      const secret = localStorage.getItem('kinome_client_secret')
      if (!secret) {
        notificationStore.add('Kinome handler not set up. Please visit settings.', 'error')
        return
      }

      const resolvedCommand = commandToExecute.command.replace('<url>', playlistUrl)
      const encodedCommand = btoa(resolvedCommand)
      const protocolUrl = `kinome://run?secret=${encodeURIComponent(secret)}&command=${encodeURIComponent(encodedCommand)}`

      window.location.href = protocolUrl
      notificationStore.add(`Launching ${commandToExecute.name}...`, 'success')
    } catch (err) {
      console.error('Failed to launch player', err)
      notificationStore.add('Failed to launch player. Check handler installation.', 'error')
    }
  }
}
