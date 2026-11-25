import { AUTH_TOKENS_SQL } from '../auth-tokens.sql'
import type { Migration } from './types'

export const migration: Migration = {
  version: 27,
  name: 'persist sign-in sessions and API keys',
  up(db) {
    db.exec(AUTH_TOKENS_SQL)
  }
}
