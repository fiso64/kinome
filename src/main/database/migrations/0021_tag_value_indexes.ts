import { TAG_VALUE_INDEX_SQL } from '../schema'
import type { Migration } from './types'

export const migration: Migration = {
  version: 21,
  name: 'index tag values for rules, search, and suggestions',
  up(db) {
    // The composite primary keys already index item_id for item-scoped reads.
    db.exec('DROP INDEX IF EXISTS idx_item_tags_item_id; DROP INDEX IF EXISTS idx_item_virtual_tags_item_id;')
    db.exec(TAG_VALUE_INDEX_SQL)
  }
}
