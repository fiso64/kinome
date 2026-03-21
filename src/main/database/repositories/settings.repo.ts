/**
 * SETTINGS REPOSITORY (Folder Contextual Behavior)
 * Owns the 'folder_settings' table. Handles view configurations and folder behavior.
 */
import { getDb } from '../client'
import { parseJsonSafe } from '../mappers'
import type { FolderSettings, StoredViewSettings } from '@shared/types'

/**
 * Sets initial view settings for an item using INSERT OR IGNORE.
 * Only inserts if no row exists yet — safe to call on every startup.
 * Returns true if a new row was inserted (first run for this item).
 */
export function initSettings(itemId: string, viewSettings: StoredViewSettings): boolean {
  const db = getDb()
  const result = db.prepare(`
    INSERT OR IGNORE INTO folder_settings (item_id, view_settings_json)
    VALUES (?, ?)
  `).run(itemId, JSON.stringify(viewSettings))
  return result.changes > 0
}

/**
 * Fetches folder settings raw row.
 */
export function fetchSettings(itemId: string): any {
  const db = getDb()
  return db.prepare('SELECT * FROM folder_settings WHERE item_id = ?').get(itemId)
}

/**
 * MERGES partial updates into existing folder settings.
 * Uses Object.assign to preserve nested keys (e.g. childViewSettings).
 * If you need full replacement, write a separate replaceSettings function.
 */
export function mergeSettings(itemId: string, updates: {
  viewSettings?: Record<string, any>
  folderSettings?: Partial<FolderSettings>
}): void {
  const db = getDb()
  const existing = (db.prepare('SELECT * FROM folder_settings WHERE item_id = ?').get(itemId) as any) || {}

  // IMPORTANT: We MERGE partial updates into the existing JSON blob, not replace.
  // This preserves nested keys like childViewSettings.
  const viewSettings = parseJsonSafe(existing.view_settings_json, {})
  if (updates.viewSettings !== undefined && updates.viewSettings !== null) {
    Object.assign(viewSettings, updates.viewSettings)
  }

  // Folder behavior settings: merge individual columns
  const retrieveChildrenMetadata = updates.folderSettings?.retrieveChildrenMetadata
    ?? existing.retrieve_children_metadata ?? 0
  const childrenTypeHint = updates.folderSettings?.childrenTypeHint !== undefined
    ? updates.folderSettings.childrenTypeHint
    : (existing.children_type_hint ?? null)
  const processTvChildren = updates.folderSettings?.processTvChildren
    ?? existing.process_tv_children ?? 1

  db.prepare(
    `
    INSERT INTO folder_settings(item_id, view_settings_json, retrieve_children_metadata, children_type_hint, process_tv_children)
    VALUES(@id, @view, @retrieve, @hint, @processTv)
    ON CONFLICT(item_id) DO UPDATE SET
      view_settings_json = excluded.view_settings_json,
      retrieve_children_metadata = excluded.retrieve_children_metadata,
      children_type_hint = excluded.children_type_hint,
      process_tv_children = excluded.process_tv_children
    `
  ).run({
    '@id': itemId,
    '@view': JSON.stringify(viewSettings),
    '@retrieve': retrieveChildrenMetadata ? 1 : 0,
    '@hint': childrenTypeHint,
    '@processTv': processTvChildren === false ? 0 : 1,
  })
}
