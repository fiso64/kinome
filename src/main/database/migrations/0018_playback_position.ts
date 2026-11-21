import { columnExists, tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 18,
  name: 'persist browser playback position',
  up(db) {
    if (tableExists(db, 'user_state') && !columnExists(db, 'user_state', 'playback_position')) {
      db.exec('ALTER TABLE user_state ADD COLUMN playback_position REAL NOT NULL DEFAULT 0')
    }
  }
}
