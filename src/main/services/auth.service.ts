import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import fs from 'fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { getUserDataPath } from './paths.service'
import * as accountRepo from '../database/repositories/account.repo'
import type { Account, AccountRole, AuthResponse, Capability } from '@shared/types'
import { ROLE_CAPABILITIES } from '@shared/types'

// --- Sessions ---

interface SessionData {
  accountId: string
  role: AccountRole
  capabilities: Set<Capability>
}

const sessions = new Map<string, SessionData>()

function createSession(account: Account): string {
  const token = crypto.randomUUID()
  sessions.set(token, {
    accountId: account.id,
    role: account.role,
    capabilities: new Set(ROLE_CAPABILITIES[account.role]),
  })
  return token
}

export function validateToken(token: string): SessionData | null {
  return sessions.get(token) ?? null
}

export function logout(token: string): void {
  sessions.delete(token)
}

export function invalidateSessionsForAccount(accountId: string): void {
  for (const [token, session] of sessions) {
    if (session.accountId === accountId) sessions.delete(token)
  }
}

// --- Setup Token ---

function getSetupTokenPath(): string {
  return path.join(getUserDataPath(), 'setup-token.txt')
}

export function ensureSetupToken(): string | null {
  // If any accounts exist, no setup needed
  if (accountRepo.getAccountCount() > 0) return null

  const tokenPath = getSetupTokenPath()
  const token = existsSync(tokenPath)
    ? readFileSync(tokenPath, 'utf-8').trim()
    : Math.floor(10000000 + Math.random() * 90000000).toString()

  if (!existsSync(tokenPath)) {
    writeFileSync(tokenPath, token, 'utf-8')
  }

  console.log('*****************************************************')
  console.log('*                                                   *')
  console.log('*       KINOME INITIAL SETUP TOKEN REQUIRED         *')
  console.log(`*               TOKEN: ${token}                     *`)
  console.log('*                                                   *')
  console.log(`*  Find this token in:                              *`)
  console.log(`*  ${tokenPath}   *`)
  console.log('*                                                   *')
  console.log('*****************************************************')

  return token
}

// --- Password Helpers ---

export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, 10)
}

// --- Auth Actions ---

export async function login(
  username: string,
  password: string
): Promise<{ token: string; account: Account } | null> {
  const account = accountRepo.getAccountByUsername(username)
  if (!account) return null
  const valid = await bcrypt.compare(password, account.passwordHash)
  if (!valid) return null
  const token = createSession(account)
  return { token, account: { id: account.id, username: account.username, role: account.role } }
}

export async function setupFirstAdmin(
  setupToken: string,
  username: string,
  password: string
): Promise<{ token: string; account: Account }> {
  if (accountRepo.getAccountCount() > 0) {
    throw new Error('Server already set up.')
  }

  const tokenPath = getSetupTokenPath()
  if (!existsSync(tokenPath)) {
    throw new Error('Setup token file missing. Restart the server to regenerate.')
  }
  const validToken = readFileSync(tokenPath, 'utf-8').trim()
  if (setupToken !== validToken) {
    throw new Error('Invalid setup token.')
  }

  const hash = await hashPassword(password)
  const id = crypto.randomUUID()
  accountRepo.createAccount(id, username, hash, 'admin')

  await fs.unlink(tokenPath).catch(() => {})

  const account: Account = { id, username, role: 'admin' }
  const token = createSession(account)
  return { token, account }
}

export async function getAuthState(token?: string): Promise<AuthResponse> {
  const needsSetup = accountRepo.getAccountCount() === 0

  if (!token) {
    return { authenticated: false, needsSetup }
  }

  const session = validateToken(token)
  if (!session) {
    return { authenticated: false, needsSetup }
  }

  const account = accountRepo.getAccountById(session.accountId)
  if (!account) {
    sessions.delete(token)
    return { authenticated: false, needsSetup }
  }

  return {
    authenticated: true,
    needsSetup: false,
    account: {
      id: account.id,
      username: account.username,
      role: account.role,
      capabilities: [...session.capabilities],
    },
  }
}

export async function updatePassword(accountId: string, newPassword: string): Promise<void> {
  const hash = await hashPassword(newPassword)
  accountRepo.updateAccountPassword(accountId, hash)
  invalidateSessionsForAccount(accountId)
}

export function getAllAccounts(): Account[] {
  return accountRepo.getAllAccounts()
}

export async function createAccount(
  username: string,
  password: string,
  role: AccountRole
): Promise<Account> {
  const existing = accountRepo.getAccountByUsername(username)
  if (existing) throw new Error(`Username "${username}" is already taken.`)
  const hash = await hashPassword(password)
  const id = crypto.randomUUID()
  accountRepo.createAccount(id, username, hash, role)
  return { id, username, role }
}

export function updateAccountRole(accountId: string, role: AccountRole): void {
  accountRepo.updateAccountRole(accountId, role)
  // Update any active sessions for this account to reflect the new role
  for (const [, session] of sessions) {
    if (session.accountId === accountId) {
      session.role = role
      session.capabilities = new Set(ROLE_CAPABILITIES[role])
    }
  }
}

export function deleteAccount(accountId: string): void {
  accountRepo.deleteAccount(accountId)
  invalidateSessionsForAccount(accountId)
}
