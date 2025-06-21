import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import type { DefaultLayoutKey, Settings, StoredViewSettings } from '../shared/types'
import { DEFAULT_LAYOUTS_CONFIG, LAYOUT_SPECIFIC_SETTINGS_CONFIG } from '../shared/types'

const SETTINGS_FILE_NAME = 'settings.json'

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILE_NAME)
}

async function readRawSettings(): Promise<Settings> {
  const defaultSettings: Settings = {
    playerCommand: 'mpv {PATH}',
    tmdbApiKey: '',
    useLogos: true,
    virtualTags: [],
    defaultLayoutSettings: JSON.parse(JSON.stringify(LAYOUT_SPECIFIC_SETTINGS_CONFIG)),
    defaultLayouts: {
      _default: { layout: 'grid' },
      movie: { layout: 'tree' },
      tv: { layout: 'tabs' },
      season: { layout: 'list' }
    }
  }

  try {
    const data = await fs.readFile(getSettingsPath(), 'utf-8')
    const saved = JSON.parse(data)

    // --- MIGRATION LOGIC from old format ---
    if (saved.defaultViewSettings) {
      console.log('[Settings] Migrating old view settings to new format.')
      saved.defaultLayouts = {
        _default: saved.defaultViewSettings,
        movie: saved.defaultMovieViewSettings,
        tv: saved.defaultTvShowViewSettings,
        season: saved.defaultSeasonViewSettings
      }
      delete saved.defaultViewSettings
      delete saved.defaultMovieViewSettings
      delete saved.defaultTvShowViewSettings
      delete saved.defaultSeasonViewSettings
    }
    // --- END MIGRATION LOGIC ---

    // Dynamically merge default layouts from the config
    const mergedLayouts = (Object.keys(DEFAULT_LAYOUTS_CONFIG) as DefaultLayoutKey[]).reduce(
      (acc, key) => {
        acc[key] = { ...defaultSettings.defaultLayouts[key], ...saved.defaultLayouts?.[key] }
        return acc
      },
      {} as { [K in DefaultLayoutKey]: StoredViewSettings }
    )

    // Deep merge the saved settings over the defaults.
    const merged: Settings = {
      ...defaultSettings,
      ...saved,
      defaultLayoutSettings: {
        grid: {
          ...defaultSettings.defaultLayoutSettings.grid,
          ...saved.defaultLayoutSettings?.grid
        },
        list: {
          ...defaultSettings.defaultLayoutSettings.list,
          ...saved.defaultLayoutSettings?.list
        },
        tabs: {
          ...defaultSettings.defaultLayoutSettings.tabs,
          ...saved.defaultLayoutSettings?.tabs
        },
        sections: {
          ...defaultSettings.defaultLayoutSettings.sections,
          ...saved.defaultLayoutSettings?.sections
        }
      },
      defaultLayouts: mergedLayouts
    }
    return merged
  } catch {
    // File doesn't exist or is corrupt, return defaults.
    return defaultSettings
  }
}

export async function readSettings(): Promise<Settings> {
  const settings = await readRawSettings()
  if (!settings.tmdbApiKey) {
    try {
      const DEFAULT_API_KEY_B64 = 'ZDRjNDk4OWQwZmI4Njc1MmY1ZDc1MzczZjExZGIwNmU='
      settings.tmdbApiKey = Buffer.from(DEFAULT_API_KEY_B64, 'base64').toString('utf-8')
    } catch (e) {
      console.error('[Settings] Failed to decode default API key.', e)
    }
  }
  return settings
}

export async function writeSettings(settings: Partial<Settings>): Promise<void> {
  const settingsPath = getSettingsPath()
  try {
    const currentSettings = await readRawSettings()
    const newSettings = { ...currentSettings, ...settings }
    await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2))
    console.log(`Settings successfully saved to ${settingsPath}`)
  } catch (error) {
    console.error(`Failed to write settings to ${settingsPath}:`, error)
  }
}
