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

export async function readSettings(): Promise<Settings> {
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

export async function writeSettings(settings: Partial<Settings>): Promise<void> {
  const settingsPath = getSettingsPath()
  try {
    const currentSettings = await readSettings()
    const newSettings = { ...currentSettings, ...settings }
    await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2))
    console.log(`Settings successfully saved to ${settingsPath}`)
  } catch (error) {
    console.error(`Failed to write settings to ${settingsPath}:`, error)
  }
}
