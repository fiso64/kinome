import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import type { Settings } from '../shared/types'
import { LAYOUT_SPECIFIC_SETTINGS_CONFIG } from '../shared/types'

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
    // New structured defaults are based on the single source of truth
    defaultLayoutSettings: JSON.parse(JSON.stringify(LAYOUT_SPECIFIC_SETTINGS_CONFIG)),
    // Type-specific overrides start as empty objects
    defaultViewSettings: { layout: 'grid' },
    defaultMovieViewSettings: { layout: 'tree' },
    defaultTvShowViewSettings: { layout: 'tabs' },
    defaultSeasonViewSettings: { layout: 'list' }
  }

  try {
    const data = await fs.readFile(getSettingsPath(), 'utf-8')
    const saved = JSON.parse(data)

    // Deep merge the saved settings over the defaults.
    const merged: Settings = {
      ...defaultSettings,
      ...saved,
      defaultLayoutSettings: {
        grid: { ...defaultSettings.defaultLayoutSettings.grid, ...saved.defaultLayoutSettings?.grid },
        tabs: { ...defaultSettings.defaultLayoutSettings.tabs, ...saved.defaultLayoutSettings?.tabs },
        sections: {
          ...defaultSettings.defaultLayoutSettings.sections,
          ...saved.defaultLayoutSettings?.sections
        }
      },
      defaultViewSettings: { ...defaultSettings.defaultViewSettings, ...saved.defaultViewSettings },
      defaultMovieViewSettings: {
        ...defaultSettings.defaultMovieViewSettings,
        ...saved.defaultMovieViewSettings
      },
      defaultTvShowViewSettings: {
        ...defaultSettings.defaultTvShowViewSettings,
        ...saved.defaultTvShowViewSettings
      },
      defaultSeasonViewSettings: {
        ...defaultSettings.defaultSeasonViewSettings,
        ...saved.defaultSeasonViewSettings
      }
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
