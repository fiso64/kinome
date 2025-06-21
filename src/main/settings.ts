import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import type { DefaultLayoutKey, Settings, StoredViewSettings } from '../shared/types'
import { DEFAULT_LAYOUTS_CONFIG, LAYOUT_SPECIFIC_SETTINGS_CONFIG } from '../shared/types'
import { getLibraryDataPath } from './paths'

const GLOBAL_SETTINGS_FILE_NAME = 'settings.json'
const LIBRARY_SETTINGS_FILE_NAME = 'library-settings.json'
const DEFAULT_API_KEY_B64 = 'ZDRjNDk4OWQwZmI4Njc1MmY1ZDc1MzczZjExZGIwNmU='
const DEFAULT_API_KEY = Buffer.from(DEFAULT_API_KEY_B64, 'base64').toString('utf-8')

function getGlobalSettingsPath(): string {
  return path.join(app.getPath('userData'), GLOBAL_SETTINGS_FILE_NAME)
}

function getLibrarySettingsPath(): string {
  const libraryPath = getLibraryDataPath()
  return path.join(libraryPath, LIBRARY_SETTINGS_FILE_NAME)
}

// Helper to read a single settings file and return its content or null
async function readSettingsFile(filePath: string): Promise<Partial<Settings> | null> {
  try {
    const data = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function readRawSettings(): Promise<Settings> {
  const defaultSettings: Settings = {
    playerCommand: 'mpv {PATH}',
    tmdbApiKey: '',
    useLogos: true,
    creditsDisplay: 'tab',
    virtualTags: [],
    defaultLayoutSettings: JSON.parse(JSON.stringify(LAYOUT_SPECIFIC_SETTINGS_CONFIG)),
    defaultLayouts: {
      _default: { layout: 'grid' },
      movie: { layout: 'tree' },
      tv: { layout: 'tabs' },
      season: { layout: 'list' }
    }
  }

  // --- Start with defaults ---
  let finalSettings = defaultSettings

  // --- Read and merge settings files ---
  const librarySettings = await readSettingsFile(getLibrarySettingsPath())
  const globalSettings = await readSettingsFile(getGlobalSettingsPath())

  // --- MIGRATION LOGIC: Only apply to global settings file ---
  if (globalSettings?.defaultViewSettings) {
    console.log('[Settings] Migrating old view settings from settings.json to new format.')
    globalSettings.defaultLayouts = {
      _default: (globalSettings as any).defaultViewSettings,
      movie: (globalSettings as any).defaultMovieViewSettings,
      tv: (globalSettings as any).defaultTvShowViewSettings,
      season: (globalSettings as any).defaultSeasonViewSettings
    }
    delete (globalSettings as any).defaultViewSettings
    delete (globalSettings as any).defaultMovieViewSettings
    delete (globalSettings as any).defaultTvShowViewSettings
    delete (globalSettings as any).defaultSeasonViewSettings
  }

  // --- Deep merge settings: default -> library -> global ---
  const settingsToMerge = [librarySettings, globalSettings].filter(
    (s): s is Partial<Settings> => s !== null
  )

  for (const saved of settingsToMerge) {
    const mergedLayouts = (Object.keys(DEFAULT_LAYOUTS_CONFIG) as DefaultLayoutKey[]).reduce(
      (acc, key) => {
        acc[key] = { ...finalSettings.defaultLayouts[key], ...saved.defaultLayouts?.[key] }
        return acc
      },
      finalSettings.defaultLayouts
    )

    finalSettings = {
      ...finalSettings,
      ...saved,
      defaultLayoutSettings: {
        grid: {
          ...finalSettings.defaultLayoutSettings.grid,
          ...saved.defaultLayoutSettings?.grid
        },
        list: {
          ...finalSettings.defaultLayoutSettings.list,
          ...saved.defaultLayoutSettings?.list
        },
        tabs: {
          ...finalSettings.defaultLayoutSettings.tabs,
          ...saved.defaultLayoutSettings?.tabs
        },
        sections: {
          ...finalSettings.defaultLayoutSettings.sections,
          ...saved.defaultLayoutSettings?.sections
        }
      },
      defaultLayouts: mergedLayouts
    }
  }

  return finalSettings
}

export async function readSettings(): Promise<Settings> {
  const settings = await readRawSettings()
  if (!settings.tmdbApiKey) {
    settings.tmdbApiKey = DEFAULT_API_KEY
  }
  return settings
}

export async function writeSettings(settings: Partial<Settings>): Promise<void> {
  const settingsPath = getLibrarySettingsPath()
  try {
    // Ensure library data directory exists before writing
    await fs.mkdir(getLibraryDataPath(), { recursive: true })

    const currentSettings = await readRawSettings()
    // Create a mutable copy with a partial type to allow for property deletion.
    const settingsToSave: Partial<Settings> = { ...currentSettings, ...settings }

    // If the API key is the default one, remove it before saving
    // so it doesn't get written to the file.
    if (settingsToSave.tmdbApiKey === DEFAULT_API_KEY) {
      delete settingsToSave.tmdbApiKey
    }

    await fs.writeFile(settingsPath, JSON.stringify(settingsToSave, null, 2))
    console.log(`Settings successfully saved to ${settingsPath}`)
  } catch (error) {
    console.error(`Failed to write settings to ${settingsPath}:`, error)
  }
}
