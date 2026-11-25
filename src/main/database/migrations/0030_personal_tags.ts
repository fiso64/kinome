import { PERSONAL_TAGS_SQL } from '../personal-tags.sql'
import { tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 30,
  name: 'store personal tags per account',
  up(db) {
    if (!tableExists(db, 'accounts') || !tableExists(db, 'media_items')) return
    db.exec(PERSONAL_TAGS_SQL)
  }
}
