import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import type { DefaultLayoutKey, Settings } from '../shared/types'
import { DEFAULT_LAYOUTS_CONFIG, LAYOUT_SPECIFIC_SETTINGS_CONFIG } from '../shared/types'
import { getLibraryDataPath } from './paths'

const GLOBAL_SETTINGS_FILE_NAME = 'settings.json'
const LIBRARY_SETTINGS_FILE_NAME = 'library-settings.json'
const DEFAULT_STRING_B = 'ZDRjNDk4OWQwZm4kqI4Njc1MmY1ZDc1MzczZjExZGIwNmU=' // make bots work for it a little
const DEFAULT_STRING = Buffer.from(DEFAULT_STRING_B.replace('4kq', ''), 'base64').toString('utf-8')

function getGlobalSettingsPath(): string {
  return path.join(app.getPath('userData'), GLOBAL_SETTINGS_FILE_NAME)
}

function getLibrarySettingsPath(): string {
  const libraryPath = getLibraryDataPath()
  return path.join(libraryPath, LIBRARY_SETTINGS_FILE_NAME)
}

// Helper to read a single settings file and return its content or an empty object
async function readSettingsFile(filePath: string): Promise<Partial<Settings>> {
  try {
    const data = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return {}
  }
}

/**
 * Reads only the global settings file.
 */
export async function readGlobalSettings(): Promise<Partial<Settings>> {
  return await readSettingsFile(getGlobalSettingsPath())
}

/**
 * Writes only to the global settings file.
 * @param settings The partial settings object to save.
 */
export async function writeGlobalSettings(settings: Partial<Settings>): Promise<void> {
  const settingsPath = getGlobalSettingsPath()
  try {
    const currentSettings = await readGlobalSettings()
    const settingsToSave = { ...currentSettings, ...settings }
    if (settingsToSave.libraryLocation) {
      settingsToSave.libraryLocation = settingsToSave.libraryLocation.replace(/\\/g, '/')
    }
    await fs.writeFile(settingsPath, JSON.stringify(settingsToSave, null, 2))
    console.log(`Global settings successfully saved to ${settingsPath}`)
  } catch (error) {
    console.error(`Failed to write global settings to ${settingsPath}:`, error)
  }
}

/**
 * Reads and merges settings from defaults, global, and library-specific files.
 * @returns A fully populated Settings object.
 */
async function readRawSettings(): Promise<Settings> {
  const defaultSettings: Settings = {
    playerCommands: [
      { id: crypto.randomUUID(), name: 'Default Player', command: 'mpv "{PATH}" --fullscreen' }
    ],
    tmdbApiKey: '',
    useLogos: true,
    creditsDisplay: 'tab',
    grayOutWatched: true,
    showContinueWatching: true,
    showNextUp: true,
    virtualTags: [],
    libraryLocation: '',
    mediaSourcePath: '',
    mediaSourcePathIsRelative: false,
    defaultLayoutSettings: JSON.parse(JSON.stringify(LAYOUT_SPECIFIC_SETTINGS_CONFIG)),
    defaultLayouts: {
      _default: { layout: 'grid' },
      movie: { layout: 'tree' },
      tv: { layout: 'tabs' },
      season: { layout: 'list', listDescriptionRows: 3 }
    },
    searchResultView: { layout: 'list', listDescriptionRows: 5 },
    searchPopupView: { layout: 'list', listDescriptionRows: 2 }
  }

  // --- Start with defaults ---
  let finalSettings = defaultSettings

  // --- Read settings files ---
  const librarySettings = await readSettingsFile(getLibrarySettingsPath())
  const globalSettings = await readGlobalSettings()

  // --- MIGRATION LOGIC: Only apply to global settings file ---
  if ((globalSettings as any)?.defaultViewSettings) {
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
    // Persist migrated settings
    await writeGlobalSettings(globalSettings)
  }

  // --- Deep merge settings: default -> library -> global ---
  const settingsToMerge = [librarySettings, globalSettings]

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
        'horizontal-grid': {
          ...finalSettings.defaultLayoutSettings['horizontal-grid'],
          ...saved.defaultLayoutSettings?.['horizontal-grid']
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

/**
 * The main public function to get the fully resolved settings.
 * Also handles applying the default API key if none is provided.
 */
export async function readSettings(): Promise<Settings> {
  const settings = await readRawSettings()
  if (!settings.tmdbApiKey) {
    settings.tmdbApiKey = DEFAULT_STRING
  }
  return settings
}

/**
 * Writes settings to the library-specific settings file.
 * Global settings like `libraryLocation` should be written via `writeGlobalSettings`.
 * @param settings The partial settings object to save.
 */
export async function writeLibrarySettings(settings: Partial<Settings>): Promise<void> {
  const settingsPath = getLibrarySettingsPath()
  try {
    // Ensure library data directory exists before writing
    await fs.mkdir(getLibraryDataPath(), { recursive: true })

    const currentSettings = await readSettingsFile(settingsPath)
    const settingsToSave: Partial<Settings> = { ...currentSettings, ...settings }

    if (settingsToSave.mediaSourcePath) {
      settingsToSave.mediaSourcePath = settingsToSave.mediaSourcePath.replace(/\\/g, '/')
    }

    // If the API key is the default one, remove it before saving
    // so it doesn't get written to the file.
    if (settingsToSave.tmdbApiKey === DEFAULT_STRING) {
      delete settingsToSave.tmdbApiKey
    }
    // Never save libraryLocation to library settings.
    delete settingsToSave.libraryLocation

    await fs.writeFile(settingsPath, JSON.stringify(settingsToSave, null, 2))
    console.log(`Library settings successfully saved to ${settingsPath}`)
  } catch (error) {
    console.error(`Failed to write library settings to ${settingsPath}:`, error)
  }
}
