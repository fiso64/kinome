/**
 * ACCOUNT REPOSITORY
 * Owns the 'accounts' table. Handles account CRUD.
 */
import { getDb } from '../client'
import type { Account, AccountRole } from '@shared/types'

interface AccountRow {
  id: string
  username: string
  password_hash: string
  role: AccountRole
  created_at: number
}

export function getAccountById(id: string): (Account & { passwordHash: string }) | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined
  if (!row) return null
  return { id: row.id, username: row.username, role: row.role, passwordHash: row.password_hash }
}

export function getAccountByUsername(username: string): (Account & { passwordHash: string }) | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) as AccountRow | undefined
  if (!row) return null
  return { id: row.id, username: row.username, role: row.role, passwordHash: row.password_hash }
}

export function getAllAccounts(): Account[] {
  const db = getDb()
  const rows = db.prepare('SELECT id, username, role FROM accounts ORDER BY created_at ASC').all() as Pick<AccountRow, 'id' | 'username' | 'role'>[]
  return rows.map((r) => ({ id: r.id, username: r.username, role: r.role }))
}

export function createAccount(id: string, username: string, passwordHash: string, role: AccountRole): void {
  const db = getDb()
  db.prepare(
    'INSERT INTO accounts (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, username, passwordHash, role, Date.now())
}

export function updateAccountPassword(id: string, passwordHash: string): void {
  const db = getDb()
  db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(passwordHash, id)
}

export function updateAccountRole(id: string, role: AccountRole): void {
  const db = getDb()
  db.prepare('UPDATE accounts SET role = ? WHERE id = ?').run(role, id)
}

export function deleteAccount(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
}

export function getAccountCount(): number {
  const db = getDb()
  const row = db.prepare('SELECT COUNT(*) as count FROM accounts').get() as { count: number }
  return row.count
}
