import {
  LibraryItem,
  MediaFolder,
  ViewHierarchyNode,
  StoredViewSettings,
  LibraryFilter,
  LibraryCondition
} from '@shared/types'
import {
  find,
  getItemById,
  getHomeFolderId,
  FindOptions
} from './repository.service'
import { compileFilter, buildWhereFragment } from '../database/query-builder'
import { resolveViewSettings } from '@shared/settings-helpers'
import { readSettings } from './settings.service'
import { getLibraryRoot } from './library.service'
import { REPOSITORY_SCHEMA } from '../database/repo-definitions'

/**
 * Returns the SQL filter condition for listing a real folder's children.
 * Grouping active: show grouping/season/user virtual folders.
 * No grouping: show real items + user virtual folders.
 */
export function childrenFilter(item: LibraryItem): string {
  if (item.viewSettings?.appliedGrouping) {
    return `(i.virtual_type IN ('grouping', 'season', 'user'))`
  }
  return `(i.is_virtual = 0 OR i.virtual_type = 'user')`
}

/**
 * When grouping is active and the grouping key maps to a simple column,
 * returns an extra SQL condition to also include real items where the field
 * IS NULL — "loose" items not covered by any virtual folder.
 *
 * For subquery-based keys (e.g. genres), applyGrouping already creates an
 * Uncategorized folder, so no extra condition is needed.
 *
 * Returns null if no extra condition is needed.
 */
function looseItemCondition(item: LibraryItem): { condition: string; field: string } | null {
  const groupBy = item.viewSettings?.appliedGrouping
  if (!groupBy) return null
  const FIELD_ALIASES: Record<string, string> = { genre: 'genres' }
  const resolvedKey = FIELD_ALIASES[groupBy] ?? groupBy
  const def = REPOSITORY_SCHEMA[resolvedKey]
  if (def && !def.isSubquery) {
    return {
      condition: `(i.virtual_type IN ('grouping', 'season', 'user') OR (i.is_virtual = 0 AND ${def.sql} IS NULL))`,
      field: resolvedKey
    }
  }
  return null
}

/**
 * Entry point for fetching folder children. Handles:
 * 1. Root alias resolution
 * 2. includeHidden / includeIgnored defaults
 * 3. Contextual default sorting (episodes → episodeNumber, tv → seasonNumber, else → name)
 * 4. Three DB-driven branches:
 *    a. Virtual folder    → compile pool query
 *    b. Grouping active   → return grouping + user virtual children
 *    c. No grouping       → return real + user virtual children
 * 5. Eager child embedding for container layouts (prevents N+1)
 */

/**
 * Returns children for an item that has grouping active (Branch A1 or Grouped Branch B).
 */
export async function getGroupedChildren(
  item: LibraryItem,
  options: FindOptions
): Promise<LibraryItem[]> {
  const targetId = item.id
  const loose = looseItemCondition(item)
  const fields = options.fields ? [...options.fields] : undefined

  // If the loose-item condition references an entity column, ensure
  // that column is in the field list so the query builder JOINs the table.
  if (loose && fields && !fields.includes(loose.field)) {
    fields.push(loose.field)
  }

  return find({
    where: { parentId: targetId },
    rawConditions: [loose ? loose.condition : childrenFilter(item)],
    fields,
    orderBy: options.orderBy,
    limit: options.limit,
    offset: options.offset,
    includeHidden: options.includeHidden,
    includeIgnored: options.includeIgnored
  })
}

