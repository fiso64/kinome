import type { Migration } from './types'

export const migration: Migration = {
  version: 14,
  name: 'index inode and device lookups during scans',
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_media_locations_inode_device_type
      ON media_locations(inode, device_id, type)
    `)
  }
}
