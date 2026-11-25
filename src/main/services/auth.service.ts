import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import fs from 'fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { getUserDataPath } from './paths.service'
import * as accountRepo from '../database/repositories/account.repo'
import * as tokenRepo from '../database/repositories/auth-token.repo'
import type { AuthTokenDevice, AuthTokenKind } from '../database/repositories/auth-token.repo'
import type { Account, AccountRole, ApiKey, AuthResponse, Capability } from '@shared/types'
import { ROLE_CAPABILITIES } from '@shared/types'

// --- Sessions and API keys ---

export interface SessionData {
  accountId: string
  role: AccountRole
  capabilities: Set<Capability>
  tokenId: string
  kind: AuthTokenKind
}

// Unused sessions expire. API keys stay until they are revoked.
const SESSION_IDLE_LIMIT_MS = 180 * 24 * 60 * 60 * 1000
// Last use is informational. Record it at most this often per token.
const TOUCH_INTERVAL_MS = 10 * 60 * 1000
const CACHE_LIMIT = 2000

// Validation runs for every request, including each media segment.
const validated = new Map<string, { session: SessionData; touchedAt: number }>()

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function issueToken(accountId: string, kind: AuthTokenKind, name: string | null, device?: AuthTokenDevice) {
  const token = crypto.randomBytes(16).toString('hex')
  const id = crypto.randomUUID()
  tokenRepo.insertToken(id, hashToken(token), accountId, kind, name, device)
  return { id, token }
}

function createSession(account: Account, device?: AuthTokenDevice): string {
  tokenRepo.deleteSessionsUnusedSince(Date.now() - SESSION_IDLE_LIMIT_MS)
  if (device?.deviceId) tokenRepo.deleteDeviceSessions(account.id, device.deviceId)
  return issueToken(account.id, 'session', device?.client ?? null, device).token
}

export function validateToken(token: string): SessionData | null {
  if (!token) return null
  const hash = hashToken(token)
  const now = Date.now()
  const cached = validated.get(hash)
  if (cached) {
    if (now - cached.touchedAt > TOUCH_INTERVAL_MS) {
      cached.touchedAt = now
      tokenRepo.touchToken(cached.session.tokenId, now)
    }
    return cached.session
  }
  const stored = tokenRepo.findTokenByHash(hash)
  if (!stored) return null
  if (stored.kind === 'session' && now - stored.lastUsedAt > SESSION_IDLE_LIMIT_MS) {
    tokenRepo.deleteTokenByHash(hash)
    return null
  }
  const session: SessionData = {
    accountId: stored.accountId,
    role: stored.role,
    capabilities: new Set(ROLE_CAPABILITIES[stored.role]),
    tokenId: stored.id,
    kind: stored.kind
  }
  if (validated.size >= CACHE_LIMIT) validated.delete(validated.keys().next().value!)
  validated.set(hash, { session, touchedAt: now })
  if (now - stored.lastUsedAt > TOUCH_INTERVAL_MS) tokenRepo.touchToken(stored.id, now)
  return session
}

export function logout(token: string): void {
  const hash = hashToken(token)
  validated.delete(hash)
  tokenRepo.deleteTokenByHash(hash)
}

/** Ends every session and API key of the account. */
export function revokeAccountTokens(accountId: string): void {
  tokenRepo.deleteTokensForAccount(accountId)
  for (const [hash, { session }] of validated) {
    if (session.accountId === accountId) validated.delete(hash)
  }
}

/** An API key acts as its account, with that account's permissions. The token is shown only once. */
export function createApiKey(accountId: string, name: string): ApiKey & { token: string } {
  const trimmed = name.trim().slice(0, 100) || 'API key'
  const { id, token } = issueToken(accountId, 'api_key', trimmed)
  const now = Date.now()
  return { id, name: trimmed, createdAt: now, lastUsedAt: now, token }
}

export function listApiKeys(accountId: string): ApiKey[] {
  return tokenRepo.listTokens(accountId, 'api_key')
    .map(({ id, name, createdAt, lastUsedAt }) => ({ id, name: name ?? 'API key', createdAt, lastUsedAt }))
}

export function revokeApiKey(accountId: string, id: string): boolean {
  if (!tokenRepo.deleteAccountToken(accountId, id)) return false
  for (const [hash, { session }] of validated) {
    if (session.tokenId === id) validated.delete(hash)
  }
  return true
}

// --- Quick Connect: a device shows a code, a signed-in account approves it ---

interface QuickConnectRequest {
  secret: string
  code: string
  device: AuthTokenDevice
  createdAt: number
  accountId?: string
}

const QUICK_CONNECT_TTL_MS = 10 * 60 * 1000
const quickConnect = new Map<string, QuickConnectRequest>()

function pendingQuickConnect(): QuickConnectRequest[] {
  const now = Date.now()
  for (const [secret, entry] of quickConnect) if (now - entry.createdAt > QUICK_CONNECT_TTL_MS) quickConnect.delete(secret)
  return [...quickConnect.values()]
}

export function initiateQuickConnect(device: AuthTokenDevice): QuickConnectRequest {
  const codes = new Set(pendingQuickConnect().map((entry) => entry.code))
  let code: string
  do code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0'); while (codes.has(code))
  const entry = { secret: crypto.randomBytes(32).toString('hex'), code, device, createdAt: Date.now() }
  quickConnect.set(entry.secret, entry)
  return entry
}

export function getQuickConnect(secret: string): QuickConnectRequest | undefined {
  return pendingQuickConnect().find((entry) => entry.secret === secret)
}

/** Approves a waiting device for the account. Repeated wrong codes are rate limited like sign-ins. */
export function authorizeQuickConnect(accountId: string, code: string): boolean {
  const limit = `quick-connect:${accountId}`
  if (!checkLoginRateLimit(limit).allowed) return false
  const entry = pendingQuickConnect().find((candidate) => candidate.code === code.trim() && !candidate.accountId)
  if (!entry) {
    recordFailedLogin(limit)
    return false
  }
  entry.accountId = accountId
  return true
}

/** Signs the approved device in once, then forgets the request. */
export function completeQuickConnect(secret: string): { token: string; account: Account } | null {
  const entry = getQuickConnect(secret)
  const account = entry?.accountId ? accountRepo.getAccountById(entry.accountId) : null
  if (!entry || !account) return null
  quickConnect.delete(secret)
  return { token: createSession(account, entry.device), account: { id: account.id, username: account.username, role: account.role } }
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

// --- Sign-in rate limit, shared by every sign-in route ---

const loginAttempts = new Map<string, { count: number; lastAttempt: number }>()
const RATE_LIMIT_WINDOW = 15 * 60 * 1000
const MAX_ATTEMPTS = 10

export function checkLoginRateLimit(ip: string): { allowed: boolean; waitTime?: number } {
  const now = Date.now()
  const attempt = loginAttempts.get(ip)
  if (attempt) {
    if (now - attempt.lastAttempt > RATE_LIMIT_WINDOW) {
      loginAttempts.delete(ip)
      return { allowed: true }
    }
    if (attempt.count >= MAX_ATTEMPTS) {
      return { allowed: false, waitTime: Math.ceil((RATE_LIMIT_WINDOW - (now - attempt.lastAttempt)) / 60000) }
    }
  }
  return { allowed: true }
}

export function recordFailedLogin(ip: string): void {
  const attempt = loginAttempts.get(ip) || { count: 0, lastAttempt: Date.now() }
  attempt.count++
  attempt.lastAttempt = Date.now()
  loginAttempts.set(ip, attempt)
}

export function resetLoginRateLimit(ip: string): void {
  loginAttempts.delete(ip)
}

// --- Password Helpers ---

export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, 10)
}

// --- Auth Actions ---

export async function login(
  username: string,
  password: string,
  device?: AuthTokenDevice
): Promise<{ token: string; account: Account } | null> {
  const account = accountRepo.getAccountByUsername(username)
  if (!account) return null
  const valid = await bcrypt.compare(password, account.passwordHash)
  if (!valid) return null
  const token = createSession(account, device)
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
    logout(token)
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
  revokeAccountTokens(accountId)
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
  revokeAccountTokens(accountId)
}

export function deleteAccount(accountId: string): void {
  revokeAccountTokens(accountId)
  accountRepo.deleteAccount(accountId)
}
