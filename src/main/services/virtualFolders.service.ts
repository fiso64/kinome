/**
 * Owns Virtual Folder domain logic and manual operations.
 *   - resolveEffectiveFilter — recursively inherits parent filters for scope:parent
 *   - getVirtualChildren     — read-side entry point for resolving virtual folder contents
 *   - createUserVirtualFolder — creates a user-defined virtual folder
 *   - deleteVirtualFolder    — deletes a user-defined virtual folder
 */
import crypto from 'crypto'
import {
  insertVirtualItem,
  deleteItem,
} from '../database/repositories/filesystem.repo'
import {
  LibraryItem,
  MediaFolder,
  LibraryFilter,
  LibraryCondition
} from '@shared/types'
import { find, getItemById, type FindOptions } from './repository.service'
import { compileFilter, buildWhereFragment } from '../database/query-builder'

// --- Read operations ---

/**
 * Recursively resolves the "effective" filter of a virtual folder by
 * inheriting conditions from its parent if scope.parentId points to another
 * virtual folder.
 */
export async function resolveEffectiveFilter(filter: LibraryFilter): Promise<LibraryFilter> {
  const parentId = filter.scope?.parentId
  if (!parentId || parentId === 'root' || filter.scope?.manual) {
    return filter
  }

  // Check if parent is virtual
  const parent = await getItemById(parentId)
  if (!parent || parent.type !== 'folder' || !parent.isVirtual || !parent.filter) {
    return filter
  }

  // Recursively resolve parent's effective filter
  const effectiveParent = await resolveEffectiveFilter(parent.filter)

  // Merge: Each group in the parent is combined with every group in the child (cross product)
  let childGroups = filter.conditionGroups ?? (filter.conditions ? [filter.conditions] : [[]])
  if (childGroups.length === 0) childGroups = [[]]

  let parentGroups = effectiveParent.conditionGroups ?? (effectiveParent.conditions ? [effectiveParent.conditions] : [[]])
  if (parentGroups.length === 0) parentGroups = [[]]

  const mergedGroups: LibraryCondition[][] = []
  for (const pg of parentGroups) {
    for (const cg of childGroups) {
      mergedGroups.push([...pg, ...cg])
    }
  }

  return {
    scope: effectiveParent.scope, // Inherit terminal filesystem scope (e.g. 'movies' root)
    conditionGroups: mergedGroups
  }
}

/**
 * Entry point for resolving the contents of a virtual folder (Branch A2).
 * Compiles the effective filter and merges with manually parented virtual children.
 */
export async function getVirtualChildren(
  item: MediaFolder,
  options: FindOptions
): Promise<LibraryItem[]> {
  const filter = item.filter
  if (!filter) return []

  const effectiveFilter = await resolveEffectiveFilter(filter)
  const compiled = compileFilter(effectiveFilter)

  // Merge manually parented virtual children with the results of the filter.
  const fragment = buildWhereFragment({
    ...compiled,
    includeHidden: true,
    includeIgnored: true
  })

  const filterPart = `(${fragment.conditions.join(' AND ')})`
  const virtualChildrenSql = `(i.parent_id = ? AND i.is_virtual = 1)`

  const combinedSql = `(${filterPart} OR ${virtualChildrenSql})`
  const combinedParams = [...fragment.params, item.id]

  return find({
    compiledConditions: {
      sql: combinedSql,
      params: combinedParams,
      tables: fragment.tables
    },
    fields: options.fields,
    orderBy: options.orderBy,
    limit: options.limit,
    offset: options.offset,
    includeHidden: options.includeHidden,
    includeIgnored: options.includeIgnored
  })
}

// --- Write operations ---

/**
 * Creates a user-defined virtual folder under the given parent.
 * Returns the new folder's UUID.
 */
export function createUserVirtualFolder(
  parentId: string,
  name: string,
  filter?: LibraryFilter
): string {
  const id = crypto.randomUUID()
  insertVirtualItem({
    id,
    parentId,
    name,
    virtualType: 'user',
    filterJson: filter ? JSON.stringify(filter) : undefined
  })
  return id
}

/**
 * Deletes a user-created virtual folder.
 * folder_settings cascade-delete automatically via FK.
 * Throws if the target item is not a user virtual folder.
 */
export function deleteVirtualFolder(id: string): void {
  const item = getItemById(id)
  if (!item || !item.isVirtual || item.virtualType !== 'user') {
    throw new Error(`deleteVirtualFolder: item ${id} is not a user virtual folder`)
  }
  deleteItem(id)
}
