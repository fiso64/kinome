/**
 * ACCOUNT FILTER SERVICE
 * Pre-computes per-account visible item sets based on admin-defined filter rules.
 *
 * Allow mode: includes each matching subtree and its navigation ancestors.
 * A conflicting local tag stops inheritance for that OR group. A direct match
 * in another group can keep the branch visible.
 * Deny mode: hides items matching the filter + their descendants; everything else is visible.
 *
 * The result is materialized into account_visible_items for fast O(1) query-time lookup.
 */
import { getDb } from '../database/client'
import * as accountFilterRepo from '../database/repositories/account-filter.repo'
import {
  buildFindQuery,
  compileConditionToSql,
  compileFilter,
  type FindOptions,
} from '../database/query-builder'
import { ITEM_READ_MODEL, withSourceLocations } from '../database/media-read-model.sql'
import type { AccountFilterRule, LibraryCondition } from '@shared/types'

type ItemRow = { id: string; parent_id: string | null }
type FindIds = (options: FindOptions) => string[]

function findIds(options: FindOptions, source?: string): string[] {
  const { query, params } = buildFindQuery({
    ...options,
    fields: ['id'],
    rawConditions: source
      ? [...(options.rawConditions ?? []), 'i.selected_location_id IS NOT NULL']
      : options.rawConditions,
    includeHidden: true,
    includeIgnored: true,
  })
  const rows = source
    ? getDb().prepare(withSourceLocations(query)).all(source, ...params)
    : getDb().prepare(query).all(...params)
  return (rows as { id: string }[]).map(({ id }) => id)
}

function findTagConflicts(group: LibraryCondition[], findMatching: FindIds): string[] {
  const tests = group
    .filter(({ field }) => /^(tags|vt|virtualTags)\./.test(field))
    .map(({ field, op, value }) => {
      const present = compileConditionToSql(field, 'isNotNull')
      const matches = compileConditionToSql(field, op, value)
      return {
        sql: `(${present.sql} AND NOT (${matches.sql}))`,
        params: [...present.params, ...matches.params],
      }
    })
  if (tests.length === 0) return []
  return findMatching({
    rawConditions: ['i.is_virtual = 0'],
    compiledConditions: {
      sql: `(${tests.map(({ sql }) => sql).join(' OR ')})`,
      params: tests.flatMap(({ params }) => params),
      tables: new Set(),
    },
  })
}

function computeVisibility(rule: AccountFilterRule, allItems: ItemRow[], findMatching: FindIds): Set<string> {
  const childrenByParent = new Map<string | null, string[]>()
  const parentById = new Map<string, string | null>()
  for (const item of allItems) {
    parentById.set(item.id, item.parent_id)
    const children = childrenByParent.get(item.parent_id) ?? []
    children.push(item.id)
    childrenByParent.set(item.parent_id, children)
  }

  const collectSubtree = (id: string, target: Set<string>) => {
    const pending = [id]
    while (pending.length > 0) {
      const current = pending.pop()!
      if (target.has(current)) continue
      target.add(current)
      for (const child of childrenByParent.get(current) ?? []) pending.push(child)
    }
  }

  if (rule.mode === 'allow') {
    const groups = rule.filter.conditionGroups ?? [rule.filter.conditions ?? []]
    const filterGroups = groups.length > 0 ? groups : [[]]
    const rules = filterGroups.map((group) => ({
      seeds: new Set(findMatching(compileFilter({ ...rule.filter, conditionGroups: [group] }))),
      conflicts: new Set(findTagConflicts([...group, ...(rule.filter.requiredConditions ?? [])], findMatching)),
    }))
    const pending = allItems
      .filter(({ parent_id }) => parent_id === null || !parentById.has(parent_id))
      .map(({ id }) => ({ id, inherited: [] as number[] }))
    const visible = new Set<string>()
    while (pending.length > 0) {
      const { id, inherited } = pending.pop()!
      const allowed = []
      for (const [index, { seeds, conflicts }] of rules.entries()) {
        if (seeds.has(id) || (inherited.includes(index) && !conflicts.has(id))) allowed.push(index)
      }

      if (allowed.length > 0) {
        visible.add(id)
        let parent = parentById.get(id)
        while (parent && !visible.has(parent)) {
          visible.add(parent)
          parent = parentById.get(parent)
        }
      } else if (inherited.length > 0) {
        continue
      }

      for (const child of childrenByParent.get(id) ?? []) {
        pending.push({ id: child, inherited: allowed })
      }
    }
    return visible
  }

  const denied = new Set<string>()
  for (const seed of findMatching(compileFilter(rule.filter))) collectSubtree(seed, denied)
  return new Set(allItems.map(({ id }) => id).filter((id) => !denied.has(id)))
}

function usesLocationFields(rule: AccountFilterRule): boolean {
  const { conditionGroups, conditions, requiredConditions } = rule.filter
  return [...(conditionGroups?.flat() ?? conditions ?? []), ...(requiredConditions ?? [])]
    .some(({ field }) => /^(parent\.)*(path|sourceId|size|mtime|birthtime|inode|deviceId|isIgnored|file\..+)$/.test(field))
}

export function rebuildForAccount(accountId: string): number {
  const rule = accountFilterRepo.getFilterRule(accountId)
  if (!rule) {
    accountFilterRepo.replaceVisibleItems(accountId, [])
    return recordVisibilityRebuild(accountId)
  }

  const db = getDb()
  const rowsSql = `SELECT id, parent_id, selected_location_id FROM ${ITEM_READ_MODEL} WHERE is_virtual = 0`
  const allItems = db.query(`
    SELECT id, parent_item_id AS parent_id FROM media_items WHERE is_virtual = 0
  `).all() as ItemRow[]
  let visible: Set<string>
  const excluded: string[] = []
  if (!usesLocationFields(rule)) {
    visible = computeVisibility(rule, allItems, findIds)
  } else {
    visible = new Set()
    const allowedLocations = new Set<string>()
    const sources = db.prepare('SELECT DISTINCT source_id FROM media_locations').all() as { source_id: string }[]
    const bySource = db.prepare(withSourceLocations(`${rowsSql} AND selected_location_id IS NOT NULL`))
    for (const { source_id } of sources) {
      const rows = bySource.all(source_id) as (ItemRow & { selected_location_id: string })[]
      const locationItems = computeVisibility(rule, rows, (options) => findIds(options, source_id))
      for (const row of rows) {
        if (!locationItems.has(row.id)) continue
        visible.add(row.id)
        allowedLocations.add(row.selected_location_id)
      }
    }

    // Logical parents can differ from physical parents after a move.
    const parents = new Map(allItems.map(({ id, parent_id }) => [id, parent_id]))
    if (rule.mode === 'allow') {
      for (const id of visible) {
        let parent = parents.get(id)
        while (parent && !visible.has(parent)) {
          visible.add(parent)
          parent = parents.get(parent)
        }
      }
    }
    const locationIds = db.prepare('SELECT id, item_id FROM media_locations').all() as { id: string; item_id: string }[]
    for (const { id, item_id } of locationIds) {
      if (visible.has(item_id) && !allowedLocations.has(id)) excluded.push(id)
    }
  }

  const ids = [...visible]
  accountFilterRepo.replaceVisibleItems(accountId, ids, excluded)
  const revision = recordVisibilityRebuild(accountId)
  console.log(
    `[${new Date().toISOString()}] [AccountFilter] Rebuilt visibility for account ${accountId}: ${ids.length} visible items (mode=${rule.mode})`
  )
  return revision
}

export function rebuildAll(): void {
  const accountIds = accountFilterRepo.getAllFilteredAccountIds()
  for (const accountId of accountIds) {
    rebuildForAccount(accountId)
  }
}

// ── Lazy rebuild machinery ──────────────────────────────────────────────────────

/**
 * Global version counter. Incremented whenever item metadata changes, signalling
 * that pre-computed visibility sets may be stale.
 */
let globalDirtyVersion = 0

/**
 * Per-account version at which visibility was last rebuilt.
 * Accounts not present in the map are treated as never built (version = -1).
 */
const accountVisibility = new Map<string, { builtVersion: number; revision: number }>()

function recordVisibilityRebuild(accountId: string): number {
  const revision = (accountVisibility.get(accountId)?.revision ?? 0) + 1
  accountVisibility.set(accountId, { builtVersion: globalDirtyVersion, revision })
  return revision
}

export function removeRuleForAccount(accountId: string): void {
  accountFilterRepo.deleteFilterRule(accountId)
  recordVisibilityRebuild(accountId)
}

/**
 * Signal that visibility sets may be stale. O(1) — just bumps a counter.
 * Call this instead of rebuildAll() whenever item metadata or tags change.
 */
export function markDirty(): void {
  globalDirtyVersion++
}

/**
 * Rebuild visibility for a single account if it is stale.
 * Called on the hot path (every find/search with a userId), so it must be fast
 * in the common case (already up to date → single map lookup, no DB I/O).
 * The revision changes when visibility is rebuilt or a rule is removed.
 */
/** Those of the given items the account may see, after bringing its visibility up to date. */
export function visibleItemIds(accountId: string, itemIds: string[]): Set<string> {
  ensureUpToDate(accountId)
  if (!itemIds.length || !accountFilterRepo.hasFilterRule(accountId)) return new Set(itemIds)
  return new Set(accountFilterRepo.filterVisibleItemIds(accountId, itemIds))
}

export function ensureUpToDate(accountId: string): number {
  const previous = accountVisibility.get(accountId)
  if (previous?.builtVersion === globalDirtyVersion) return previous.revision
  if (accountFilterRepo.hasFilterRule(accountId)) return rebuildForAccount(accountId)
  const revision = previous?.revision ?? 0
  accountVisibility.set(accountId, { builtVersion: globalDirtyVersion, revision })
  return revision
}
