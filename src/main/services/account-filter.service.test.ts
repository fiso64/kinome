/**
 * Account Filter Service Integration Tests
 *
 * Tests the full materialization pipeline: filter rules → account_visible_items.
 * Also tests that buildFindQuery enforces visibility correctly via find().
 *
 * Tree used by most tests:
 *
 *   /lib                (root, no entity)
 *   /lib/dir-a          (entity e-a, tag allow:true / deny:true)
 *   /lib/dir-a/file1    (entity e-f1, no tag)
 *   /lib/dir-b          (entity e-b, no tag)
 *   /lib/dir-b/file2    (entity e-f2, no tag)
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { createAccount } from '../database/repositories/account.repo'
import { setFilterRule, replaceVisibleItems } from '../database/repositories/account-filter.repo'
import { rebuildForAccount, rebuildAll } from './account-filter.service'
import { find } from './repository.service'

let ctx: ServiceTestContext

function seedStandardTree() {
  ctx.seedEntities([
    { id: 'e-a', mediaType: 'movie', title: 'Dir A' },
    { id: 'e-b', mediaType: 'movie', title: 'Dir B' },
    { id: 'e-f1', mediaType: 'movie', title: 'File 1' },
    { id: 'e-f2', mediaType: 'movie', title: 'File 2' }
  ])
  ctx.seedItems([
    { id: 'root', parentId: null, path: '/lib', type: 'folder' },
    { id: 'dir-a', parentId: 'root', path: '/lib/dir-a', type: 'folder', entityId: 'e-a' },
    { id: 'file1', parentId: 'dir-a', path: '/lib/dir-a/file1', type: 'file', entityId: 'e-f1' },
    { id: 'dir-b', parentId: 'root', path: '/lib/dir-b', type: 'folder', entityId: 'e-b' },
    { id: 'file2', parentId: 'dir-b', path: '/lib/dir-b/file2', type: 'file', entityId: 'e-f2' }
  ])
}

function getVisibleIds(accountId: string): string[] {
  const rows = ctx.db
    .prepare('SELECT item_id FROM account_visible_items WHERE account_id = ? ORDER BY item_id')
    .all(accountId) as { item_id: string }[]
  return rows.map((r) => r.item_id).sort()
}

beforeEach(() => {
  ctx = createServiceTestContext()
  createAccount('acc-filtered', 'filtered-user', 'hash', 'normal')
  createAccount('acc-plain', 'plain-user', 'hash', 'normal')
})

afterEach(() => {
  ctx.cleanup()
})

// ── Allow mode ─────────────────────────────────────────────────────────────────

describe('allow mode — seed by tag', () => {
  it('includes tagged item, its descendants, and its ancestors', () => {
    seedStandardTree()
    ctx.seedTags('e-a', { allow: 'true' }) // dir-a has the allow tag

    setFilterRule('acc-filtered', 'allow', {
      conditionGroups: [[{ field: 'tags.allow', op: 'eq', value: 'true' }]]
    })
    rebuildForAccount('acc-filtered')

    const visible = getVisibleIds('acc-filtered')
    // dir-a (seed), file1 (descendant), root (ancestor)
    expect(visible).toContain('dir-a')
    expect(visible).toContain('file1')
    expect(visible).toContain('root')
    // dir-b and file2 are not in the allow subtree
    expect(visible).not.toContain('dir-b')
    expect(visible).not.toContain('file2')
  })

  it('includes all tagged items and their subtrees', () => {
    seedStandardTree()
    ctx.seedTags('e-a', { allow: 'true' })
    ctx.seedTags('e-b', { allow: 'true' })

    setFilterRule('acc-filtered', 'allow', {
      conditionGroups: [[{ field: 'tags.allow', op: 'eq', value: 'true' }]]
    })
    rebuildForAccount('acc-filtered')

    const visible = getVisibleIds('acc-filtered')
    expect(visible).toContain('dir-a')
    expect(visible).toContain('file1')
    expect(visible).toContain('dir-b')
    expect(visible).toContain('file2')
    expect(visible).toContain('root')
  })

  it('stores empty visible set when no items match the filter', () => {
    seedStandardTree()
    // No tags set → no seeds

    setFilterRule('acc-filtered', 'allow', {
      conditionGroups: [[{ field: 'tags.allow', op: 'eq', value: 'true' }]]
    })
    rebuildForAccount('acc-filtered')

    expect(getVisibleIds('acc-filtered')).toHaveLength(0)
  })
})

// ── Deny mode ──────────────────────────────────────────────────────────────────

describe('deny mode — seed by tag', () => {
  it('excludes denied item and its descendants; siblings and ancestors remain visible', () => {
    seedStandardTree()
    ctx.seedTags('e-a', { deny: 'true' }) // deny dir-a and everything under it

    setFilterRule('acc-filtered', 'deny', {
      conditionGroups: [[{ field: 'tags.deny', op: 'eq', value: 'true' }]]
    })
    rebuildForAccount('acc-filtered')

    const visible = getVisibleIds('acc-filtered')
    expect(visible).not.toContain('dir-a')
    expect(visible).not.toContain('file1')
    // parent and sibling subtree remain visible
    expect(visible).toContain('root')
    expect(visible).toContain('dir-b')
    expect(visible).toContain('file2')
  })

  it('stores all real items when no items match the deny filter', () => {
    seedStandardTree()
    // No deny tags → nothing denied → all 5 items visible

    setFilterRule('acc-filtered', 'deny', {
      conditionGroups: [[{ field: 'tags.deny', op: 'eq', value: 'true' }]]
    })
    rebuildForAccount('acc-filtered')

    const visible = getVisibleIds('acc-filtered')
    expect(visible).toHaveLength(5)
  })
})

// ── rebuildAll ─────────────────────────────────────────────────────────────────

describe('rebuildAll', () => {
  it('rebuilds visibility for all filtered accounts', () => {
    seedStandardTree()
    ctx.seedTags('e-a', { allow: 'true' })

    createAccount('acc-second', 'second-user', 'hash', 'normal')
    ctx.seedTags('e-b', { allow2: 'true' })

    setFilterRule('acc-filtered', 'allow', {
      conditionGroups: [[{ field: 'tags.allow', op: 'eq', value: 'true' }]]
    })
    setFilterRule('acc-second', 'allow', {
      conditionGroups: [[{ field: 'tags.allow2', op: 'eq', value: 'true' }]]
    })

    rebuildAll()

    const v1 = getVisibleIds('acc-filtered')
    expect(v1).toContain('dir-a')
    expect(v1).not.toContain('dir-b')

    const v2 = getVisibleIds('acc-second')
    expect(v2).toContain('dir-b')
    expect(v2).not.toContain('dir-a')
  })
})

// ── find() integration ─────────────────────────────────────────────────────────

describe('find() with userId', () => {
  it('returns only visible items for a filtered account', () => {
    seedStandardTree()
    ctx.seedTags('e-a', { allow: 'true' })

    setFilterRule('acc-filtered', 'allow', {
      conditionGroups: [[{ field: 'tags.allow', op: 'eq', value: 'true' }]]
    })
    rebuildForAccount('acc-filtered')

    const items = find({ where: { parentId: 'root' }, userId: 'acc-filtered' })
    const ids = items.map((i) => i.id)
    expect(ids).toContain('dir-a')
    expect(ids).not.toContain('dir-b')
  })

  it('returns all items for an account with no filter rule', () => {
    seedStandardTree()

    const items = find({ where: { parentId: 'root' }, userId: 'acc-plain' })
    const ids = items.map((i) => i.id)
    expect(ids).toContain('dir-a')
    expect(ids).toContain('dir-b')
  })

  it('virtual items (is_virtual=1) always appear regardless of filter', () => {
    seedStandardTree()
    ctx.seedItems([
      { id: 'vfolder', parentId: 'root', path: '/lib/vfolder', type: 'folder', isVirtual: 1 }
    ])
    // Allow filter that matches nothing
    setFilterRule('acc-filtered', 'allow', {
      conditionGroups: [[{ field: 'tags.allow', op: 'eq', value: 'true' }]]
    })
    rebuildForAccount('acc-filtered')

    const items = find({ where: { parentId: 'root' }, userId: 'acc-filtered' })
    expect(items.map((i) => i.id)).toContain('vfolder')
  })
})
