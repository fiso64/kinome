/**
 * Auth Service Tests
 *
 * Tests for login, session management (validateToken / logout),
 * capability mapping, and password updates.
 *
 * Note: setupFirstAdmin and ensureSetupToken involve filesystem I/O
 * (setup-token.txt) and are tested only for the paths that don't
 * touch disk (e.g. the "already set up" guard).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'bun:test'
import bcrypt from 'bcryptjs'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import * as authService from './auth.service'
import * as accountRepo from '../database/repositories/account.repo'

// Pre-compute a test hash at cost=1 so tests run fast.
// The auth service uses cost=10 in production, but any valid bcrypt hash works for verification.
let TEST_HASH: string
beforeAll(async () => {
  TEST_HASH = await bcrypt.hash('password123', 1)
})

describe('auth.service', () => {
  let ctx: ServiceTestContext

  beforeEach(() => {
    ctx = createServiceTestContext()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function seedAccount(id: string, username: string, role: 'admin' | 'normal' = 'admin') {
    accountRepo.createAccount(id, username, TEST_HASH, role)
  }

  // ─── login ──────────────────────────────────────────────────────────────────

  describe('login', () => {
    it('returns null when the account does not exist', async () => {
      const result = await authService.login('ghost', 'password123')
      expect(result).toBeNull()
    })

    it('returns null when the password is wrong', async () => {
      seedAccount('acc-1', 'alice')
      const result = await authService.login('alice', 'wrong-password')
      expect(result).toBeNull()
    })

    it('returns a token and account on correct credentials', async () => {
      seedAccount('acc-1', 'alice', 'admin')
      const result = await authService.login('alice', 'password123')
      expect(result).not.toBeNull()
      expect(typeof result!.token).toBe('string')
      expect(result!.token.length).toBeGreaterThan(10)
      expect(result!.account.id).toBe('acc-1')
      expect(result!.account.username).toBe('alice')
      expect(result!.account.role).toBe('admin')
      authService.logout(result!.token)
    })

    it('does not expose passwordHash in the returned account', async () => {
      seedAccount('acc-1', 'alice')
      const result = await authService.login('alice', 'password123')
      expect((result!.account as any).passwordHash).toBeUndefined()
      authService.logout(result!.token)
    })

    it('returns different tokens on each call', async () => {
      seedAccount('acc-1', 'alice')
      const r1 = (await authService.login('alice', 'password123'))!
      const r2 = (await authService.login('alice', 'password123'))!
      expect(r1.token).not.toBe(r2.token)
      authService.logout(r1.token)
      authService.logout(r2.token)
    })
  })

  // ─── validateToken / logout ──────────────────────────────────────────────────

  describe('validateToken', () => {
    it('returns session data for a valid token', async () => {
      seedAccount('acc-1', 'alice', 'admin')
      const { token } = (await authService.login('alice', 'password123'))!
      const session = authService.validateToken(token)
      expect(session).not.toBeNull()
      expect(session!.accountId).toBe('acc-1')
      expect(session!.role).toBe('admin')
      authService.logout(token)
    })

    it('returns null for an unknown token', () => {
      expect(authService.validateToken('totally-fake-token')).toBeNull()
    })

    it('returns null after the token is logged out', async () => {
      seedAccount('acc-1', 'alice')
      const { token } = (await authService.login('alice', 'password123'))!
      authService.logout(token)
      expect(authService.validateToken(token)).toBeNull()
    })
  })

  // ─── invalidateSessionsForAccount ───────────────────────────────────────────

  describe('invalidateSessionsForAccount', () => {
    it('invalidates all sessions for the account', async () => {
      seedAccount('acc-1', 'alice')
      const r1 = (await authService.login('alice', 'password123'))!
      const r2 = (await authService.login('alice', 'password123'))!

      authService.invalidateSessionsForAccount('acc-1')

      expect(authService.validateToken(r1.token)).toBeNull()
      expect(authService.validateToken(r2.token)).toBeNull()
    })

    it('does not invalidate sessions belonging to other accounts', async () => {
      seedAccount('acc-1', 'alice')
      seedAccount('acc-2', 'bob')
      const { token: aliceToken } = (await authService.login('alice', 'password123'))!
      const { token: bobToken } = (await authService.login('bob', 'password123'))!

      authService.invalidateSessionsForAccount('acc-1')

      expect(authService.validateToken(aliceToken)).toBeNull()
      expect(authService.validateToken(bobToken)).not.toBeNull()
      authService.logout(bobToken)
    })
  })

  // ─── getAuthState ────────────────────────────────────────────────────────────

  describe('getAuthState', () => {
    it('returns authenticated: false when no token is provided', async () => {
      seedAccount('acc-1', 'alice') // ensure needsSetup = false
      const state = await authService.getAuthState()
      expect(state.authenticated).toBe(false)
      expect(state.account).toBeUndefined()
    })

    it('returns authenticated: false for an invalid token', async () => {
      const state = await authService.getAuthState('garbage-token')
      expect(state.authenticated).toBe(false)
    })

    it('returns authenticated: true with account and capabilities for a valid token', async () => {
      seedAccount('acc-1', 'alice', 'admin')
      const { token } = (await authService.login('alice', 'password123'))!
      const state = await authService.getAuthState(token)

      expect(state.authenticated).toBe(true)
      expect(state.account!.id).toBe('acc-1')
      expect(state.account!.username).toBe('alice')
      expect(state.account!.capabilities).toContain('editMetadata')
      expect(state.account!.capabilities).toContain('manageAccounts')
      authService.logout(token)
    })

    it('sets needsSetup: true when the accounts table is empty', async () => {
      const state = await authService.getAuthState()
      expect(state.needsSetup).toBe(true)
    })

    it('sets needsSetup: false when at least one account exists', async () => {
      seedAccount('acc-1', 'alice')
      const { token } = (await authService.login('alice', 'password123'))!
      const state = await authService.getAuthState(token)
      expect(state.needsSetup).toBe(false)
      authService.logout(token)
    })

    it('cleans up a stale session and returns unauthenticated if account was deleted', async () => {
      seedAccount('acc-1', 'alice')
      const { token } = (await authService.login('alice', 'password123'))!
      // Delete the account out from under the session
      accountRepo.deleteAccount('acc-1')
      const state = await authService.getAuthState(token)
      expect(state.authenticated).toBe(false)
      // Session should also be gone now
      expect(authService.validateToken(token)).toBeNull()
    })
  })

  // ─── Role → Capability mapping ──────────────────────────────────────────────

  describe('role capabilities', () => {
    it('admin session carries all four capabilities', async () => {
      seedAccount('acc-1', 'alice', 'admin')
      const { token } = (await authService.login('alice', 'password123'))!
      const session = authService.validateToken(token)!
      const caps = [...session.capabilities]
      expect(caps).toContain('editMetadata')
      expect(caps).toContain('editSettings')
      expect(caps).toContain('manageAccounts')
      expect(caps).toContain('triggerLibraryScan')
      expect(caps).toHaveLength(4)
      authService.logout(token)
    })

    it('normal session carries no capabilities', async () => {
      seedAccount('acc-2', 'bob', 'normal')
      const { token } = (await authService.login('bob', 'password123'))!
      const session = authService.validateToken(token)!
      expect([...session.capabilities]).toHaveLength(0)
      authService.logout(token)
    })
  })

  // ─── updatePassword ──────────────────────────────────────────────────────────

  describe('updatePassword', () => {
    it('invalidates all existing sessions for the account', async () => {
      seedAccount('acc-1', 'alice')
      const { token } = (await authService.login('alice', 'password123'))!
      await authService.updatePassword('acc-1', 'new-password')
      expect(authService.validateToken(token)).toBeNull()
    })

    it('allows login with the new password', async () => {
      seedAccount('acc-1', 'alice')
      await authService.updatePassword('acc-1', 'new-password')
      const result = await authService.login('alice', 'new-password')
      expect(result).not.toBeNull()
      if (result) authService.logout(result.token)
    })

    it('rejects login with the old password after change', async () => {
      seedAccount('acc-1', 'alice')
      await authService.updatePassword('acc-1', 'new-password')
      expect(await authService.login('alice', 'password123')).toBeNull()
    })
  })

  // ─── setupFirstAdmin ─────────────────────────────────────────────────────────

  describe('setupFirstAdmin', () => {
    it('throws if accounts already exist', async () => {
      seedAccount('acc-1', 'alice')
      await expect(
        authService.setupFirstAdmin('any-token', 'admin2', 'pass')
      ).rejects.toThrow()
    })
  })
})
