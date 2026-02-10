import { getPlaylistUrl } from '../api'
import type { MediaFile, PlayerCommandConfig } from '@shared/types'
import { notificationStore } from '../notification-store.svelte'

export const playerLauncherService = {
  /**
   * Executes the default player or a specific command for a media item.
   * If commands list is empty, it falls back to a built-in clipboard copy.
   */
  async playItem(
    file: MediaFile,
    commands: PlayerCommandConfig[] | null,
    preferredCommand?: PlayerCommandConfig
  ): Promise<void> {
    const playlistUrl = getPlaylistUrl(file.id)

    // Choose the command to execute:
    // 1. Explicitly preferred command (from "Play with...")
    // 2. Primary command from the list (first item)
    // 3. Fallback to built-in copy-link if nothing else is available
    const commandToExecute =
      preferredCommand ||
      (commands && commands.length > 0
        ? commands[0]
        : {
            id: 'builtin:copy-link',
            name: 'Copy Playlist Link',
            command: 'builtin:copy-link',
            isBuiltIn: true
          })

    // 1. Handle Built-in Commands (Copy Link)
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

    // 2. Handle Local Player Commands (via kinome:// protocol)
    try {
      const secret = localStorage.getItem('kinome_client_secret')
      if (!secret) {
        notificationStore.add('Kinome handler not set up. Please visit settings.', 'error')
        return
      }

      // Resolve the <url> placeholder
      const resolvedCommand = commandToExecute.command.replace('<url>', playlistUrl)

      // Base64 encode the command string to ensure safe transmission through the URL
      const encodedCommand = btoa(resolvedCommand)

      // Construct the protocol URL
      const protocolUrl = `kinome://run?secret=${encodeURIComponent(secret)}&command=${encodeURIComponent(encodedCommand)}`

      // Trigger the local handler
      window.location.href = protocolUrl

      notificationStore.add(`Launching ${commandToExecute.name}...`, 'success')
    } catch (err) {
      console.error('Failed to launch player', err)
      notificationStore.add('Failed to launch player. Check handler installation.', 'error')
    }
  }
}
