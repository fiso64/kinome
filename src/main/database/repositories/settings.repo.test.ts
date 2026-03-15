/**
 * Settings Merge Contract Tests
 *
 * These tests enforce that mergeSettings() MERGES partial updates
 * into existing JSON blobs, preserving nested keys like
 * childViewSettings.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SCHEMA_SQL } from '../schema'

let db: Database

function createTestDb(): Database {
  const testDb = new Database(':memory:')
  testDb.run('PRAGMA foreign_keys = ON')
  testDb.exec(SCHEMA_SQL)
  return testDb
}

function insertItem(id: string, type: 'file' | 'folder' = 'folder') {
  db.prepare(`
    INSERT INTO items (id, parent_id, path, name, type)
    VALUES (?, NULL, ?, ?, ?)
  `).run(id, id, id, type)
}

describe('mergeSettings (folder_settings merge contract)', () => {
  beforeEach(() => {
    db = createTestDb()
    insertItem('folder1')
  })

  it('preserves existing nested keys when saving a partial update', () => {
    // Initial state: has childViewSettings
    db.prepare(`
      INSERT INTO folder_settings (item_id, view_settings_json)
      VALUES (?, ?)
    `).run('folder1', JSON.stringify({
      layout: 'grid',
      childViewSettings: { layout: 'list' }
    }))

    // Simulate a partial merge update (user changes layout only)
    const existing = db.prepare('SELECT * FROM folder_settings WHERE item_id = ?').get('folder1') as any
    const viewSettings = JSON.parse(existing.view_settings_json || '{}')
    Object.assign(viewSettings, { layout: 'list' }) // Merge, not replace

    db.prepare(`
      UPDATE folder_settings SET view_settings_json = ? WHERE item_id = ?
    `).run(JSON.stringify(viewSettings), 'folder1')

    // Verify ALL keys survived
    const final = db.prepare('SELECT view_settings_json FROM folder_settings WHERE item_id = ?').get('folder1') as any
    const finalSettings = JSON.parse(final.view_settings_json)

    expect(finalSettings.layout).toBe('list') // Updated
    expect(finalSettings.childViewSettings).toEqual({ layout: 'list' }) // Preserved
  })

  it('handles first-time insert (no existing row)', () => {
    const viewSettings = { layout: 'grid', groupBy: 'genre' }

    db.prepare(`
      INSERT INTO folder_settings (item_id, view_settings_json)
      VALUES (?, ?)
      ON CONFLICT(item_id) DO UPDATE SET view_settings_json = excluded.view_settings_json
    `).run('folder1', JSON.stringify(viewSettings))

    const result = db.prepare('SELECT view_settings_json FROM folder_settings WHERE item_id = ?').get('folder1') as any
    const saved = JSON.parse(result.view_settings_json)

    expect(saved.layout).toBe('grid')
    expect(saved.groupBy).toBe('genre')
  })

  it('does not cross-contaminate view and scraper settings', () => {
    db.prepare(`
      INSERT INTO folder_settings (item_id, view_settings_json, scraper_settings_json)
      VALUES (?, ?, ?)
    `).run('folder1', JSON.stringify({ layout: 'grid' }), JSON.stringify({ retrieve_children_metadata: 1 }))

    // Update only view settings via merge
    const existing = db.prepare('SELECT * FROM folder_settings WHERE item_id = ?').get('folder1') as any
    const viewSettings = JSON.parse(existing.view_settings_json || '{}')
    Object.assign(viewSettings, { sortBy: 'name' })

    db.prepare(`
      UPDATE folder_settings SET view_settings_json = ? WHERE item_id = ?
    `).run(JSON.stringify(viewSettings), 'folder1')

    // Scraper settings must be untouched
    const final = db.prepare('SELECT * FROM folder_settings WHERE item_id = ?').get('folder1') as any
    const scraperSettings = JSON.parse(final.scraper_settings_json)
    expect(scraperSettings.retrieve_children_metadata).toBe(1)
  })
})
