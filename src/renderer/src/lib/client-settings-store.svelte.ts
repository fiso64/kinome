import type { WebQualityChoice } from '@shared/web-playback'

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
  audioLanguage: string
  subtitleLanguage: string
  subtitles: 'default' | 'forced' | 'off'
  playerVolume: number
  playerMuted: boolean
}

const DEFAULTS: ClientSettings = {
  enabledPlayerIds: [],
  webQuality: 'auto',
  audioLanguage: '',
  subtitleLanguage: '',
  subtitles: 'default',
  playerVolume: 1,
  playerMuted: false
}

function load(): ClientSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
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
    this._settings = { ...this._settings, ...patch }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._settings))
  }
}

export const clientSettingsStore = new ClientSettingsStore()
