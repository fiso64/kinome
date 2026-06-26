/**
 * Account Filter Repository Tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SCHEMA_SQL } from '../schema'
import { _setDbForTesting, _clearDbForTesting } from '../client'
import { createAccount } from './account.repo'
import {
  getFilterRule,
  setFilterRule,
  deleteFilterRule,
  hasFilterRule,
  getAllFilteredAccountIds,
  replaceVisibleItems
} from './account-filter.repo'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  _setDbForTesting(db)
  createAccount('acc-1', 'alice', 'hash', 'normal')
  createAccount('acc-2', 'bob', 'hash', 'normal')
})

afterEach(() => {
  db.close()
  _clearDbForTesting()
})

const ALLOW_FILTER = { conditionGroups: [[{ field: 'tags.allow', op: 'eq' as const, value: 'true' }]] }

function insertMediaItem(id: string): void {
  db.prepare(`
    INSERT INTO media_items (id, physical_kind, name, created_at, updated_at)
    VALUES (?, 'file', ?, 1000, 1000)
  `).run(id, id)
}

describe('getFilterRule', () => {
  it('returns null when no rule exists', () => {
    expect(getFilterRule('acc-1')).toBeNull()
  })

  it('returns the stored rule', () => {
    setFilterRule('acc-1', 'allow', ALLOW_FILTER)
    const rule = getFilterRule('acc-1')
    expect(rule).not.toBeNull()
    expect(rule!.accountId).toBe('acc-1')
    expect(rule!.mode).toBe('allow')
    expect(rule!.filter).toEqual(ALLOW_FILTER)
  })
})

describe('setFilterRule', () => {
  it('upserts: overwrites an existing rule', () => {
    setFilterRule('acc-1', 'allow', ALLOW_FILTER)
    const denyFilter = { conditionGroups: [[{ field: 'tags.deny', op: 'eq' as const, value: 'true' }]] }
    setFilterRule('acc-1', 'deny', denyFilter)
    const rule = getFilterRule('acc-1')
    expect(rule!.mode).toBe('deny')
    expect(rule!.filter).toEqual(denyFilter)
  })
})

describe('deleteFilterRule', () => {
  it('removes the rule so getFilterRule returns null', () => {
    setFilterRule('acc-1', 'allow', ALLOW_FILTER)
    deleteFilterRule('acc-1')
    expect(getFilterRule('acc-1')).toBeNull()
  })

  it('is a no-op for an account with no rule', () => {
    expect(() => deleteFilterRule('acc-1')).not.toThrow()
  })
})

describe('hasFilterRule', () => {
  it('returns false when no rule exists', () => {
    expect(hasFilterRule('acc-1')).toBe(false)
  })

  it('returns true after setting a rule', () => {
    setFilterRule('acc-1', 'allow', ALLOW_FILTER)
    expect(hasFilterRule('acc-1')).toBe(true)
  })
})

describe('getAllFilteredAccountIds', () => {
  it('returns empty array when no rules exist', () => {
    expect(getAllFilteredAccountIds()).toEqual([])
  })

  it('returns all account IDs with rules', () => {
    setFilterRule('acc-1', 'allow', ALLOW_FILTER)
    setFilterRule('acc-2', 'deny', ALLOW_FILTER)
    expect(getAllFilteredAccountIds().sort()).toEqual(['acc-1', 'acc-2'])
  })
})

describe('replaceVisibleItems', () => {
  it('inserts visible items for an account', () => {
    insertMediaItem('item-1')
    replaceVisibleItems('acc-1', ['item-1'])
    const rows = db.prepare('SELECT item_id FROM account_visible_items WHERE account_id = ?').all('acc-1') as any[]
    expect(rows.map((r) => r.item_id)).toEqual(['item-1'])
  })

  it('replaces old rows with new rows', () => {
    insertMediaItem('item-1')
    insertMediaItem('item-2')
    replaceVisibleItems('acc-1', ['item-1'])
    replaceVisibleItems('acc-1', ['item-2'])
    const rows = db.prepare('SELECT item_id FROM account_visible_items WHERE account_id = ?').all('acc-1') as any[]
    expect(rows.map((r) => r.item_id)).toEqual(['item-2'])
  })

  it('with empty array clears all visible items for the account', () => {
    insertMediaItem('item-1')
    replaceVisibleItems('acc-1', ['item-1'])
    replaceVisibleItems('acc-1', [])
    const rows = db.prepare('SELECT * FROM account_visible_items WHERE account_id = ?').all('acc-1')
    expect(rows).toHaveLength(0)
  })

  it('does not affect visible items for other accounts', () => {
    insertMediaItem('item-1')
    replaceVisibleItems('acc-1', ['item-1'])
    replaceVisibleItems('acc-2', [])
    const rows = db.prepare('SELECT * FROM account_visible_items WHERE account_id = ?').all('acc-1') as any[]
    expect(rows).toHaveLength(1)
  })
})

describe('cascade deletes', () => {
  it('deleting an account removes its filter rule', () => {
    setFilterRule('acc-1', 'allow', ALLOW_FILTER)
    db.prepare('DELETE FROM accounts WHERE id = ?').run('acc-1')
    expect(getFilterRule('acc-1')).toBeNull()
  })

  it('deleting an account removes its visible items', () => {
    insertMediaItem('item-1')
    replaceVisibleItems('acc-1', ['item-1'])
    db.prepare('DELETE FROM accounts WHERE id = ?').run('acc-1')
    const rows = db.prepare('SELECT * FROM account_visible_items WHERE account_id = ?').all('acc-1')
    expect(rows).toHaveLength(0)
  })

  it('deleting an item removes it from all visible item sets', () => {
    insertMediaItem('item-1')
    replaceVisibleItems('acc-1', ['item-1'])
    db.prepare('DELETE FROM media_items WHERE id = ?').run('item-1')
    const rows = db.prepare('SELECT * FROM account_visible_items').all()
    expect(rows).toHaveLength(0)
  })
})
