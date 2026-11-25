import { columnExists, tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 25,
  name: 'store account playback preferences',
  up(db) {
    if (!tableExists(db, 'accounts') || columnExists(db, 'accounts', 'subtitle_mode')) return
    db.exec(`
      ALTER TABLE accounts ADD COLUMN audio_language TEXT;
      ALTER TABLE accounts ADD COLUMN subtitle_language TEXT;
      ALTER TABLE accounts ADD COLUMN subtitle_mode TEXT NOT NULL DEFAULT 'default'
        CHECK(subtitle_mode IN ('default', 'forced', 'off'));
    `)
  }
}
