import { PLAYBACK_DEFAULTS_SQL } from '../playback-defaults.sql'
import type { Migration } from './types'

export const migration: Migration = {
  version: 19,
  name: 'store account playback language defaults',
  up(db) {
    db.exec(PLAYBACK_DEFAULTS_SQL)
  }
}
