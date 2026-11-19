import { MEDIA_ITEMS_READ_MODEL_SQL, SOURCE_PRIORITIES_SQL } from '../media-read-model.sql'
import type { Migration } from './types'

export const migration: Migration = {
  version: 10,
  name: 'rank present locations by configured source priority',
  up(db) {
    db.exec(SOURCE_PRIORITIES_SQL)
    db.exec('DROP VIEW IF EXISTS media_items_read')
    db.exec(MEDIA_ITEMS_READ_MODEL_SQL)
    db.exec('CREATE INDEX IF NOT EXISTS idx_media_locations_fingerprint ON media_locations(location_fingerprint)')
  }
}
