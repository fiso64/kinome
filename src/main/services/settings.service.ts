import path, { dirname, resolve as resolvePath } from 'path'
import fs from 'fs/promises'
import { Database } from 'bun:sqlite'
import equal from 'fast-deep-equal'
import { PREDEFINED_VTAGS } from './predefined-vtags'
import type {
  Settings,
  ServerSettings,
  LibrarySettings,
  GlobalConfig
} from '@shared/types'
import { SERVER_SETTING_KEYS, LAYOUT_SPECIFIC_SETTINGS_CONFIG } from '@shared/types'
import {
  getLibraryDataPath,
  isRemoteLibrary,
  resolveLibraryPath,
  isRemotePath,
  getUserDataPath
} from './paths.service'
import { SerializedQueue } from '../utils/concurrency'

const GLOBAL_SETTINGS_FILE_NAME = 'settings.json'
const LIBRARY_SETTINGS_FILE_NAME = 'library-settings.json'
const DEFAULT_STRING_B = 'ZDRjNDk4OWQwZm4kqI4Njc1MmY1ZDc1MzczZjExZGIwNmU=' // make bots work for it a little
const DEFAULT_STRING = Buffer.from(DEFAULT_STRING_B.replace('4kq', ''), 'base64').toString('utf-8')

let cachedSettings: Settings | null = null
let cachedAbsoluteSourcePaths: Map<string, string> | null = null

/**
 * Invalidates all in-memory settings caches.
 */
export function invalidateSettingsCaches(): void {
  cachedSettings = null
  cachedAbsoluteSourcePaths = null
}

const globalSettingsQueue = new SerializedQueue()
const librarySettingsQueue = new SerializedQueue()

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
  return p
}

function getLibrarySettingsPath(): string | null {
  return resolveLibraryPath(LIBRARY_SETTINGS_FILE_NAME)
}

// Helper to read a single settings file and return its content or an empty object
async function readSettingsFile(filePath: string | null): Promise<Partial<Settings>> {
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
        const row = db.query(`SELECT 1 FROM items WHERE id = 'virtual-library-root' LIMIT 1`).get()
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
  console.log('[Settings] readGlobalSettings')
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
  invalidateSettingsCaches()
  return globalSettingsQueue.run(async () => {
    console.log('[Settings] writeGlobalSettings')
    cachedSettings = null // Invalidate cache
    const settingsPath = getGlobalSettingsPath()
    if (!settingsPath) return // Can't write global settings for remote library
    try {
      const currentSettings = await readGlobalSettings()

      // Perform a selective merge: only overwrite if the new value is NOT undefined.
      // This prevents partial updates from wiping existing global settings.
      const merged = { ...currentSettings }
      for (const [key, value] of Object.entries(settings)) {
        if (value !== undefined) {
          ; (merged as any)[key] = value
        }
      }

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

      await fs.writeFile(settingsPath, JSON.stringify(configToSave, null, 2), 'utf-8')
      console.log(`Global settings successfully saved to ${settingsPath}`)
    } catch (error) {
      console.error(`Failed to write global settings to ${settingsPath}:`, error)
      throw error
    }
  })
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
  console.log('[Settings] readRawSettings')
  const defaultSettings: Settings = {
    playerCommands: [],
    customActions: [],
    tmdbApiKey: '',
    useLogos: true,
    creditsDisplay: 'tab',
    grayOutWatched: true,
    showContinueWatching: true,
    showNextUp: true,
    virtualTags: [],
    libraryLocation: '',
    mediaSources: [],
    shadowSources: false,
    shadowMinDepth: 1,
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
    serverHost: '::'
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
          console.warn(
            `[Settings] Library setting tried to override global field "${key}". Ignoring.`
          )
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

  if (!finalSettings.libraryLocation) {
    finalSettings.libraryLocation = getLibraryDataPath()
  }

  // Merge predefined vtags: predefined entries come first, user tags with the
  // same ID (i.e. user-modified versions) override them.
  const userVtagIds = new Set((finalSettings.virtualTags ?? []).map((t) => t.id))
  finalSettings.virtualTags = [
    ...PREDEFINED_VTAGS.filter((p) => !userVtagIds.has(p.id)),
    ...(finalSettings.virtualTags ?? [])
  ]

  return finalSettings
}

/**
 * The main public function to get the fully resolved settings.
 * Also handles applying the default API key if none is provided.
 */
/**
 * Returns a copy of the settings safe to send to the client — sensitive fields removed.
 */
export function sanitizeForClient(settings: Settings): Omit<Settings, 'adminPasswordHash'> {
  const { adminPasswordHash: _, ...sanitized } = settings as any
  return sanitized
}

export async function readSettings(): Promise<Settings> {
  if (cachedSettings) return cachedSettings

  const settings = await readRawSettings()
  if (!settings.tmdbApiKey) {
    settings.tmdbApiKey = DEFAULT_STRING
  }
  cachedSettings = settings
  return settings
}

/**
 * Writes settings to the library-specific settings file.
 * Global settings like `libraryLocation` should be written via `writeGlobalSettings`.
 * @param settings The partial settings object to save.
 */
export async function writeLibrarySettings(settings: Partial<Settings>): Promise<void> {
  invalidateSettingsCaches()
  return librarySettingsQueue.run(async () => {
    console.log('[Settings] writeLibrarySettings')

    if (isRemoteLibrary()) {
      console.warn('[Settings] Skipping write to library-settings.json for remote library.')
      return
    }

    const settingsPath = getLibrarySettingsPath()
    if (!settingsPath) {
      console.error('[Settings] Cannot write library settings: Invalid path (Path Traversal?)')
      return
    }
    try {
      // Ensure library data directory exists before writing
      await fs.mkdir(getLibraryDataPath(), { recursive: true })

      const currentSettings = await readSettingsFile(settingsPath)
      const settingsToSave: Partial<Settings> = { ...currentSettings, ...settings }

      // Strip predefined vtags that are identical to their defaults — they don't
      // need to be persisted unless the user has actually modified them.
      if (settingsToSave.virtualTags) {
        settingsToSave.virtualTags = settingsToSave.virtualTags.filter((tag) => {
          const predefined = PREDEFINED_VTAGS.find((p) => p.id === tag.id)
          return !predefined || !equal(tag, predefined)
        })
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
      throw error
    }
  })
}

/**
 * Service-layer logic for saving settings changes, handling path relativity
 * and virtual tag updates. This is called by the IPC transport handler.
 * Does not handle library location changes.
 * @param settingsToSave The partial settings object to save.
 */
export async function saveSettingsChanges(settingsToSave: Partial<Settings>): Promise<void> {
  console.log('[Settings Service] Saving settings. Identifying server vs library changes.')

  const serverChanges: Partial<Settings> = {}
  const libraryChanges: Partial<Settings> = {}

  for (const [key, value] of Object.entries(settingsToSave)) {
    if ((SERVER_SETTING_KEYS as string[]).includes(key)) {
      ; (serverChanges as any)[key] = value
    } else {
      ; (libraryChanges as any)[key] = value
    }
  }

  // Update global settings if any server-level keys were provided
  if (Object.keys(serverChanges).length > 0) {
    console.log(
      `[Settings Service] Applying server-level changes: ${Object.keys(serverChanges).join(', ')}`
    )
    await writeGlobalSettings(serverChanges)
  }

  const settingsForCurrentLibrary = libraryChanges

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

/**
 * Resolves the absolute path for a single MediaSource entry.
 */
async function resolveSourcePath(sourcePath: string, isRelative: boolean): Promise<string> {
  const isPhysicallyRelative = !path.isAbsolute(sourcePath) && !isRemoteLibrary()
  if (isRelative || isPhysicallyRelative) {
    const libraryPath = getLibraryDataPath()
    if (!libraryPath) return sourcePath
    if (isRemoteLibrary()) {
      const parentUrl = new URL('..', libraryPath)
      return new URL(sourcePath, parentUrl).toString()
    }
    return resolvePath(dirname(libraryPath), sourcePath)
  }
  return sourcePath
}

/**
 * Returns the resolved absolute path for a single media source by its UUID.
 * Returns null if no source with that ID is configured.
 */
export async function getAbsoluteSourcePath(sourceId: string): Promise<string | null> {
  const paths = await getAbsoluteSourcePaths()
  return paths.get(sourceId) ?? null
}

/**
 * Returns a Map of sourceId -> resolved absolute path for all configured media sources.
 */
export async function getAbsoluteSourcePaths(): Promise<Map<string, string>> {
  if (cachedAbsoluteSourcePaths) return cachedAbsoluteSourcePaths

  const settings = await readSettings()
  const result = new Map<string, string>()
  for (const source of settings.mediaSources ?? []) {
    result.set(source.id, await resolveSourcePath(source.path, source.isRelative))
  }
  cachedAbsoluteSourcePaths = result
  return result
}

export async function resolveMediaSourcePath(
  mediaPath: string,
  isRelative: boolean,
  baseLibraryPath?: string
): Promise<{ path: string; exists: boolean }> {
  let resolved: string

  if (isRemotePath(mediaPath) || path.isAbsolute(mediaPath)) {
    resolved = mediaPath
  } else if (isRelative) {
    const libraryPath = baseLibraryPath || getLibraryDataPath()
    const isRemote = isRemotePath(libraryPath)

    if (isRemote) {
      const normalizedLibraryPath = libraryPath.endsWith('/') ? libraryPath : libraryPath + '/'
      const parentUrl = new URL('..', normalizedLibraryPath)
      resolved = new URL(mediaPath, parentUrl).toString()
    } else {
      resolved = resolvePath(dirname(libraryPath), mediaPath)
    }
  } else {
    // If not absolute and not marked as relative, treat as literal.
    // We do NOT call path.resolve() to avoid falling back to CWD.
    resolved = mediaPath
  }

  return {
    path: resolved,
    exists:
      isRelative || path.isAbsolute(resolved) || isRemotePath(resolved)
        ? await checkPathExists(resolved)
        : false
  }
}

export async function checkPathExists(absolutePath: string): Promise<boolean> {
  if (isRemotePath(absolutePath)) return true

  try {
    const s = await fs.stat(absolutePath)
    return s.isDirectory() || s.isFile()
  } catch {
    return false
  }
}

export async function createDirectory(absolutePath: string): Promise<void> {
  await fs.mkdir(absolutePath, { recursive: true })
}
