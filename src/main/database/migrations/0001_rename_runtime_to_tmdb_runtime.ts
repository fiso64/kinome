import { columnExists, tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 1,
  name: 'rename media_entities.runtime to tmdb_runtime',
  up: (db) => {
    if (!tableExists(db, 'media_entities')) return

    const hasRuntime = columnExists(db, 'media_entities', 'runtime')
    const hasTmdbRuntime = columnExists(db, 'media_entities', 'tmdb_runtime')

    if (hasRuntime && !hasTmdbRuntime) {
      db.exec('ALTER TABLE media_entities RENAME COLUMN runtime TO tmdb_runtime')
    } else if (!hasTmdbRuntime) {
      db.exec('ALTER TABLE media_entities ADD COLUMN tmdb_runtime INTEGER')
    }
  }
}
