import {
  LibraryItem,
  MediaFolder,
  ViewHierarchyNode,
  StoredViewSettings
} from '@shared/types'
import {
  find,
  getItemById,
  getHomeFolderId,
  FindOptions
} from './repository.service'
import { compileFilter } from '../database/query-builder'
import { resolveViewSettings } from '@shared/settings-helpers'
import { readSettings } from './settings.service'
import { getLibraryRoot } from './library.service'
import { REPOSITORY_SCHEMA } from '../database/repo-definitions'

/**
 * Returns the SQL filter condition for listing a real folder's children.
 * Grouping active: show grouping/season/user virtual folders.
 * No grouping: show real items + user virtual folders.
 */
function childrenFilter(item: LibraryItem): string {
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
export async function getChildren(
  id: string,
  options: FindOptions
): Promise<LibraryItem[] | { error: string; message: string; [key: string]: any }> {
  let targetId = id

  // 1. Resolve aliases
  if (id === 'home') {
    targetId = getHomeFolderId()
  } else if (id === 'root') {
    const status = await getLibraryRoot()
    if (status.status !== 'ready') {
      return {
        error: 'root_missing',
        message: `Library not ready: ${status.status}`,
        ...status
      }
    }
    targetId = status.root!.id
  }

  // 2. Apply defaults (without mutating the caller's object)
  const opts = { ...options }
  if (opts.includeHidden === undefined) opts.includeHidden = false
  if (opts.includeIgnored === undefined) opts.includeIgnored = false

  // 3. Fetch item
  const item = getItemById(targetId)
  if (!item) return { error: 'not_found', message: `Item ${targetId} not found` }

  // 4. Contextual default sorting
  if (!opts.orderBy) {
    if (item.mediaType === 'season') {
      opts.orderBy = [
        { field: 'typeRank', direction: 'ASC' },
        { field: 'episodeNumber', direction: 'ASC' },
      ]
    } else if (item.mediaType === 'tv') {
      opts.orderBy = [
        { field: 'typeRank', direction: 'ASC' },
        { field: 'seasonNumber', direction: 'ASC' },
        { field: 'displayName', direction: 'ASC' },
      ]
    } else {
      opts.orderBy = [
        { field: 'typeRank', direction: 'ASC' },
        { field: 'displayName', direction: 'ASC' },
      ]
    }
  }

  // 5. Resolve children
  let items: LibraryItem[]

  if (item.isVirtual) {
    if (item.viewSettings?.appliedGrouping) {
      // Branch A1: virtual folder with grouping — return grouping/season/user children
      // (virtual folders don't have loose real children, so no looseItemCondition needed)
      items = find({
        where: { parentId: targetId },
        rawConditions: [childrenFilter(item)],
        fields: opts.fields,
        orderBy: opts.orderBy,
        limit: opts.limit,
        offset: opts.offset,
        includeHidden: opts.includeHidden,
        includeIgnored: opts.includeIgnored
      })
    } else {
      // Branch A2: virtual folder without grouping — compile filter and run find()
      const filter = (item as MediaFolder).filter
      if (!filter) {
        items = []
      } else {
        const compiled = compileFilter(filter)
        items = find({
          ...compiled,
          fields: opts.fields,
          orderBy: opts.orderBy,
          limit: opts.limit,
          offset: opts.offset,
          includeHidden: opts.includeHidden,
          includeIgnored: opts.includeIgnored
        })
      }
    }
  } else {
    // Branch B/C: list real folder's children (grouping-aware)
    const loose = looseItemCondition(item)
    const fields = opts.fields ? [...opts.fields] : undefined
    // If the loose-item condition references an entity column, ensure
    // that column is in the field list so the query builder JOINs the table.
    if (loose && fields && !fields.includes(loose.field)) {
      fields.push(loose.field)
    }
    items = find({
      where: { parentId: targetId },
      rawConditions: [loose ? loose.condition : childrenFilter(item)],
      fields,
      orderBy: opts.orderBy,
      limit: opts.limit,
      offset: opts.offset,
      includeHidden: opts.includeHidden,
      includeIgnored: opts.includeIgnored
    })
  }

  // 6. Eagerly embed children for container-layout folders.
  // Also embed when the folder has an active grouping — its children are
  // virtual grouping folders that need their own children pre-fetched.
  const settings = await readSettings()
  const ownSettings = resolveViewSettings(item as any, settings).settings
  const hasGrouping = !!item.viewSettings?.appliedGrouping
  if (['tabs', 'sections'].includes(ownSettings.layout) || hasGrouping) {
    await embedChildrenForContainers(items, opts)
  }

  return items
}

/**
 * When a parent uses a tabs or sections layout, its child folders need their
 * children pre-fetched so the frontend can render tab content without N+1.
 * Recurses if a child is itself a container layout.
 */
async function embedChildrenForContainers(
  items: LibraryItem[],
  options: FindOptions
): Promise<void> {
  for (const item of items) {
    if (item.type !== 'folder') continue
    const result = await getChildren(item.id, { fields: options.fields })
    if (Array.isArray(result)) {
      ;(item as MediaFolder).children = result
    }
  }
}

/**
 * Recursively resolves the complete view hierarchy for a given item.
 * Side-channel for the frontend to know layout structure in advance.
 */
export async function resolveViewHierarchy(
  itemId: string,
  recursive = true,
  depth = 0,
  inheritedSettings?: StoredViewSettings
): Promise<ViewHierarchyNode | null> {
  if (depth > 10) return null

  // 1. Resolve root alias
  let targetId = itemId
  if (itemId === 'root') {
    const status = await getLibraryRoot()
    if (status.status !== 'ready' || !status.root) return null
    targetId = status.root.id
  }

  // 2. Fetch item
  const item = getItemById(targetId)
  if (!item) return null

  // 3. Resolve settings
  const settings = await readSettings()
  const stored: Partial<StoredViewSettings> = (item as MediaFolder).viewSettings ?? {}
  const resolution = resolveViewSettings(
    item as MediaFolder,
    settings,
    new Set(),
    inheritedSettings
  )

  const node: ViewHierarchyNode = {
    id: targetId,
    stored: stored as StoredViewSettings,
    effective: resolution.settings,
    children: undefined
  }

  // 4. Recurse into container layouts
  if (recursive && ['tabs', 'sections'].includes(resolution.settings.layout)) {
    node.children = {}

    // When grouping is active, include real folders (e.g. Extras) alongside
    // virtual ones so they appear in the hierarchy and get inherited settings.
    // The .filter(folder) below ensures only folders are recursed into.
    const hierarchyFilter = item.viewSettings?.appliedGrouping
      ? `(i.virtual_type IN ('grouping', 'season', 'user') OR i.is_virtual = 0)`
      : childrenFilter(item)
    const childFolders = find({
      where: { parentId: targetId },
      rawConditions: [hierarchyFilter],
      fields: ['id', 'type', 'viewSettings']
    }).filter((c) => c.type === 'folder')

    for (const child of childFolders) {
      const childNode = await resolveViewHierarchy(
        child.id,
        true,
        depth + 1,
        resolution.settings.childViewSettings
      )
      if (childNode) {
        node.children[child.id] = childNode
      }
    }
  }

  return node
}
