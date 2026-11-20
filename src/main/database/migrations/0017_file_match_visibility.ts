import { MEDIA_ITEMS_READ_MODEL_SQL } from '../media-read-model.sql'
import type { Migration } from './types'

export const migration: Migration = {
  version: 17,
  name: 'expose account visibility to playable file matches',
  up(db) {
    db.exec('DROP VIEW IF EXISTS media_items_read')
    db.exec(MEDIA_ITEMS_READ_MODEL_SQL)
  }
}
