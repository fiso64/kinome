/**
 * ACCOUNT FILTER SERVICE
 * Pre-computes per-account visible item sets based on admin-defined filter rules.
 *
 * Allow mode: shows only items matching the filter + their descendants + their ancestors.
 * Deny mode: hides items matching the filter + their descendants; everything else is visible.
 *
 * The result is materialized into account_visible_items for fast O(1) query-time lookup.
 */
import { getDb } from '../database/client'
import * as accountFilterRepo from '../database/repositories/account-filter.repo'
import { compileFilter, buildWhereFragment } from '../database/query-builder'

export function rebuildForAccount(accountId: string): void {
  const rule = accountFilterRepo.getFilterRule(accountId)

  if (!rule) {
    accountFilterRepo.replaceVisibleItems(accountId, [])
    return
  }

  const compiled = compileFilter(rule.filter)
  const { conditions, params, tables } = buildWhereFragment({
    ...compiled,
    includeHidden: true,
    includeIgnored: true,
  })

  const entityJoin = tables.has('e') ? 'LEFT JOIN media_entities e ON i.entity_id = e.id' : ''

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : 'WHERE 1=1'

  const db = getDb()

  // Fetch the matching seeds and all real items separately, then expand
  // ancestor/descendant relationships in JS with startsWith — avoids the
  // O(items × seeds) unindexed LIKE cross-scan that SQLite can't optimise.
  const seedSql = `SELECT i.id, i.path FROM items i ${entityJoin} ${whereSql}`
  const seeds = db.prepare(seedSql).all(...params) as { id: string; path: string }[]
  const allItems = db.prepare('SELECT id, path FROM items WHERE is_virtual = 0').all() as { id: string; path: string }[]

  let ids: string[]

  if (rule.mode === 'allow') {
    // Visible = seeds + all their descendants + all their ancestors (for navigation)
    const seedPaths = seeds.map((s) => s.path)
    const seedPathSet = new Set(seedPaths)
    ids = allItems
      .filter((item) =>
        seedPathSet.has(item.path) ||
        seedPaths.some((sp) => item.path.startsWith(sp + '/')) ||
        seedPaths.some((sp) => sp.startsWith(item.path + '/'))
      )
      .map((item) => item.id)
  } else {
    // Visible = all real items EXCEPT the denied subtrees (denied seeds + their descendants)
    const deniedPaths = seeds.map((s) => s.path)
    const deniedPathSet = new Set(deniedPaths)
    ids = allItems
      .filter(
        (item) =>
          !deniedPathSet.has(item.path) &&
          !deniedPaths.some((dp) => item.path.startsWith(dp + '/'))
      )
      .map((item) => item.id)
  }

  accountFilterRepo.replaceVisibleItems(accountId, ids)
  accountLastBuiltVersion.set(accountId, globalDirtyVersion)
  console.log(
    `[${new Date().toISOString()}] [AccountFilter] Rebuilt visibility for account ${accountId}: ${ids.length} visible items (mode=${rule.mode})`
  )
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
const accountLastBuiltVersion = new Map<string, number>()

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
 */
export function ensureUpToDate(accountId: string): void {
  if ((accountLastBuiltVersion.get(accountId) ?? -1) >= globalDirtyVersion) return
  // Mark as up to date first so concurrent calls don't pile up
  accountLastBuiltVersion.set(accountId, globalDirtyVersion)
  if (accountFilterRepo.hasFilterRule(accountId)) {
    rebuildForAccount(accountId)
  }
}
