import { Database } from 'bun:sqlite'
import fs from 'fs'
import * as pathsService from '../services/paths.service'
import { SCHEMA_SQL } from './schema'

let db: Database | null = null

/**
 * Initializes the database connection.
 * If the database file does not exist, it creates it and runs the schema.
 */
export function initializeDatabase(): Database {
  if (db) return db

  if (pathsService.isRemoteLibrary()) {
    throw new Error('Direct database connection is not supported for remote libraries.')
  }

  // Ensure the library directory exists
  const libraryPath = pathsService.getLibraryDataPath()
  fs.mkdirSync(libraryPath, { recursive: true })

  const dbPath = pathsService.resolveLibraryPath('library.db')
  console.log(`[Database] Connecting to ${dbPath}`)

  try {
    // Bun's Database automatically creates the file if it doesn't exist by default.
    db = new Database(dbPath, { create: true })

    // Performance optimizations
    db.run('PRAGMA journal_mode = WAL') // Better concurrency
    db.run('PRAGMA synchronous = NORMAL') // Faster writes with reasonable safety
    db.run('PRAGMA foreign_keys = ON') // Enforce constraints

    applySchema()

    // Auto-migration for dismissal flags
    try {
      db.run('ALTER TABLE user_state ADD COLUMN continue_watching_dismissed INTEGER DEFAULT 0')
    } catch {}
    try {
      db.run('ALTER TABLE user_state ADD COLUMN next_up_dismissed INTEGER DEFAULT 0')
    } catch {}
    try {
      db.run('ALTER TABLE metadata ADD COLUMN version INTEGER')
    } catch {}
    // V2 API Migrations
    try {
      db.run('ALTER TABLE metadata ADD COLUMN media_type TEXT')
    } catch {}
    try {
      db.run('ALTER TABLE metadata ADD COLUMN season_number INTEGER')
    } catch {}
    try {
      db.run('ALTER TABLE metadata ADD COLUMN episode_number INTEGER')
    } catch {}

    return db
  } catch (error) {
    console.error('[Database] Failed to initialize:', error)
    throw error
  }
}

/**
 * Applies the schema definition to the database.
 */
function applySchema() {
  if (!db) return
  try {
    db.exec(SCHEMA_SQL)
  } catch (e) {
    console.error('[Database] Failed to apply schema:', e)
    throw e
  }
}

export function getDb(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.')
  }
  return db
}

export function closeDatabase() {
  if (db) {
    console.log('[Database] Closing connection.')
    db.close()
    db = null
  }
}
