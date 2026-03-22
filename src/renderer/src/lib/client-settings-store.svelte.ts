const STORAGE_KEY = 'kinome:client-settings'

/**
 * Settings that are local to this browser/device and are never synced to the server.
 */
export interface ClientSettings {
  /**
   * IDs of custom players available on this device, in preference order.
   * The first entry is the implicit default. Empty means only the web player is used.
   * Must reference valid player IDs from the server-side player definitions.
   */
  enabledPlayerIds: string[]
}

const DEFAULTS: ClientSettings = {
  enabledPlayerIds: []
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
