/**
 * PERSONAL TAG REPOSITORY
 * Owns the 'account_item_tags' table: tags each account keeps on items for itself.
 */
import { getDb, runTransaction } from '../client'

export function getPersonalTags(accountId: string, itemId: string): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM account_item_tags WHERE account_id = ? AND item_id = ? ORDER BY key')
    .all(accountId, itemId) as { key: string; value: string }[]
  return Object.fromEntries(rows.map(({ key, value }) => [key, value]))
}

export function replacePersonalTags(accountId: string, itemId: string, tags: Record<string, string>): void {
  runTransaction(() => {
    const db = getDb()
    db.prepare('DELETE FROM account_item_tags WHERE account_id = ? AND item_id = ?').run(accountId, itemId)
    const insert = db.prepare('INSERT INTO account_item_tags (account_id, item_id, key, value) VALUES (?, ?, ?, ?)')
    for (const [key, value] of Object.entries(tags)) insert.run(accountId, itemId, key, value)
  })
}

export function setPersonalTag(accountId: string, itemId: string, key: string, value: string | null): void {
  const db = getDb()
  if (value === null) db.prepare('DELETE FROM account_item_tags WHERE account_id = ? AND item_id = ? AND key = ?').run(accountId, itemId, key)
  else db.prepare(`INSERT INTO account_item_tags (account_id, item_id, key, value) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, item_id, key) DO UPDATE SET value = excluded.value`).run(accountId, itemId, key, value)
}

/** The given items that carry the tag for the account, in one statement. */
export function itemsWithPersonalTag(accountId: string, itemIds: readonly string[], key: string, value: string): Set<string> {
  if (!itemIds.length) return new Set()
  const rows = getDb().prepare(`SELECT item_id FROM account_item_tags WHERE account_id = ? AND key = ? AND value = ?
    AND item_id IN (${itemIds.map(() => '?').join(', ')})`).all(accountId, key, value, ...itemIds) as { item_id: string }[]
  return new Set(rows.map((row) => row.item_id))
}

/** Every item that carries a tag key for the account, shared or personal, with its value. A personal value wins. */
export function itemsWithTagKey(accountId: string, key: string): Map<string, string> {
  const rows = getDb().prepare(`SELECT item_id, value, 0 AS personal FROM item_tags WHERE key = ?
    UNION ALL SELECT item_id, value, 1 AS personal FROM account_item_tags WHERE account_id = ? AND key = ?
    ORDER BY personal`).all(key, accountId, key) as { item_id: string; value: string }[]
  return new Map(rows.map((row) => [row.item_id, row.value]))
}
