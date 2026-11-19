import type { Migration } from './types'

export const migration: Migration = {
  version: 12,
  name: 'remove legacy entity-owned tags',
  up(db) {
    db.exec('DROP TABLE IF EXISTS entity_virtual_tags; DROP TABLE IF EXISTS entity_tags;')
  }
}
