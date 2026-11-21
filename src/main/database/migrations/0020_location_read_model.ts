import { MEDIA_ITEMS_READ_MODEL_SQL } from '../media-read-model.sql'
import type { Migration } from './types'

export const migration: Migration = {
  version: 20,
  name: 'reuse the item row when ranking its locations',
  up(db) {
    db.exec('DROP VIEW IF EXISTS media_items_read')
    db.exec(MEDIA_ITEMS_READ_MODEL_SQL)
  }
}
