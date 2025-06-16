import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'

export interface Settings {
  playerCommand: string
  tmdbApiKey: string
}

const SETTINGS_FILE_NAME = 'settings.json'

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILE_NAME)
}

async function readRawSettings(): Promise<Settings> {
  const defaultSettings: Settings = {
    playerCommand: 'mpv {PATH}',
    tmdbApiKey: ''
  }
  try {
    const data = await fs.readFile(getSettingsPath(), 'utf-8')
    return { ...defaultSettings, ...JSON.parse(data) }
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
