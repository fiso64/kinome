import { MEDIA_ITEMS_READ_MODEL_SQL } from '../media-read-model.sql'
import { EFFECTIVE_METADATA, EFFECTIVE_METADATA_VIEW_SQL } from '../item-metadata.sql'
import { tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 13,
  name: 'use indexed reads for locations, metadata, and next up',
  up(db) {
    db.exec('DROP VIEW IF EXISTS media_items_read')
    db.exec(MEDIA_ITEMS_READ_MODEL_SQL)
    db.exec(`DROP VIEW IF EXISTS ${EFFECTIVE_METADATA}`)
    db.exec(EFFECTIVE_METADATA_VIEW_SQL())
    if (tableExists(db, 'user_state')) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_user_state_next_up_by_user
        ON user_state(user_id, item_id) WHERE next_up_episode_id IS NOT NULL
      `)
    }
  }
}
