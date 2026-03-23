/**
 * Account Repository Tests
 *
 * Integration tests for account CRUD operations against
 * a real in-memory SQLite database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SCHEMA_SQL } from '../schema'
import { _setDbForTesting, _clearDbForTesting } from '../client'
import {
  createAccount,
  getAccountById,
  getAccountByUsername,
  getAllAccounts,
  updateAccountPassword,
  updateAccountRole,
  deleteAccount,
  getAccountCount
} from './account.repo'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  _setDbForTesting(db)
})

afterEach(() => {
  db.close()
  _clearDbForTesting()
})

describe('getAccountCount', () => {
  it('returns 0 when no accounts exist', () => {
    expect(getAccountCount()).toBe(0)
  })

  it('increments after each createAccount', () => {
    createAccount('id-1', 'alice', 'hash1', 'admin')
    expect(getAccountCount()).toBe(1)
    createAccount('id-2', 'bob', 'hash2', 'normal')
    expect(getAccountCount()).toBe(2)
  })
})

describe('createAccount / getAccountById', () => {
  it('returns the created account by id', () => {
    createAccount('id-1', 'alice', 'secret-hash', 'admin')
    const account = getAccountById('id-1')
    expect(account).not.toBeNull()
    expect(account!.id).toBe('id-1')
    expect(account!.username).toBe('alice')
    expect(account!.role).toBe('admin')
    expect(account!.passwordHash).toBe('secret-hash')
  })

  it('returns null for a non-existent id', () => {
    expect(getAccountById('does-not-exist')).toBeNull()
  })
})

describe('getAccountByUsername', () => {
  it('finds an account by username', () => {
    createAccount('id-1', 'alice', 'hash', 'normal')
    const account = getAccountByUsername('alice')
    expect(account).not.toBeNull()
    expect(account!.id).toBe('id-1')
    expect(account!.passwordHash).toBe('hash')
  })

  it('is case-sensitive', () => {
    createAccount('id-1', 'alice', 'hash', 'normal')
    expect(getAccountByUsername('Alice')).toBeNull()
    expect(getAccountByUsername('ALICE')).toBeNull()
  })

  it('returns null for unknown username', () => {
    expect(getAccountByUsername('nobody')).toBeNull()
  })
})

describe('getAllAccounts', () => {
  it('returns empty array when no accounts exist', () => {
    expect(getAllAccounts()).toEqual([])
  })

  it('returns accounts sorted by creation order', () => {
    createAccount('id-1', 'alice', 'hash', 'admin')
    createAccount('id-2', 'bob', 'hash', 'normal')
    const accounts = getAllAccounts()
    expect(accounts.map((a) => a.username)).toEqual(['alice', 'bob'])
  })

  it('does NOT expose passwordHash', () => {
    createAccount('id-1', 'alice', 'super-secret', 'admin')
    const accounts = getAllAccounts()
    expect((accounts[0] as any).passwordHash).toBeUndefined()
    expect((accounts[0] as any).password_hash).toBeUndefined()
  })

  it('returns correct role for each account', () => {
    createAccount('id-1', 'admin-user', 'hash', 'admin')
    createAccount('id-2', 'normal-user', 'hash', 'normal')
    const accounts = getAllAccounts()
    expect(accounts.find((a) => a.id === 'id-1')!.role).toBe('admin')
    expect(accounts.find((a) => a.id === 'id-2')!.role).toBe('normal')
  })
})

describe('uniqueness and constraint enforcement', () => {
  it('throws on duplicate username', () => {
    createAccount('id-1', 'alice', 'hash1', 'admin')
    expect(() => createAccount('id-2', 'alice', 'hash2', 'normal')).toThrow()
  })

  it('throws on duplicate id', () => {
    createAccount('id-1', 'alice', 'hash1', 'admin')
    expect(() => createAccount('id-1', 'bob', 'hash2', 'normal')).toThrow()
  })

  it('throws on invalid role', () => {
    expect(() => createAccount('id-1', 'alice', 'hash', 'superadmin' as any)).toThrow()
  })
})

describe('updateAccountPassword', () => {
  it('replaces the password hash', () => {
    createAccount('id-1', 'alice', 'old-hash', 'admin')
    updateAccountPassword('id-1', 'new-hash')
    const account = getAccountById('id-1')
    expect(account!.passwordHash).toBe('new-hash')
  })

  it('does not affect other accounts', () => {
    createAccount('id-1', 'alice', 'alice-hash', 'admin')
    createAccount('id-2', 'bob', 'bob-hash', 'normal')
    updateAccountPassword('id-1', 'changed')
    const bob = getAccountById('id-2')
    expect(bob!.passwordHash).toBe('bob-hash')
  })
})

describe('updateAccountRole', () => {
  it('changes the role', () => {
    createAccount('id-1', 'alice', 'hash', 'normal')
    updateAccountRole('id-1', 'admin')
    const account = getAccountById('id-1')
    expect(account!.role).toBe('admin')
  })

  it('throws on invalid role', () => {
    createAccount('id-1', 'alice', 'hash', 'normal')
    expect(() => updateAccountRole('id-1', 'god' as any)).toThrow()
  })
})

describe('deleteAccount', () => {
  it('removes the account', () => {
    createAccount('id-1', 'alice', 'hash', 'admin')
    deleteAccount('id-1')
    expect(getAccountById('id-1')).toBeNull()
    expect(getAccountCount()).toBe(0)
  })

  it('is a no-op for non-existent id', () => {
    expect(() => deleteAccount('does-not-exist')).not.toThrow()
  })

  it('does not affect other accounts', () => {
    createAccount('id-1', 'alice', 'hash', 'admin')
    createAccount('id-2', 'bob', 'hash', 'normal')
    deleteAccount('id-1')
    expect(getAccountById('id-2')).not.toBeNull()
  })
})
