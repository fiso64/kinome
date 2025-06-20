import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'

export interface ViewSettings {
  layout: 'grid' | 'list' | 'tree' | 'tabs' | 'sections'
  clickAction: 'detail' | 'navigate'
  groupBy: string
}

export interface Settings {
  playerCommand: string
  tmdbApiKey: string
  useLogos?: boolean
  virtualTags?: { name: string; expression: string }[]
  gridPosterSize?: number
  defaultViewSettings: ViewSettings
  defaultMovieViewSettings: ViewSettings
  defaultTvShowViewSettings: ViewSettings
  defaultSeasonViewSettings: ViewSettings
}

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
    gridPosterSize: 200,
    defaultViewSettings: { layout: 'grid', clickAction: 'detail', groupBy: 'folder' },
    defaultMovieViewSettings: { layout: 'tree', clickAction: 'detail', groupBy: 'folder' },
    defaultTvShowViewSettings: { layout: 'list', clickAction: 'detail', groupBy: 'folder' },
    defaultSeasonViewSettings: { layout: 'list', clickAction: 'detail', groupBy: 'folder' }
  }

  try {
    const data = await fs.readFile(getSettingsPath(), 'utf-8')
    const saved = JSON.parse(data)

    // Deep merge the view settings to ensure all properties exist
    const merged: Settings = {
      ...defaultSettings,
      ...saved,
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

    // Clean up legacy properties if they exist
    delete (merged as any).defaultFolderLayout
    delete (merged as any).defaultMovieFolderLayout
    delete (merged as any).defaultTvShowFolderLayout
    delete (merged as any).defaultSeasonFolderLayout

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
