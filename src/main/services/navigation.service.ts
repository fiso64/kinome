import {
  LibraryItem,
  MediaFolder,
  ViewHierarchyNode,
  StoredViewSettings,
  CascadableViewSettings,
  CONTAINER_LAYOUTS,
  type SortBy,
} from '@shared/types'
import {
  find,
  getItemById,
  getHomeFolderId,
  FindOptions,
  findParent,
  createTransferableCopy,
  getRoot
} from './repository.service'
import { getGroupedChildren, childrenFilter } from './grouping.service'
import { getVirtualChildren } from './virtualFolders.service'
import { buildSortPinPrefix, type OrderByClause } from '../database/query-builder'
import { resolveViewSettings } from '@shared/settings-helpers'
import { readSettings, checkLibraryExists } from './settings.service'
import { setLibraryDataPath, getLibraryDataPath, isRemoteLibrary } from './paths.service'
import { closeDatabase } from '../database/client'

/**
 * Builds the ORDER BY clauses for a folder's children based on the resolved sort settings.
 *
 * - hybrid: season-aware sort (typeRank + season/episode number or displayName)
 * - alpha: pure alphabetic by display name
 * - date-added: by when the item was added to the library
 * - year: by metadata release year (nulls last), then alphabetic tiebreaker
 *
 * `sortDescending` reverses the primary sort key. typeRank (for hybrid) and tiebreakers
 * always stay ascending so item-type grouping and stability are preserved.
 */
export function buildSortOrder(
  mediaType: string | undefined,
  sortBy: SortBy = 'hybrid',
  sortDescending: boolean = false
): OrderByClause[] {
  const dir: 'ASC' | 'DESC' = sortDescending ? 'DESC' : 'ASC'

  switch (sortBy) {
    case 'alpha':
      return [{ field: 'displayName', direction: dir }]

    case 'date-added':
      return [{ field: 'addedAt', direction: dir }]

    case 'year':
      return [
        { field: 'year', direction: dir, nullsLast: true },
        { field: 'displayName', direction: 'ASC' },
      ]

    case 'hybrid':
    default:
      if (mediaType === 'season') {
        return [
          { field: 'typeRank', direction: 'ASC' },
          { field: 'episodeNumber', direction: dir },
        ]
      } else if (mediaType === 'tv') {
        return [
          { field: 'typeRank', direction: 'ASC' },
          { field: 'seasonNumber', direction: dir },
          { field: 'displayName', direction: dir },
        ]
      } else {
        return [
          { field: 'typeRank', direction: 'ASC' },
          { field: 'displayName', direction: dir },
        ]
      }
  }
}

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Navigation Service] ${message}`)
}

/**
 * When a parent uses a tabs or sections layout, its child folders need their
 * children pre-fetched so the frontend can render tab content without N+1.
 * Recurses if a child is itself a container layout.
 */
async function embedChildrenForContainers(
  items: LibraryItem[],
  options: FindOptions,
  inheritedSettings?: CascadableViewSettings
): Promise<void> {
  for (const item of items) {
    if (item.type !== 'folder') continue
    const result = await getChildren(item.id, { fields: options.fields }, inheritedSettings)
    if (Array.isArray(result)) {
      ; (item as MediaFolder).children = result
    }
  }
}

/**
 * Coordinator for fetching folder children. Routes to specialized services (grouping, virtual)
 * or performs a standard filesystem list.
 */
export async function getChildren(
  id: string,
  options: FindOptions = {},
  inheritedSettings?: CascadableViewSettings
): Promise<LibraryItem[] | { error: string; message: string;[key: string]: any }> {
  let targetId = id

  // 1. Resolve aliases
  const homeId = getHomeFolderId()
  if (id === 'home' || id === homeId) {
    targetId = homeId
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

  // 2. Fetch item
  const item = getItemById(targetId)
  if (!item || item.type !== 'folder') return { error: 'not_found', message: 'Item not found' }

  // 3. Apply defaults (without mutating the caller's object)
  const opts = { ...options }
  if (opts.includeHidden === undefined) opts.includeHidden = false
  if (opts.includeIgnored === undefined) opts.includeIgnored = false

  // 4. Resolve effective settings (used for sort order + eager embedding below)
  const globalSettings = await readSettings()
  const { settings: resolvedSettings } = resolveViewSettings(
    item as MediaFolder,
    globalSettings,
    new Set(),
    inheritedSettings
  )

  // 5. Build sort order from item's own view settings (FolderOrganizationSettings — never cascades)
  if (!opts.orderBy) {
    opts.orderBy = buildSortOrder(
      item.mediaType ?? undefined,
      item.viewSettings?.sortBy,
      item.viewSettings?.sortDescending
    )
  }

  // 6. Build sort-pinning prefix from viewSettings (sortTop / sortBottom)
  const { sortTop, sortBottom } = item.viewSettings ?? {}
  opts.compiledOrderPrefix = buildSortPinPrefix(sortTop, sortBottom)

  // 7. Route to specialized services
  let results: LibraryItem[]
  if (item.viewSettings?.appliedGrouping) {
    results = await getGroupedChildren(item, opts)
  } else if (item.isVirtual && (item as MediaFolder).filter) {
    results = await getVirtualChildren(item as MediaFolder, opts)
  } else {
    // Branch C: Simple real folder navigation
    results = find({
      where: { parentId: targetId },
      rawConditions: [childrenFilter(item)],
      fields: opts.fields,
      orderBy: opts.orderBy,
      compiledOrderPrefix: opts.compiledOrderPrefix,
      limit: opts.limit,
      offset: opts.offset,
      includeHidden: opts.includeHidden,
      includeIgnored: opts.includeIgnored
    })
  }

  // 8. Post-processing: Eager embedding (reuse already-resolved settings)
  if (CONTAINER_LAYOUTS.includes(resolvedSettings.layout as any)) {
    await embedChildrenForContainers(results, opts, resolvedSettings.childViewSettings)
  }

  return results
}

export async function getParent(id: string) {
  const parent = findParent(id)
  return parent ? createTransferableCopy(parent) : null
}

export async function getLibraryRoot(providedPath?: string) {
  const currentSettings = await readSettings()
  const pathToCheck = providedPath || currentSettings.libraryLocation

  if (!pathToCheck) {
    return { status: 'no_location' }
  }

  const discovery = await checkLibraryExists(pathToCheck)

  if (!discovery.settingsExists) {
    return { status: 'no_settings' }
  }

  if (!discovery.dbExists) {
    return { status: 'db_missing', settings: discovery.settings }
  }

  const root = getRoot()
  if (!root) {
    return { status: 'db_missing', settings: discovery.settings }
  }

  root.children = []
  const item = createTransferableCopy(root) as MediaFolder

  return {
    status: 'ready',
    root: item,
    settings: discovery.settings
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
  inheritedSettings?: CascadableViewSettings
): Promise<ViewHierarchyNode | null> {
  if (depth > 10) return null

  // 1. Resolve aliases
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
  if (recursive && CONTAINER_LAYOUTS.includes(resolution.settings.layout as any)) {
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
