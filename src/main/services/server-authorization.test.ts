/**
 * HTTP Authorization Tests — Capability Enforcement
 *
 * Strategy:
 * - Normal-user tests: every protected route individually (full coverage).
 * - Admin-user tests: one clean representative per capability group, sufficient
 *   to prove the guard is two-directional without noisy service errors.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import bcrypt from 'bcryptjs'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { buildApp } from '../http-app'
import * as accountRepo from '../database/repositories/account.repo'
import * as authService from './auth.service'

describe('HTTP authorization — capability enforcement', () => {
  let ctx: ServiceTestContext
  let normalToken: string
  let adminToken: string
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    ctx = createServiceTestContext()
    app = buildApp()

    const hash = await bcrypt.hash('password', 1)
    accountRepo.createAccount('admin-1', 'alice', hash, 'admin')
    accountRepo.createAccount('normal-1', 'bob', hash, 'normal')

    normalToken = (await authService.login('bob', 'password'))!.token
    adminToken = (await authService.login('alice', 'password'))!.token
  })

  afterAll(() => {
    authService.logout(normalToken)
    authService.logout(adminToken)
    ctx.cleanup()
  })

  function req(method: string, url: string, body?: any, token = normalToken): Request {
    return new Request(`http://localhost${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
  }

  const expect403 = async (method: string, url: string, body?: any) =>
    expect((await app.handle(req(method, url, body))).status).toBe(403)

  const expectNotBlocked = async (method: string, url: string, body?: any) =>
    expect((await app.handle(req(method, url, body, adminToken))).status).not.toBe(403)

  // ─── editSettings ────────────────────────────────────────────────────────────

  describe('editSettings — normal user blocked', () => {
    it('POST /api/save-settings',           () => expect403('POST', '/api/save-settings', {}))
    it('POST /api/save-source',             () => expect403('POST', '/api/save-source', { source: {} }))
    it('GET  /api/list-directory',          () => expect403('GET',  '/api/list-directory?path=/'))
    it('POST /api/resolve-media-source-path', () => expect403('POST', '/api/resolve-media-source-path', { path: '/', isRelative: false }))
    it('POST /api/reveal-in-explorer',      () => expect403('POST', '/api/reveal-in-explorer', { path: '/' }))
  })

  it('editSettings — admin is not blocked (list-directory)', () =>
    // Listing '/' is a real FS call that always succeeds cleanly.
    expectNotBlocked('GET', '/api/list-directory?path=/'))

  // ─── triggerLibraryScan ──────────────────────────────────────────────────────

  describe('triggerLibraryScan — normal user blocked', () => {
    it('POST /api/perform-scan',                    () => expect403('POST', '/api/perform-scan', {}))
    it('POST /api/apply-initial-folder-settings',   () => expect403('POST', '/api/apply-initial-folder-settings', { settings: [] }))
  })

  it('triggerLibraryScan — admin is not blocked (apply-initial-folder-settings)', () =>
    // Empty settings list is a no-op that completes without errors.
    expectNotBlocked('POST', '/api/apply-initial-folder-settings', { settings: [] }))

  // ─── editMetadata ────────────────────────────────────────────────────────────

  describe('editMetadata — normal user blocked', () => {
    it('PATCH /api/items',                            () => expect403('PATCH', '/api/items', { id: 'x' }))
    it('POST /api/items/:id/grouping',                () => expect403('POST', '/api/items/x/grouping', { groupByKey: null }))
    it('POST /api/items/:id/virtual-folders',         () => expect403('POST', '/api/items/x/virtual-folders', { name: 'Test' }))
    it('POST /api/clear-item-metadata',               () => expect403('POST', '/api/clear-item-metadata', { itemId: 'x', childrenOnly: false }))
    it('POST /api/clear-virtual-folder-metadata',     () => expect403('POST', '/api/clear-virtual-folder-metadata', { itemIds: [] }))
    it('POST /api/fetch-credits',                     () => expect403('POST', '/api/fetch-credits', { itemId: 'x' }))
    it('POST /api/manual-search',                     () => expect403('POST', '/api/manual-search', { query: '', type: 'movie' }))
    it('POST /api/get-tmdb-images',                   () => expect403('POST', '/api/get-tmdb-images', { tmdbId: 1, mediaType: 'movie', language: 'en' }))
    it('POST /api/user-apply-tmdb-result',            () => expect403('POST', '/api/user-apply-tmdb-result', { itemId: 'x', result: {}, mediaType: 'movie' }))
    it('POST /api/user-set-image',                    () => expect403('POST', '/api/user-set-image', { itemId: 'x', imageType: 'poster', source: {} }))
    it('POST /api/remove-image',                      () => expect403('POST', '/api/remove-image', { itemId: 'x', imageType: 'poster' }))
    it('POST /api/upload-image',                      () => expect403('POST', '/api/upload-image', { itemId: 'x', imageType: 'poster' }))
    it('POST /api/assign-seasons-and-episodes',       () => expect403('POST', '/api/assign-seasons-and-episodes', { showId: 'x', seasonStrategy: 'smart', episodeStrategy: 'smart', fetchMetadata: false }))
    it('POST /api/rename-item',                       () => expect403('POST', '/api/rename-item', { itemId: 'x', newName: 'y' }))
    it('POST /api/delete-item-from-db',               () => expect403('POST', '/api/delete-item-from-db', { itemId: 'x' }))
    it('POST /api/trash-item',                        () => expect403('POST', '/api/trash-item', { itemId: 'x' }))
    it('POST /api/execute-custom-action',             () => expect403('POST', '/api/execute-custom-action', { itemId: 'x', commandId: 'y' }))
  })

  it('editMetadata — admin is not blocked (clear-virtual-folder-metadata)', () =>
    // Empty itemIds is a no-op that completes without errors.
    expectNotBlocked('POST', '/api/clear-virtual-folder-metadata', { itemIds: [] }))

  // ─── manageAccounts ──────────────────────────────────────────────────────────

  describe('manageAccounts — normal user blocked', () => {
    it('GET /api/accounts',                           () => expect403('GET',    '/api/accounts'))
    it('POST /api/accounts',                          () => expect403('POST',   '/api/accounts', { username: 'x', password: 'y', role: 'normal' }))
    it('PUT /api/accounts/:id/role',                  () => expect403('PUT',    '/api/accounts/other-1/role', { role: 'admin' }))
    it('DELETE /api/accounts/:id',                    () => expect403('DELETE', '/api/accounts/other-1'))
    it('POST /api/accounts/:id/password (other user)', () => expect403('POST',  '/api/accounts/admin-1/password', { password: 'newpw' }))
  })

  it('manageAccounts — admin is not blocked (list accounts)', () =>
    expectNotBlocked('GET', '/api/accounts'))

  it('manageAccounts — normal user CAN change own password', async () => {
    expect((await app.handle(req('POST', '/api/accounts/normal-1/password', { password: 'newpw' }))).status).not.toBe(403)
  })

  // ─── Unauthenticated requests ────────────────────────────────────────────────

  describe('unauthenticated', () => {
    it('request without token returns 401', async () => {
      expect((await app.handle(new Request('http://localhost/api/items'))).status).toBe(401)
    })

    it('login endpoint is public (body shows auth result, not middleware rejection)', async () => {
      const res = await app.handle(new Request('http://localhost/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'nobody', password: 'x' })
      }))
      expect(await res.json()).toHaveProperty('authenticated', false)
    })

    it('check-auth endpoint is public', async () => {
      expect((await app.handle(new Request('http://localhost/api/check-auth'))).status).not.toBe(403)
    })
  })
})
