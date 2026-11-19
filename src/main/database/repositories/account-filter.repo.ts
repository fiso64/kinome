/**
 * ACCOUNT FILTER REPOSITORY
 * Owns the 'account_filter_rules' and 'account_visible_items' tables.
 */
import { getDb, runTransaction } from '../client'
import type { AccountFilterRule, LibraryFilter } from '@shared/types'

interface FilterRuleRow {
  account_id: string
  mode: 'allow' | 'deny'
  filter_json: string
}

export function getFilterRule(accountId: string): AccountFilterRule | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM account_filter_rules WHERE account_id = ?')
    .get(accountId) as FilterRuleRow | undefined
  if (!row) return null
  return { accountId: row.account_id, mode: row.mode, filter: JSON.parse(row.filter_json) }
}

export function setFilterRule(accountId: string, mode: 'allow' | 'deny', filter: LibraryFilter): void {
  const db = getDb()
  db.prepare(
    'INSERT OR REPLACE INTO account_filter_rules (account_id, mode, filter_json) VALUES (?, ?, ?)'
  ).run(accountId, mode, JSON.stringify(filter))
}

export function deleteFilterRule(accountId: string): void {
  const db = getDb()
  runTransaction(() => {
    db.prepare('DELETE FROM account_filter_rules WHERE account_id = ?').run(accountId)
    replaceVisibleItems(accountId, [])
  })
}

export function hasFilterRule(accountId: string): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT 1 FROM account_filter_rules WHERE account_id = ?')
    .get(accountId)
  return row != null
}

export function getAllFilteredAccountIds(): string[] {
  const db = getDb()
  const rows = db.prepare('SELECT account_id FROM account_filter_rules').all() as { account_id: string }[]
  return rows.map((r) => r.account_id)
}

export function replaceVisibleItems(accountId: string, itemIds: string[], excludedLocations: string[] = []): void {
  const db = getDb()
  runTransaction(() => {
    db.prepare('DELETE FROM account_visible_items WHERE account_id = ?').run(accountId)
    db.prepare('DELETE FROM account_excluded_locations WHERE account_id = ?').run(accountId)
    const insertItem = db.prepare('INSERT INTO account_visible_items (account_id, item_id) VALUES (?, ?)')
    const excludeLocation = db.prepare('INSERT INTO account_excluded_locations (account_id, location_id) VALUES (?, ?)')
    for (const id of itemIds) insertItem.run(accountId, id)
    for (const id of excludedLocations) excludeLocation.run(accountId, id)
  })
}
