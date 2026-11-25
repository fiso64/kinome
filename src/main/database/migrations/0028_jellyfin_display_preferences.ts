import { DISPLAY_PREFERENCES_SQL } from '../../jellyfin/display-preferences.sql'
import type { Migration } from './types'

export const migration: Migration = {
  version: 28,
  name: 'store Jellyfin client display preferences',
  up(db) {
    db.exec(DISPLAY_PREFERENCES_SQL)
  }
}
