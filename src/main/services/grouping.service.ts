import crypto from 'crypto'
import { runTransaction } from '../database/client'
import {
  insertVirtualItem,
  deleteVirtualItemsByType,
  deleteItem,
  getDistinctSeasonNumbers,
  getVirtualSeasonFolderIds,
  getVirtualGroupingFolderIds,
  getFoldersWithActiveGrouping
} from '../database/repositories/filesystem.repo'
import {
  LibraryItem,
  MediaFolder,
  LibraryFilter,
  LibraryCondition
} from '@shared/types'
import { mergeSettings } from '../database/repositories/settings.repo'
import { upsertMetadata } from '../database/repositories/metadata.repo'
import { getValuesForKey, REPOSITORY_SCHEMA } from '../database/repo-definitions'
import { find, getItemById, type FindOptions } from './repository.service'
import { compileFilter } from '../database/query-builder'
import { displayTitle } from '@shared/display-names'
import { resolveEffectiveFilter } from './virtualFolders.service'

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
 * Returns children for an item that has grouping active (Branch A1 or Grouped Branch B).
 */
export async function getGroupedChildren(
  item: LibraryItem,
  options: FindOptions
): Promise<LibraryItem[]> {
  const targetId = item.id
  const loose = looseItemCondition(item)
  const fields = options.fields ? [...options.fields] : undefined

  if (loose && fields && !fields.includes(loose.field)) {
    fields.push(loose.field)
  }

  return find({
    where: { parentId: targetId },
    rawConditions: [loose ? loose.condition : childrenFilter(item)],
    fields,
    orderBy: options.orderBy,
    compiledOrderPrefix: options.compiledOrderPrefix,
    limit: options.limit,
    offset: options.offset,
    includeHidden: options.includeHidden,
    includeIgnored: options.includeIgnored,
    userId: options.userId
  })
}

/**
 * Deterministic ID for a grouping virtual folder.
 */
function groupingFolderId(parentId: string, groupByKey: string, value: string): string {
  return crypto.createHash('sha256').update(`virtual:grouping:${parentId}:${groupByKey}:${value}`).digest('hex')
}

/**
 * Resolves real children and filter scope for a folder.
 */
function resolveChildrenAndScope(folderId: string) {
  const folder = getItemById(folderId) as MediaFolder | null
  if (!folder) throw new Error(`applyGrouping: folder '${folderId}' not found`)
  const fields = ['id', 'type', 'mediaType', 'seasonNumber', 'year', 'virtualTags', 'tags', 'genres']

  let realChildren
  if (folder.isVirtual && folder.filter) {
    const effectiveFilter = resolveEffectiveFilter(folder.filter)
    const compiled = compileFilter(effectiveFilter)
    realChildren = find({ ...compiled, fields })
  } else {
    realChildren = find({
      where: { parentId: folderId },
      rawConditions: ['i.is_virtual = 0'],
      fields
    })
  }

  let inheritedFilter: LibraryFilter
  if (folder.isVirtual && folder.filter) {
    inheritedFilter = folder.filter
  } else {
    inheritedFilter = { scope: { parentId: folderId } }
  }

  return { realChildren, inheritedFilter }
}

function collectUniqueValues(items: any[], groupByKey: string) {
  const uniqueValues = new Set<string>()
  let hasUncategorized = false
  for (const item of items) {
    const vals = getValuesForKey(item, groupByKey)
    if (vals.length === 0) hasUncategorized = true
    else vals.forEach((v) => uniqueValues.add(v))
  }
  return { uniqueValues, hasUncategorized }
}

function buildGroupingFilter(parent: LibraryFilter, extra: LibraryCondition): LibraryFilter {
  let groups = parent.conditionGroups
    ?? (parent.conditions ? [parent.conditions] : [[]])
  if (groups.length === 0) groups = [[]]
  return {
    scope: parent.scope,
    conditionGroups: groups.map(group => [...group, extra]),
  }
}

export function applyGrouping(folderId: string, groupByKey: string): void {
  const { realChildren, inheritedFilter } = resolveChildrenAndScope(folderId)
  const { uniqueValues, hasUncategorized } = collectUniqueValues(realChildren, groupByKey)

  const desiredIds = new Set<string>()
  for (const value of uniqueValues) {
    desiredIds.add(groupingFolderId(folderId, groupByKey, value))
  }
  if (hasUncategorized) {
    desiredIds.add(groupingFolderId(folderId, groupByKey, '__uncategorized__'))
  }

  const existingIds = new Set(getVirtualGroupingFolderIds(folderId))
  const unchanged = desiredIds.size === existingIds.size && [...desiredIds].every(id => existingIds.has(id))

  if (!unchanged) {
    runTransaction(() => {
      for (const existingId of existingIds) {
        if (!desiredIds.has(existingId)) deleteItem(existingId)
      }

      for (const value of uniqueValues) {
        const id = groupingFolderId(folderId, groupByKey, value)
        const filter = buildGroupingFilter(inheritedFilter, { field: groupByKey, op: 'eq', value })
        insertVirtualItem({
          id,
          parentId: folderId,
          name: value,
          virtualType: 'grouping',
          filterJson: JSON.stringify(filter),
          insertOrIgnore: true
        })
        if (!existingIds.has(id)) {
          upsertMetadata(id, { title: displayTitle(groupByKey, value) })
        }
      }

      if (hasUncategorized) {
        const id = groupingFolderId(folderId, groupByKey, '__uncategorized__')
        const filter = buildGroupingFilter(inheritedFilter, { field: groupByKey, op: 'isNull' })
        insertVirtualItem({
          id,
          parentId: folderId,
          name: 'Uncategorized',
          virtualType: 'grouping',
          filterJson: JSON.stringify(filter),
          insertOrIgnore: true
        })
        if (!existingIds.has(id)) {
          upsertMetadata(id, { title: 'Uncategorized' })
        }
      }

      mergeSettings(folderId, { viewSettings: { appliedGrouping: groupByKey } })
    })
  }

}

export function syncAllGroupings(): void {
  const activeGroupings = getFoldersWithActiveGrouping()
  for (const { item_id, group_by_key } of activeGroupings) {
    applyGrouping(item_id, group_by_key)
  }
}

export function removeGrouping(folderId: string): void {
  runTransaction(() => {
    deleteVirtualItemsByType(folderId, 'grouping')
    mergeSettings(folderId, { viewSettings: { appliedGrouping: null } })
  })
}

export function syncVirtualSeasonFolders(showId: string): void {
  const seasonNumbers = getDistinctSeasonNumbers(showId)

  if (seasonNumbers.length === 0) {
    runTransaction(() => {
      deleteVirtualItemsByType(showId, 'season')
      mergeSettings(showId, { viewSettings: { appliedGrouping: null } })
    })
    return
  }

  const currentIds = new Set(seasonNumbers.map((n) => seasonFolderId(showId, n)))
  const existingIds = getVirtualSeasonFolderIds(showId)

  runTransaction(() => {
    for (const existingId of existingIds) {
      if (!currentIds.has(existingId)) deleteItem(existingId)
    }

    for (const seasonNumber of seasonNumbers) {
      const id = seasonFolderId(showId, seasonNumber)
      const filter: LibraryFilter = {
        scope: { parentId: showId },
        conditions: [{ field: 'seasonNumber', op: 'eq', value: seasonNumber }]
      }
      insertVirtualItem({
        id,
        parentId: showId,
        name: `Season ${seasonNumber}`,
        virtualType: 'season',
        filterJson: JSON.stringify(filter),
        insertOrIgnore: true
      })
      upsertMetadata(id, { seasonNumber, mediaType: 'season' })
    }

    mergeSettings(showId, { viewSettings: { appliedGrouping: 'seasonNumber' } })
  })
}

function seasonFolderId(showId: string, seasonNumber: number): string {
  return crypto.createHash('sha256').update(`virtual:season:${showId}:${seasonNumber}`).digest('hex')
}
