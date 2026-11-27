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
import { rebuildForAccount, rebuildAll, markDirty } from './account-filter.service'
import { WebTransport } from '../transport/web.transport'
import type { LibraryItem } from '@shared/types'
import { find } from './repository.service'
import { replaceSourcePriorities, resolveSelectedLocationForItem } from '../database/repositories/media-location.repo'

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

  it('prunes a branch with an explicit conflicting tag and preserves siblings', () => {
    seedStandardTree()
    ctx.seedTags('e-a', { accepted: 'yes' })
    ctx.seedTags('e-f1', { accepted: 'no' })
    ctx.seedEntities([{ id: 'e-nested' }])
    ctx.seedItems([
      { id: 'nested', parentId: 'file1', path: '/lib/dir-a/file1/nested', type: 'file', entityId: 'e-nested' },
      { id: 'sibling', parentId: 'dir-a', path: '/lib/dir-a/sibling', type: 'file' },
    ])
    ctx.seedTags('e-nested', { accepted: 'yes' })
    setFilterRule('acc-filtered', 'allow', {
      conditions: [{ field: 'tags.accepted', op: 'eq', value: 'yes' }]
    })
    rebuildForAccount('acc-filtered')
    expect(getVisibleIds('acc-filtered')).toEqual(['dir-a', 'root', 'sibling'])
    expect(find({ where: { parentId: 'dir-a' }, userId: 'acc-filtered' }).map(({ id }) => id))
      .toEqual(['sibling'])
  })

  it('allows a child matching another value of the same tag in an OR group', () => {
    seedStandardTree()
    ctx.seedTags('e-a', { allow: 'yes' })
    ctx.seedTags('e-f1', { allow: 'maybe' })
    ctx.seedItems([
      { id: 'rejected', parentId: 'dir-a', path: '/lib/dir-a/rejected', type: 'file', entityId: 'e-f2' },
    ])
    ctx.seedTags('e-f2', { allow: 'no' })
    setFilterRule('acc-filtered', 'allow', {
      conditionGroups: [
        [{ field: 'tags.allow', op: 'eq', value: 'yes' }],
        [{ field: 'tags.allow', op: 'eq', value: 'maybe' }],
      ]
    })
    rebuildForAccount('acc-filtered')
    expect(getVisibleIds('acc-filtered')).toEqual(['dir-a', 'file1', 'root'])
    expect(find({ where: { parentId: 'dir-a' }, userId: 'acc-filtered' }).map(({ id }) => id))
      .toEqual(['file1'])
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
  it('selects the allowed occurrence for a location-scoped filter', () => {
    seedStandardTree()
    ctx.db.prepare(`
      INSERT INTO media_locations (
        id, item_id, source_id, relative_path, name, type, is_shadowed, shadowed_by_location_id, first_seen_at, last_seen_at
      )
      VALUES ('alternate-file1', 'file1', 'second-source', 'Allowed/file1', 'file1', 'file',
        1, 'location:file1', 1000, 1000)
    `).run()
    ctx.db.prepare("UPDATE media_items SET preferred_location_id = 'location:file1' WHERE id = 'file1'").run()
    replaceSourcePriorities(['test-source', 'second-source'])
    setFilterRule('acc-filtered', 'allow', {
      conditions: [{ field: 'path', op: 'contains', value: 'Allowed/' }],
    })
    rebuildForAccount('acc-filtered')

    expect(resolveSelectedLocationForItem('file1', { requirePresent: true })?.id).toBe('location:file1')
    expect(resolveSelectedLocationForItem('file1', { requirePresent: true, userId: 'acc-filtered' })?.id)
      .toBe('alternate-file1')
    expect(find({ where: { id: 'file1' }, fields: ['sourceId', 'path'], userId: 'acc-filtered' })[0])
      .toMatchObject({ sourceId: 'second-source', path: 'Allowed/file1' })
  })

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

describe('live item updates', () => {
  it('sends each account only items it may see, and an item an edit hid as removed', () => {
    seedStandardTree()
    ctx.seedTags('e-a', { allow: 'true' })
    setFilterRule('acc-filtered', 'allow', { conditionGroups: [[{ field: 'tags.allow', op: 'eq', value: 'true' }]] })
    markDirty()
    const sent: { topic: string; type: string; data: any }[] = []
    const transport = new WebTransport()
    transport.initialize({ publish: (topic: string, text: string) => sent.push({ topic, ...JSON.parse(text) }) })
    transport.connect('acc-filtered')
    transport.connect('acc-plain')
    const items = [{ id: 'dir-a' }, { id: 'dir-b' }] as LibraryItem[]
    const received = (account: string) => sent.filter((entry) => entry.topic === `broadcast:${account}`)
      .map((entry) => [entry.type, entry.data.map((item: any) => item.id ?? item)])

    transport.notifyLibraryItemsUpdated(items)
    expect(received('acc-filtered')).toEqual([['library-items-updated', ['dir-a']], ['library-items-removed', ['dir-b']]])
    expect(received('acc-plain')).toEqual([['library-items-updated', ['dir-a', 'dir-b']]])

    // The tag no longer matches, as after an edit.
    sent.length = 0
    ctx.db.prepare("UPDATE item_tags SET value = 'false' WHERE key = 'allow'").run()
    markDirty()
    transport.notifyLibraryItemsUpdated(items)
    expect(received('acc-filtered')).toEqual([['library-items-removed', ['dir-a', 'dir-b']]])
    expect(received('acc-plain')).toEqual([['library-items-updated', ['dir-a', 'dir-b']]])
    expect(sent.some((entry) => entry.topic === 'broadcast')).toBe(false)
  })
})
