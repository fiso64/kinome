import type { Database } from 'bun:sqlite'
import { migration as renameRuntimeToTmdbRuntime } from './migrations/0001_rename_runtime_to_tmdb_runtime'
import { migration as addMediaItemsAndLocations } from './migrations/0002_add_media_items_and_locations'
import { migration as addMediaItemsFts } from './migrations/0003_add_media_items_fts'
import { migration as retargetItemStateForeignKeys } from './migrations/0004_retarget_item_state_foreign_keys'
import { migration as addItemTags } from './migrations/0005_add_item_tags'
import { migration as dropLegacyItemsFts } from './migrations/0006_drop_legacy_items_fts'
import { migration as dropLegacyItemsTable } from './migrations/0007_drop_legacy_items_table'
import type { Migration } from './migrations/types'

export function getUserVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version ?? 0
}

function setUserVersion(db: Database, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`)
}

const MIGRATIONS: Migration[] = [
  renameRuntimeToTmdbRuntime,
  addMediaItemsAndLocations,
  addMediaItemsFts,
  retargetItemStateForeignKeys,
  addItemTags,
  dropLegacyItemsFts,
  dropLegacyItemsTable
]

export const DATABASE_MIGRATIONS = [...MIGRATIONS].sort((a, b) => a.version - b.version)
export const LATEST_SCHEMA_VERSION = DATABASE_MIGRATIONS[DATABASE_MIGRATIONS.length - 1]?.version ?? 0

export function getPendingMigrations(db: Database): Migration[] {
  const currentVersion = getUserVersion(db)
  return DATABASE_MIGRATIONS.filter((migration) => migration.version > currentVersion)
}

export function runMigrations(db: Database): void {
  const currentVersion = getUserVersion(db)
  const pending = getPendingMigrations(db)

  if (pending.length === 0) {
    console.log(`[Database] Schema version ${currentVersion}; no migrations pending.`)
    return
  }

  console.log(
    `[Database] Migrating schema from version ${currentVersion} to ${LATEST_SCHEMA_VERSION} (${pending.length} pending).`
  )

  const migrate = db.transaction(() => {
    for (const migration of pending) {
      console.log(`[Database] Applying migration ${migration.version}: ${migration.name}`)
      migration.up(db)
      setUserVersion(db, migration.version)
    }
  })

  try {
    migrate()
    console.log(`[Database] Schema migration complete. Current version: ${LATEST_SCHEMA_VERSION}.`)
  } catch (error) {
    console.error('[Database] Schema migration failed:', error)
    throw error
  }
}
