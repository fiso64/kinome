/**
 * SETTINGS REPOSITORY (Folder Contextual Behavior)
 * Owns the 'folder_settings' table. Handles view configurations and scraper behavior.
 */
import { getDb } from '../client'
import { parseJsonSafe } from '../mappers'

/**
 * Fetches folder settings raw row.
 */
export function fetchSettings(itemId: string): any {
  const db = getDb()
  return db.prepare('SELECT * FROM folder_settings WHERE item_id = ?').get(itemId)
}

/**
 * MERGES partial updates into existing folder settings.
 * Uses Object.assign to preserve nested keys (e.g. childViewSettings, virtualFolderSettings).
 * If you need full replacement, write a separate replaceSettings function.
 */
export function mergeSettings(itemId: string, updates: any): void {
  const db = getDb()
  const existing = (db.prepare('SELECT * FROM folder_settings WHERE item_id = ?').get(itemId) as any) || {}

  // IMPORTANT: We MERGE partial updates into the existing JSON blob, not replace.
  // This preserves nested keys like childViewSettings and virtualFolderSettings.
  const viewSettings = parseJsonSafe(existing.view_settings_json, {})
  if (updates.viewSettings !== undefined && updates.viewSettings !== null) {
    Object.assign(viewSettings, updates.viewSettings)
  }

  const scraperSettings = parseJsonSafe(existing.scraper_settings_json, {})
  if (updates.scraperSettings !== undefined && updates.scraperSettings !== null) {
    Object.assign(scraperSettings, updates.scraperSettings)
  }

  db.prepare(
    `
    INSERT INTO folder_settings(item_id, view_settings_json, scraper_settings_json)
    VALUES(@id, @view, @scraper)
    ON CONFLICT(item_id) DO UPDATE SET
      view_settings_json = excluded.view_settings_json,
      scraper_settings_json = excluded.scraper_settings_json
    `
  ).run({
    '@id': itemId,
    '@view': JSON.stringify(viewSettings),
    '@scraper': JSON.stringify(scraperSettings)
  })
}

/**
 * Filesystem: Updates folder scraper settings.
 */
export function updateFolderScraperSettings(id: string, settings: any): void {
  mergeSettings(id, { scraperSettings: settings })
}
