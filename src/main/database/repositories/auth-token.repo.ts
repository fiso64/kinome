/**
 * AUTH TOKEN REPOSITORY
 * Owns the 'auth_tokens' table: persisted sign-in sessions and API keys.
 */
import { getDb } from '../client'
import type { AccountRole } from '@shared/types'

export type AuthTokenKind = 'session' | 'api_key'

export interface AuthTokenDevice {
  client?: string
  deviceId?: string
  deviceName?: string
  version?: string
}

export interface StoredAuthToken {
  id: string
  accountId: string
  role: AccountRole
  kind: AuthTokenKind
  name: string | null
  deviceId: string | null
  deviceName: string | null
  clientVersion: string | null
  createdAt: number
  lastUsedAt: number
}

interface AuthTokenRow {
  id: string
  account_id: string
  role: AccountRole
  kind: AuthTokenKind
  name: string | null
  device_id: string | null
  device_name: string | null
  client_version: string | null
  created_at: number
  last_used_at: number
}

function mapRow(row: AuthTokenRow): StoredAuthToken {
  return {
    id: row.id, accountId: row.account_id, role: row.role, kind: row.kind, name: row.name,
    deviceId: row.device_id, deviceName: row.device_name, clientVersion: row.client_version,
    createdAt: row.created_at, lastUsedAt: row.last_used_at
  }
}

export function insertToken(
  id: string, tokenHash: string, accountId: string, kind: AuthTokenKind, name: string | null, device: AuthTokenDevice = {}
): void {
  const now = Date.now()
  getDb().prepare(`
    INSERT INTO auth_tokens (id, token_hash, account_id, kind, name, device_id, device_name, client_version, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tokenHash, accountId, kind, name, device.deviceId ?? null, device.deviceName ?? null, device.version ?? null, now, now)
}

/** The token's account role is read with it, so a role change applies to every token at once. */
export function findTokenByHash(tokenHash: string): StoredAuthToken | null {
  const row = getDb().prepare(`
    SELECT t.id, t.account_id, a.role, t.kind, t.name, t.device_id, t.device_name, t.client_version, t.created_at, t.last_used_at
    FROM auth_tokens t JOIN accounts a ON a.id = t.account_id
    WHERE t.token_hash = ?
  `).get(tokenHash) as AuthTokenRow | undefined
  return row ? mapRow(row) : null
}

export function touchToken(id: string, at: number): void {
  getDb().prepare('UPDATE auth_tokens SET last_used_at = ? WHERE id = ?').run(at, id)
}

export function listTokens(accountId: string, kind: AuthTokenKind): StoredAuthToken[] {
  return (getDb().prepare(`
    SELECT t.id, t.account_id, a.role, t.kind, t.name, t.device_id, t.device_name, t.client_version, t.created_at, t.last_used_at
    FROM auth_tokens t JOIN accounts a ON a.id = t.account_id
    WHERE t.account_id = ? AND t.kind = ?
    ORDER BY t.created_at ASC
  `).all(accountId, kind) as AuthTokenRow[]).map(mapRow)
}

export function deleteTokenByHash(tokenHash: string): void {
  getDb().prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(tokenHash)
}

/** Returns whether a token of the account was deleted. */
export function deleteAccountToken(accountId: string, id: string): boolean {
  return getDb().prepare('DELETE FROM auth_tokens WHERE account_id = ? AND id = ?').run(accountId, id).changes > 0
}

export function deleteTokensForAccount(accountId: string): void {
  getDb().prepare('DELETE FROM auth_tokens WHERE account_id = ?').run(accountId)
}

/** A device that signs in again replaces its earlier session. */
export function deleteDeviceSessions(accountId: string, deviceId: string): void {
  getDb().prepare(`DELETE FROM auth_tokens WHERE account_id = ? AND kind = 'session' AND device_id = ?`).run(accountId, deviceId)
}

export function deleteSessionsUnusedSince(cutoff: number): number {
  return getDb().prepare(`DELETE FROM auth_tokens WHERE kind = 'session' AND last_used_at < ?`).run(cutoff).changes
}
