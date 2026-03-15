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

const log = (msg: string) => console.log(`[GroupingService] ${msg}`)

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

  // 2. Default hidden/ignored policy
  if (options.includeHidden === undefined) options.includeHidden = false
  if (options.includeIgnored === undefined) options.includeIgnored = false

  // 3. Fetch item
  const item = getItemById(targetId)
  if (!item) return { error: 'not_found', message: `Item ${targetId} not found` }

  // 4. Contextual default sorting
  if (!options.orderBy) {
    if (item.mediaType === 'season') {
      options.orderBy = { field: 'episodeNumber', direction: 'ASC' }
    } else if (item.mediaType === 'tv') {
      options.orderBy = { field: 'seasonNumber', direction: 'ASC' }
    } else {
      options.orderBy = { field: 'name', direction: 'ASC' }
    }
  }

  // 5. Resolve children
  let items: LibraryItem[]

  if (item.isVirtual) {
    // Branch A: virtual folder — compile filter and run find()
    const filter = (item as MediaFolder).filter
    if (!filter) {
      items = []
    } else {
      const compiled = compileFilter(filter)
      items = find({
        ...compiled,
        fields: options.fields,
        orderBy: options.orderBy,
        limit: options.limit,
        offset: options.offset,
        includeHidden: options.includeHidden,
        includeIgnored: options.includeIgnored
      })
    }
  } else if (item.viewSettings?.appliedGrouping) {
    // Branch B: grouping active — show grouping virtual folders + user virtual folders
    items = find({
      where: { parentId: targetId },
      rawConditions: [`(i.virtual_type = 'grouping' OR i.virtual_type = 'user')`],
      fields: options.fields,
      orderBy: options.orderBy,
      limit: options.limit,
      offset: options.offset,
      includeHidden: options.includeHidden,
      includeIgnored: options.includeIgnored
    })
  } else {
    // Branch C: no grouping — show real items + user virtual folders
    items = find({
      where: { parentId: targetId },
      rawConditions: [`(i.is_virtual = 0 OR i.virtual_type = 'user')`],
      fields: options.fields,
      orderBy: options.orderBy,
      limit: options.limit,
      offset: options.offset,
      includeHidden: options.includeHidden,
      includeIgnored: options.includeIgnored
    })
  }

  // 6. Eagerly embed children for container-layout folders
  return embedChildrenForContainers(items, options)
}

/**
 * For any folder item using a tabs or sections layout, recursively fetches
 * and embeds its children. Prevents N+1 requests from the frontend.
 */
async function embedChildrenForContainers(
  items: LibraryItem[],
  options: FindOptions
): Promise<LibraryItem[]> {
  const settings = await readSettings()

  for (const item of items) {
    if (item.type !== 'folder') continue
    const effectiveSettings = await resolveEffectiveSettings(item.id, settings)
    if (['tabs', 'sections'].includes(effectiveSettings.layout)) {
      const result = await getChildren(item.id, { fields: options.fields })
      if (Array.isArray(result)) {
        ;(item as MediaFolder).children = result
      }
    }
  }

  return items
}

/**
 * Consistently resolves the effective view settings for any item ID,
 * correctly handling the inheritance chain.
 */
export async function resolveEffectiveSettings(
  itemId: string,
  settings: any,
  visited: Set<string> = new Set()
): Promise<any> {
  if (visited.has(itemId)) {
    log(`Circular dependency detected for ${itemId}, breaking recursion.`)
    return resolveViewSettings(null, settings).settings
  }
  visited.add(itemId)

  let targetId = itemId
  if (itemId === 'root') {
    const status = await getLibraryRoot()
    if (status.status !== 'ready' || !status.root)
      return resolveViewSettings(null, settings).settings
    targetId = status.root.id
  }

  const item = getItemById(targetId)
  if (!item) return resolveViewSettings(null, settings).settings

  // Base case: root real items have no inheritance
  if (!item.isVirtual && (!item.parentId || item.parentId === 'root')) {
    return resolveViewSettings(item as any, settings).settings
  }

  const inherited: any = undefined
  return resolveViewSettings(item as any, settings, new Set(), inherited).settings
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

    // Get the folder-type children using the same branch logic as getChildren
    let childFolders: LibraryItem[]
    if (item.viewSettings?.appliedGrouping) {
      childFolders = find({
        where: { parentId: targetId },
        rawConditions: [`(i.virtual_type = 'grouping' OR i.virtual_type = 'user')`],
        fields: ['id', 'type', 'viewSettings']
      }).filter((c) => c.type === 'folder')
    } else {
      childFolders = find({
        where: { parentId: targetId },
        rawConditions: [`(i.is_virtual = 0 OR i.virtual_type = 'user')`],
        fields: ['id', 'type', 'viewSettings']
      }).filter((c) => c.type === 'folder')
    }

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
