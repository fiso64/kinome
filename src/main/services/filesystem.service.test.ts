/**
 * Filesystem Service Tests
 *
 * Integration tests for filesystem scan entry points and their invariants.
 * Uses an in-memory SQLite DB via createServiceTestContext().
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { HOME_FOLDER_ID } from '../database/repositories/filesystem.repo'
import * as repositoryService from './repository.service'

let ctx: ServiceTestContext

beforeEach(() => {
  ctx = createServiceTestContext()
})

afterEach(() => {
  ctx.cleanup()
})

describe('ensureRootExists', () => {
  it('creates the root item', () => {
    repositoryService.ensureRootExists('/media/library')

    const root = repositoryService.getRoot()
    expect(root).not.toBeNull()
    expect(root!.path).toBe('.')
    expect(root!.type).toBe('folder')
  })

  it('creates the home virtual folder alongside root', () => {
    repositoryService.ensureRootExists('/media/library')

    const home = repositoryService.getItemById(HOME_FOLDER_ID)
    expect(home).not.toBeNull()
    expect(home!.isVirtual).toBe(true)
    expect(home!.type).toBe('folder')
  })

  it('home virtual folder is parented to root', () => {
    repositoryService.ensureRootExists('/media/library')

    const root = repositoryService.getRoot()
    const home = repositoryService.getItemById(HOME_FOLDER_ID)
    expect(home!.parentId).toBe(root!.id)
  })

  it('home virtual folder has a filter scoped to root', () => {
    repositoryService.ensureRootExists('/media/library')

    const root = repositoryService.getRoot()
    const home = repositoryService.getItemById(HOME_FOLDER_ID) as any
    const row = ctx.db.prepare('SELECT filter_json FROM items WHERE id = ?').get(HOME_FOLDER_ID) as any
    const filter = JSON.parse(row?.filter_json ?? 'null')
    expect(filter).toEqual({ scope: { parentId: root!.id } })
  })

  it('is idempotent — calling twice does not duplicate', () => {
    repositoryService.ensureRootExists('/media/library')
    repositoryService.ensureRootExists('/media/library')

    const roots = ctx.db.prepare("SELECT * FROM items WHERE parent_id IS NULL AND is_virtual = 0").all()
    expect(roots).toHaveLength(1)

    const homes = ctx.db.prepare("SELECT * FROM items WHERE id = ?").all(HOME_FOLDER_ID)
    expect(homes).toHaveLength(1)
  })
})
