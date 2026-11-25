import { isWebQualityChoice, type WebQualityChoice } from '@shared/web-playback'

const STORAGE_KEY = 'kinome:client-settings'

/**
 * Settings that are local to this browser/device and are never synced to the server.
 */
export interface ClientSettings {
  /**
   * IDs of players available on this device, in preference order.
   * The first entry is the implicit default. An empty list uses the built-in order.
   * Must reference valid built-in or server-side player definition IDs.
   */
  enabledPlayerIds: string[]
  webQuality: WebQualityChoice
  /** Show the large play button over a paused video in the web player. */
  centerPlayButton: boolean
  playerVolume: number
  playerMuted: boolean
}

const DEFAULTS: ClientSettings = {
  enabledPlayerIds: [],
  webQuality: 'source',
  centerPlayButton: true,
  playerVolume: 1,
  playerMuted: false
}

function load(): ClientSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const saved = JSON.parse(raw)
    return { ...DEFAULTS, ...saved, webQuality: isWebQualityChoice(saved.webQuality) ? saved.webQuality : DEFAULTS.webQuality }
  } catch {
    return { ...DEFAULTS }
  }
}

class ClientSettingsStore {
  private _settings = $state<ClientSettings>(load())

  get settings(): ClientSettings {
    return this._settings
  }

  update(patch: Partial<ClientSettings>): void {
    const next = { ...this._settings, ...patch }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    this._settings = next
  }
}

export const clientSettingsStore = new ClientSettingsStore()
