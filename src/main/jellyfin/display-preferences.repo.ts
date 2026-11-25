/**
 * Settings that Jellyfin clients store on the server, such as a library's sort
 * order. Kinome keeps each one as the client sent it and never reads inside.
 */
import { getDb } from '../database/client'

export { DISPLAY_PREFERENCES_SQL } from './display-preferences.sql'

export function read(accountId: string, client: string, id: string): Record<string, unknown> | undefined {
  const row = getDb().prepare(
    'SELECT value FROM jellyfin_display_preferences WHERE account_id = ? AND client = ? AND preferences_id = ?'
  ).get(accountId, client, id) as { value: string } | undefined
  return row ? JSON.parse(row.value) : undefined
}

export function write(accountId: string, client: string, id: string, value: Record<string, unknown>): void {
  getDb().prepare(`
    INSERT INTO jellyfin_display_preferences (account_id, client, preferences_id, value, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, client, preferences_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(accountId, client.slice(0, 100), id.slice(0, 100), JSON.stringify(value).slice(0, 65_536), Date.now())
}
