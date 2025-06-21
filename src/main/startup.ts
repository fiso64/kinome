import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { setLibraryDataPath } from './paths'

// This code runs IMMEDIATELY when the module is imported,
// before any other code in the importing file (index.ts) runs.

const globalSettingsPath = path.join(app.getPath('userData'), 'settings.json')

try {
  // We MUST use a synchronous read here, as we cannot use `await` at the top level.
  // This is acceptable for a tiny, critical config file at startup.
  if (fs.existsSync(globalSettingsPath)) {
    const data = fs.readFileSync(globalSettingsPath, 'utf-8')
    const settings = JSON.parse(data)
    if (settings.libraryLocation) {
      setLibraryDataPath(settings.libraryLocation)
    }
  }
} catch (e) {
  // If the file doesn't exist or is corrupt, we'll just use the default path.
  // This is expected on first run, so we don't need to log an error.
  console.log('[Startup] No valid global settings file found. Using default library path.')
}