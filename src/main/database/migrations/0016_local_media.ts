import { LOCAL_MEDIA_SQL } from '../local-media.sql'
import { tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 16,
  name: 'cache local media facts per physical location',
  up(db) {
    if (tableExists(db, 'media_locations')) db.exec(LOCAL_MEDIA_SQL)
  }
}
