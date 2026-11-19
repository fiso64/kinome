import { ACCOUNT_EXCLUDED_LOCATIONS_SQL } from '../media-read-model.sql'
import type { Migration } from './types'

export const migration: Migration = {
  version: 11,
  name: 'materialize account location exclusions',
  up(db) {
    db.exec(ACCOUNT_EXCLUDED_LOCATIONS_SQL)
  }
}
