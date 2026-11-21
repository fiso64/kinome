import { CREDIT_PERSON_INDEX_SQL } from '../schema'
import { tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 22,
  name: 'index person-to-title credit lookups',
  up(db) {
    if (!tableExists(db, 'credits')) return
    db.exec('DROP INDEX IF EXISTS idx_credits_entity_id')
    db.exec(CREDIT_PERSON_INDEX_SQL)
  }
}
