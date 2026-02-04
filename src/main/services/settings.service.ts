import path, { dirname, relative, resolve as resolvePath } from 'path'
import fs from 'fs/promises'
import { Database } from 'bun:sqlite'
import type { MediaFolder, MediaFile, LibraryItem, Settings, LibraryStatus, ServerSettings, LibrarySettings, GlobalConfig } from '../../shared/types'
import { SERVER_SETTING_KEYS, LAYOUT_SPECIFIC_SETTINGS_CONFIG } from '../../shared/types'
import {
  getLibraryDataPath,
  isRemoteLibrary,
  resolveLibraryPath,
  isRemotePath,
  getUserDataPath
} from './paths.service'

const GLOBAL_SETTINGS_FILE_NAME = 'settings.json'
const LIBRARY_SETTINGS_FILE_NAME = 'library-settings.json'
const DEFAULT_STRING_B = 'ZDRjNDk4OWQwZm4kqI4Njc1MmY1ZDc1MzczZjExZGIwNmU=' // make bots work for it a little
const DEFAULT_STRING = Buffer.from(DEFAULT_STRING_B.replace('4kq', ''), 'base64').toString('utf-8')

// This is now private. The transport layer doesn't need to know the exact path.
function getGlobalSettingsPath(): string {
  // Global settings are always in the app's user data directory,
  // regardless of where the library data is located.
  if (isRemoteLibrary()) {
    // Remote libraries do not have a corresponding local global settings file in this context.
    // A client connecting to a remote server would have its own local settings.
    // For the desktop app, a remote library means we can't write global settings.
    return ''
  }
  const userDataPath = getUserDataPath()
  const p = path.join(userDataPath, GLOBAL_SETTINGS_FILE_NAME)
  console.log(`[Settings] Global settings path: ${p}`)
  return p
}

function getLibrarySettingsPath(): string {
  return resolveLibraryPath(LIBRARY_SETTINGS_FILE_NAME)
}

// Helper to read a single settings file and return its content or an empty object
async function readSettingsFile(filePath: string): Promise<Partial<Settings>> {
  if (!filePath) return {}
  try {
    let data: string
    if (isRemotePath(filePath)) {
      const response = await fetch(filePath)
      if (!response.ok) {
        // A 404 is a normal "file not found" case for remote files.
        if (response.status !== 404) {
          console.warn(`[Settings] Failed to fetch ${filePath}: ${response.statusText}`)
        }
        return {}
      }
      data = await response.text()
    } else {
      data = await fs.readFile(filePath, 'utf-8')
    }
    return JSON.parse(data)
  } catch (e) {
    // This catches fs errors (e.g. file not found), network errors, and JSON parsing errors.
    return {}
  }
}

/**
 * Checks if a library exists at the given path.
 * A library is considered to exist if it has a library-settings.json file.
 */
export async function checkLibraryExists(libraryPath: string): Promise<{
  exists: boolean
  settingsExists: boolean
  dbExists: boolean
  settings?: Partial<Settings>
}> {
  if (!libraryPath) return { exists: false, settingsExists: false, dbExists: false }

  let settingsFileUrl = ''
  let dbFileUrl = ''
  const isRemote = isRemotePath(libraryPath)
  if (isRemote) {
    const baseUrl = libraryPath.endsWith('/') ? libraryPath : libraryPath + '/'
    settingsFileUrl = new URL(LIBRARY_SETTINGS_FILE_NAME, baseUrl).toString()
    dbFileUrl = new URL('library.db', baseUrl).toString()
  } else {
    settingsFileUrl = path.join(libraryPath, LIBRARY_SETTINGS_FILE_NAME)
    dbFileUrl = path.join(libraryPath, 'library.db')
  }

  const settings = await readSettingsFile(settingsFileUrl)
  const settingsExists = Object.keys(settings).length > 0
  let dbExists = false
  if (!isRemote) {
    try {
      await fs.access(dbFileUrl)
      // Check if it's a valid DB with a root
      const db = new Database(dbFileUrl, { readonly: true })
      try {
        const row = db.query('SELECT 1 FROM items WHERE parent_id IS NULL LIMIT 1').get()
        dbExists = !!row
      } finally {
        db.close()
      }
    } catch {
      dbExists = false
    }
  } else {
    // For remote, we assume if settings exist, it's a library.
    dbExists = settingsExists
  }

  return {
    exists: settingsExists || dbExists,
    settingsExists,
    dbExists,
    settings: settingsExists ? settings : undefined
  }
}

/**
 * Reads only the global settings file and handles migration if needed.
 */
export async function readGlobalSettings(): Promise<Settings> {
  const filePath = getGlobalSettingsPath()
  const raw = (await readSettingsFile(filePath)) as any

  // No migration code allowed. Expect only the new nested structure.
  if (raw.server && raw.libraryDefaults) {
    return {
      ...(raw.server as ServerSettings),
      ...(raw.libraryDefaults as LibrarySettings)
    }
  }

  return {} as Settings
}

/**
 * Writes only to the global settings file using the nested structure.
 * @param settings The flat settings object to save (it will be split).
 */
export async function writeGlobalSettings(settings: Partial<Settings>): Promise<void> {
  const settingsPath = getGlobalSettingsPath()
  if (!settingsPath) return // Can't write global settings for remote library
  try {
    const currentSettings = await readGlobalSettings()
    const merged = { ...currentSettings, ...settings }

    if (merged.libraryLocation) {
      merged.libraryLocation = merged.libraryLocation.replace(/\\/g, '/')
    }

    // Split into Server and Library parts
    const server: Partial<ServerSettings> = {}
    const libraryDefaults: Partial<LibrarySettings> = {}

    // Distribute fields based on SERVER_SETTING_KEYS
    for (const key of Object.keys(merged)) {
      if ((SERVER_SETTING_KEYS as string[]).includes(key)) {
        ; (server as any)[key] = (merged as any)[key]
      } else {
        ; (libraryDefaults as any)[key] = (merged as any)[key]
      }
    }

    const configToSave: GlobalConfig = {
      server: server as ServerSettings,
      libraryDefaults: libraryDefaults as LibrarySettings
    }

    await fs.writeFile(settingsPath, JSON.stringify(configToSave, null, 2))
    console.log(`Global settings successfully saved to ${settingsPath}`)
  } catch (error) {
    console.error(`Failed to write global settings to ${settingsPath}:`, error)
  }
}

/**
 * Helper to perform a one-level deep merge on nested objects within a settings object.
 */
function mergeNestedObjects<T extends Record<string, any>>(
  base: T,
  override: Partial<T> | undefined
): T {
  if (!override) return base
  const result = { ...base }
  for (const key in base) {
    if (Object.prototype.hasOwnProperty.call(base, key) && override[key]) {
      result[key] = { ...base[key], ...override[key] }
    }
  }
  return result
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
    customActions: [],
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
    searchPopupView: { layout: 'list', listDescriptionRows: 2 },
    itemDetailBackdropSize: 'small',
    itemDetailBackdropBlur: 4,
    allowUnauthenticated: false,
    serverPort: 3000,
    allowedIPs: []
  }

  // --- Start with defaults ---
  let finalSettings = defaultSettings

  // --- Read Files ---
  const globalSettings = await readGlobalSettings()
  const librarySettings = await readSettingsFile(getLibrarySettingsPath())

  // --- Deep merge settings: default -> library -> global ---
  const settingsToMerge = [librarySettings, globalSettings]

  for (const saved of settingsToMerge) {
    // SECURITY: Ensure library settings cannot override global-only fields.
    // We filter 'saved' if it's the library-settings object.
    const isLibrarySettings = saved === librarySettings
    const filteredSaved = { ...saved }
    if (isLibrarySettings) {
      for (const key of SERVER_SETTING_KEYS) {
        if ((key as any) in filteredSaved) {
          console.warn(`[Settings] Library setting tried to override global field "${key}". Ignoring.`)
          delete (filteredSaved as any)[key]
        }
      }
    }

    finalSettings = {
      ...finalSettings,
      ...filteredSaved,
      defaultLayoutSettings: mergeNestedObjects(
        finalSettings.defaultLayoutSettings,
        filteredSaved.defaultLayoutSettings
      ),
      defaultLayouts: mergeNestedObjects(finalSettings.defaultLayouts, filteredSaved.defaultLayouts)
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
  if (isRemoteLibrary()) {
    console.warn('[Settings] Skipping write to library-settings.json for remote library.')
    return
  }

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
    // Never save global-only fields to library settings.
    for (const key of SERVER_SETTING_KEYS) {
      delete (settingsToSave as any)[key]
    }

    await fs.writeFile(settingsPath, JSON.stringify(settingsToSave, null, 2))
    console.log(`Library settings successfully saved to ${settingsPath}`)
  } catch (error) {
    console.error(`Failed to write library settings to ${settingsPath}:`, error)
  }
}

/**
 * Service-layer logic for saving settings changes, handling path relativity
 * and virtual tag updates. This is called by the IPC transport handler.
 * Does not handle library location changes.
 * @param settingsToSave The partial settings object to save.
 */
export async function saveSettingsChanges(settingsToSave: Partial<Settings>): Promise<void> {
  console.log('[Settings Service] Saving settings for current library.')
  const oldSettings = await readSettings()

  // Create a copy, excluding libraryLocation as it's handled separately.
  const {
    libraryLocation,
    allowUnauthenticated,
    serverPort,
    allowedIPs,
    ...settingsForCurrentLibrary
  } = settingsToSave

  // Update global settings if provided
  if (
    libraryLocation !== undefined ||
    allowUnauthenticated !== undefined ||
    serverPort !== undefined ||
    allowedIPs !== undefined
  ) {
    await writeGlobalSettings({ libraryLocation, allowUnauthenticated, serverPort, allowedIPs })
  }

  // Handle media path relativity conversion
  const newRelativity = settingsForCurrentLibrary.mediaSourcePathIsRelative
  const oldRelativity = oldSettings.mediaSourcePathIsRelative

  if (
    newRelativity !== undefined &&
    newRelativity !== oldRelativity &&
    oldSettings.mediaSourcePath
  ) {
    console.log(`[Settings Service] Converting mediaSourcePath relativity. New: ${newRelativity}`)
    if (newRelativity === true) {
      // from absolute to relative
      if (oldSettings.libraryLocation) {
        let relativePath = relative(
          dirname(oldSettings.libraryLocation),
          oldSettings.mediaSourcePath
        )
        relativePath = relativePath.replace(/\\/g, '/')
        settingsForCurrentLibrary.mediaSourcePath =
          relativePath === ''
            ? '.'
            : relativePath.startsWith('../')
              ? relativePath
              : './' + relativePath
      }
    } else {
      // from relative to absolute
      if (oldSettings.libraryLocation) {
        settingsForCurrentLibrary.mediaSourcePath = resolvePath(
          dirname(oldSettings.libraryLocation),
          oldSettings.mediaSourcePath
        )
      }
    }
  }

  if (Object.keys(settingsForCurrentLibrary).length > 0) {
    await writeLibrarySettings(settingsForCurrentLibrary)
  }
}

// --- FS Wrappers ---
// These functions wrap node:fs/promises to be used by the transport layer,
// keeping the fs logic within the service layer.

export async function renameFS(oldPath: string, newPath: string): Promise<void> {
  return fs.rename(oldPath, newPath)
}

export async function getAbsoluteMediaSourcePath(): Promise<string | null> {
  const settings = await readSettings()
  if (!settings.mediaSourcePath) {
    return null
  }

  // Treat as relative if the flag is true OR if the path is physically not absolute
  // (and it's not a remote library, although remote libs usually force relative flag)
  const isPhysicallyRelative = !path.isAbsolute(settings.mediaSourcePath) && !isRemoteLibrary()

  if (settings.mediaSourcePathIsRelative || isPhysicallyRelative) {
    const libraryPath = getLibraryDataPath()
    if (!libraryPath) return settings.mediaSourcePath

    if (isRemoteLibrary()) {
      // For remote paths, resolve relative to the parent URL, mimicking path.dirname().
      // libraryPath for remote is guaranteed to have a trailing slash by paths.service.
      const parentUrl = new URL('..', libraryPath)
      return new URL(settings.mediaSourcePath, parentUrl).toString()
    } else {
      return resolvePath(dirname(libraryPath), settings.mediaSourcePath)
    }
  }

  return settings.mediaSourcePath
}

export async function resolveMediaSourcePath(
  mediaPath: string,
  isRelative: boolean
): Promise<string> {
  if (!isRelative || isRemotePath(mediaPath) || path.isAbsolute(mediaPath)) {
    return mediaPath
  }

  const libraryPath = getLibraryDataPath()
  if (isRemoteLibrary()) {
    const parentUrl = new URL('..', libraryPath)
    return new URL(mediaPath, parentUrl).toString()
  } else {
    return resolvePath(dirname(libraryPath), mediaPath)
  }
}
