import path from 'path'
import fs from 'fs'
import {
  setLibraryDataPath,
  setUserDataPath,
  reinitializeDefaultLibraryPath
} from './paths.service'

/**
 * Initializes the application services by setting up paths and loading settings.
 * This function is now decoupled from Electron and can be called from any entry point.
 * @param userDataPath The path where application data (settings, DB) should be stored.
 */
export function initializeStartup(userDataPath: string): void {
  // Step 1: Provide the user data path to the agnostic paths service.
  setUserDataPath(userDataPath)
  reinitializeDefaultLibraryPath() // Now the default library path is relative to userData.

  // Step 2: Read the global settings to see if a custom library path is set.
  const globalSettingsPath = path.join(userDataPath, 'settings.json')

  try {
    // We use a synchronous read here as this is a tiny, critical config file at startup.
    if (fs.existsSync(globalSettingsPath)) {
      const data = fs.readFileSync(globalSettingsPath, 'utf-8')
      const settings = JSON.parse(data)
      if (settings.libraryLocation) {
        setLibraryDataPath(settings.libraryLocation)
      }
    }
  } catch (e) {
    // If the file doesn't exist or is corrupt, we'll just use the default path.
    console.log('[Startup] No valid global settings file found. Using default library path.')
  }
}
