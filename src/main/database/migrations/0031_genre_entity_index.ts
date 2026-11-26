import { GENRE_ENTITY_INDEX_SQL } from '../schema'
import { tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 31,
  name: 'index titles by genre',
  up(db) {
    if (!tableExists(db, 'entity_genres')) return
    db.exec(GENRE_ENTITY_INDEX_SQL)
  }
}
