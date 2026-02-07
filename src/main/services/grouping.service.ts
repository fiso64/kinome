import {
  LibraryItem,
  MediaFolder,
  ViewHierarchyNode,
  StoredViewSettings,
  VIEW_SETTINGS_KEYS
} from '@shared/types'
import {
  find,
  getItemById,
  getRoot,
  getValuesForKey,
  FindOptions,
  getChildren
} from './repository.service'
import { isVirtualId, parseVirtualId, buildVirtualItem, getFiltersFromId } from './virtual-item.factory'
import { resolveViewSettings } from '@shared/settings-helpers'
import { readSettings } from './settings.service'
import { getLibraryRoot } from './library.service'

const log = (msg: string) => console.log(`[GroupingService] ${msg}`)

/**
 * Robust entry point for fetching folder children.
 * Handles:
 * 1. ID normalization (root -> UUID)
 * 2. Virtual item resolution (filters from ID)
 * 3. Layout-driven automatic grouping (auto/undefined)
 * 4. Contextual default sorting (Seasons vs TV Shows vs Folders)
 */
export async function getGroupedChildren(
  id: string,
  options: FindOptions,
  rawGroupBy?: string
): Promise<LibraryItem[] | { error: string; message: string;[key: string]: any }> {
  let targetId = id

  // 1. Resolve root alias
  if (id === 'root') {
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

  // 2. Default hidden items policy
  if (options.includeHidden === undefined) {
    options.includeHidden = false
  }

  // 3. Resolve Grouping Policy
  const settings = await readSettings()
  let finalGroupBy: string | null | undefined = undefined

  if (rawGroupBy === 'auto' || rawGroupBy === undefined) {
    const resolved = await resolveEffectiveSettings(targetId, settings)
    if (['tabs', 'sections'].includes(resolved.layout)) {
      finalGroupBy = resolved.groupBy
    }
  } else if (rawGroupBy !== 'none') {
    finalGroupBy = rawGroupBy as string
  }

  // 4. Resolve Where Clause (Virtual vs Physical)
  if (isVirtualId(targetId)) {
    const filterOptions = getFiltersFromId(targetId)
    options.where = { ...options.where, ...filterOptions }
  } else {
    options.where = { ...options.where, parentId: targetId }
  }

  // 5. Contextual Default Sorting
  if (!options.orderBy) {
    const parent = isVirtualId(targetId) ? null : getItemById(targetId)
    if (parent) {
      if (parent.mediaType === 'season') {
        options.orderBy = { field: 'episodeNumber', direction: 'ASC' }
      } else if (parent.mediaType === 'tv') {
        options.orderBy = { field: 'seasonNumber', direction: 'ASC' }
      } else {
        options.orderBy = { field: 'name', direction: 'ASC' }
      }
    }
  }

  // 6. Execute (Grouped vs Plain)
  if (finalGroupBy) {
    // Ensure we don't pass the raw groupBy filter key into the find options
    // as it's handled by categorized grouping logic
    if (options.where && 'groupBy' in options.where) {
      delete (options.where as any).groupBy
    }
    return getGroups(targetId, finalGroupBy, options)
  }

  return find(options)
}

export function getVirtualItem(id: string): LibraryItem | null {
  const { parentId } = parseVirtualId(id)
  if (!parentId) return null

  const parent = getItemById(parentId) as MediaFolder
  if (!parent) return null

  return buildVirtualItem(id, parent)
}

/**
 * Recursively resolves the complete view hierarchy for a given item,
 * including settings and layout structure for its logical descendants.
 * This is the new side-channel for the Frontend to know layout structure in advance.
 */
/**
 * Shared helper to derive logical folder metadata (ID, settings, full token path).
 * Used by BOTH the hierarchy side-channel and the actual grouping logic.
 */
function getLogicalFolderInfo(
  currentParentId: string,
  token: string,
  parentTokenPath: string,
  physicalParent: MediaFolder | null
) {
  const fullTokenPath = parentTokenPath ? `${parentTokenPath}/${token}` : token

  const virtualSettings =
    physicalParent && physicalParent.viewSettings?.virtualFolderSettings
      ? (physicalParent.viewSettings.virtualFolderSettings[fullTokenPath] ?? {})
      : {}

  let id = ''
  if (isVirtualId(currentParentId)) {
    id = `${currentParentId}--${token}`
  } else {
    const pid = physicalParent?.id || currentParentId
    id = `virtual--${pid}--${token}`
  }

  return { id, fullTokenPath, virtualSettings }
}

/**
 * Consistently resolves the effective view settings for any item ID,
 * correctly handling the inheritance chain by recursively resolving parent settings.
 */
export async function resolveEffectiveSettings(
  itemId: string,
  settings: any, // Typed as any to avoid circular import with Settings service
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
    if (status.status !== 'ready' || !status.root) return resolveViewSettings(null, settings).settings
    targetId = status.root.id
  }

  const item = isVirtualId(targetId) ? getVirtualItem(targetId) : getItemById(targetId)
  if (!item) return resolveViewSettings(null, settings).settings

  // Base Case: Root physical items have no inheritance.
  if (!isVirtualId(targetId) && (!item.parentId || item.parentId === 'root')) {
    return resolveViewSettings(item as any, settings).settings
  }

  // No inheritance auto-discovery for anchor items.
  // Physical and Virtual folders act as fresh start points for inheritance
  // when they are the subject of a request.
  const inherited: any = undefined
  return resolveViewSettings(item as any, settings, new Set(), inherited).settings
}

export async function resolveViewHierarchy(
  itemId: string,
  recursive = true,
  depth = 0,
  inheritedSettings?: StoredViewSettings
): Promise<ViewHierarchyNode | null> {
  // Guard against excessive recursion
  if (depth > 10) return null // Side-channel is for look-ahead, not full library crawl

  // 1. Resolve Target ID (Root Alias)
  let targetId = itemId
  if (itemId === 'root') {
    const status = await getLibraryRoot()
    if (status.status !== 'ready' || !status.root) return null
    targetId = status.root.id
  }

  // 2. Fetch or construct Item
  const item = isVirtualId(targetId)
    ? getVirtualItem(targetId)
    : getItemById(targetId)
  if (!item) return null

  // 3. Resolve Settings
  const settings = await readSettings()

  // 1. Get Stored Settings for THIS specific item (no inheritance).
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

  // 4. Recurse if needed (Container Layouts)
  if (recursive && ['tabs', 'sections'].includes(resolution.settings.layout)) {
    node.children = {}

    // For containers, we identify the *logical* children without fetching all the files (too heavy).
    // This is the "Look-Ahead" feature.
    const childrenResult = await getGroupsOnly(targetId, inheritedSettings)

    for (const childInfo of childrenResult) {
      const childNode = await resolveViewHierarchy(
        childInfo.id,
        true,
        depth + 1,
        resolution.settings.childViewSettings
      )
      if (childNode) {
        node.children[childInfo.id] = childNode
      }
    }
  }

  return node
}

/**
 * Lean version of grouping that only returns logical folder information.
 * Used by the side-channel to build the hierarchy without fetching files.
 */
async function getGroupsOnly(
  parentId: string,
  inheritedSettings?: StoredViewSettings
): Promise<{ id: string }[]> {
  const settings = await readSettings()
  const item = isVirtualId(parentId) ? getVirtualItem(parentId) : getItemById(parentId)
  if (!item || item.type !== 'folder') return []

  // Resolve base grouping instruction
  const { settings: resolved } = resolveViewSettings(
    item as MediaFolder,
    settings,
    new Set(),
    inheritedSettings
  )
  if (!['tabs', 'sections'].includes(resolved.layout) || !resolved.groupBy) return []

  const groupByKey = resolved.groupBy

  let physicalParent: MediaFolder | null = null
  let parentTokenPath = ''
  let currentParentId = parentId

  if (isVirtualId(parentId)) {
    const { parentId: pid, tokens } = parseVirtualId(parentId)
    physicalParent = getItemById(pid || '') as MediaFolder
    parentTokenPath = tokens ? tokens.join('/') : ''
  } else {
    physicalParent = item as MediaFolder
  }

  // Special cases for physical structures
  if (groupByKey === 'folder') {
    const items = find({
      where: isVirtualId(parentId) ? getFiltersFromId(parentId) : { parentId },
      fields: ['id', 'type', 'seasonNumber']
    }).filter((c) => !c.isHidden && !c.isMissing)
    const physicalFolders = items.filter((c: LibraryItem) => c.type === 'folder').map((c: LibraryItem) => ({ id: c.id }))
    const looseFiles = items.filter((c: LibraryItem) => c.type === 'file')

    const result: { id: string }[] = [...physicalFolders]

    if (looseFiles.length > 0) {
      const uniqueSeasons = new Set<number>()
      let hasUnseasoned = false

      for (const file of looseFiles) {
        const seasonNum = (file as any).seasonNumber
        if (seasonNum !== undefined && seasonNum !== null) {
          uniqueSeasons.add(seasonNum)
        } else {
          hasUnseasoned = true
        }
      }

      for (const seasonNum of Array.from(uniqueSeasons).sort()) {
        const token = `folder:__season_${seasonNum}__`
        const { id } = getLogicalFolderInfo(currentParentId, token, parentTokenPath, physicalParent)
        result.push({ id })
      }

      if (hasUnseasoned) {
        const token = `folder:__files__`
        const { id } = getLogicalFolderInfo(currentParentId, token, parentTokenPath, physicalParent)
        result.push({ id })
      }
    }

    return result
  }

  // Metadata grouping - we need to fetch only the grouping field for all items in this folder
  const groupFields: string[] = []
  if (groupByKey === 'genre' || groupByKey === 'genres') {
    groupFields.push('genres')
  } else if (groupByKey.startsWith('vt.') || groupByKey === 'virtualTags') {
    groupFields.push('virtualTags')
  } else if (groupByKey.startsWith('tags.') || groupByKey === 'tags') {
    groupFields.push('tags')
  } else {
    groupFields.push(groupByKey)
  }

  const items = find({
    where: isVirtualId(parentId) ? getFiltersFromId(parentId) : { parentId },
    fields: ['id', 'type', 'mediaType', 'seasonNumber', ...groupFields]
  }).filter((c) => !c.isHidden && !c.isMissing)

  const result: { id: string }[] = []

  // Handle season grouping specifically for loose files
  if (groupByKey === 'seasonNumber') {
    const filesBySeason = new Map<number, LibraryItem[]>()
    for (const file of items) {
      const seasonNum = 'seasonNumber' in file ? (file as any).seasonNumber : undefined
      if (seasonNum !== undefined && seasonNum !== null) {
        if (!filesBySeason.has(seasonNum)) {
          filesBySeason.set(seasonNum, [])
        }
        filesBySeason.get(seasonNum)!.push(file)
      }
    }

    const sortedSeasonNumbers = Array.from(filesBySeason.keys()).sort((a, b) => a - b)
    for (const seasonNum of sortedSeasonNumbers) {
      const token = `${groupByKey}:${seasonNum}`
      const { id } = getLogicalFolderInfo(currentParentId, token, parentTokenPath, physicalParent)
      result.push({ id })
    }
  } else {
    // Aggregate unique group values for other metadata groupings
    const uniqueValues = new Set<string>()
    for (const item of items) {
      const vals = getValuesForKey(item, groupByKey)
      if (vals.length === 0) uniqueValues.add('Uncategorized')
      else vals.forEach((v) => uniqueValues.add(v))
    }

    // Generate logical info for each unique value
    for (const value of Array.from(uniqueValues).sort()) {
      const token = `${groupByKey}:${value}`
      const { id } = getLogicalFolderInfo(currentParentId, token, parentTokenPath, physicalParent)
      result.push({ id })
    }
  }

  return result
}

/**
 * High-level API used by repositoryService.createForDetailViewCopy
 * to apply virtualization (grouping) to an item's children.
 */
export async function groupItemsForDetailView(
  parent: MediaFolder,
  options: { fields?: string[] } = {}
): Promise<LibraryItem[]> {
  const settings = await readSettings()
  const { settings: resolved } = resolveViewSettings(parent, settings)

  const rawChildren = find({
    where: { parentId: parent.id },
    fields: options.fields
  }).filter((c: LibraryItem) => !c.isHidden && !c.isMissing)

  // Apply grouping only if the layout demands it (e.g. Tabs or Sections).
  // This removes the hardcoded TV-show virtualization in favor of the resolved layout.
  if (['tabs', 'sections'].includes(resolved.layout)) {
    log(`Applying automatic virtualization for "${parent.name}" (Layout: ${resolved.layout})`)
    return await groupItemsRecursive(
      rawChildren,
      resolved.groupBy || 'folder',
      parent.id,
      parent,
      '',
      parent.viewSettings?.childViewSettings || {},
      options.fields
    )
  }

  return rawChildren
}

export async function getGroups(
  parentId: string,
  groupByKey: string,
  options: FindOptions
): Promise<LibraryItem[]> {
  const fieldsToSelect = options.fields && options.fields.length > 0 ? options.fields : undefined

  const items = find({
    ...options,
    fields: fieldsToSelect
  })

  let physicalParentId = parentId
  let parentTokenPath = ''
  let parentIsVirtual = false

  if (isVirtualId(parentId)) {
    const { parentId: pid, tokens } = parseVirtualId(parentId)
    physicalParentId = pid || ''
    parentTokenPath = tokens ? tokens.join('/') : ''
    parentIsVirtual = true
  } else if (parentId === 'root') {
    const root = getRoot()
    if (root) physicalParentId = root.id
  }

  const physicalParent = getItemById(physicalParentId) as MediaFolder

  // NEW: Resolve the parent's effective settings to correctly identify inheritance context.
  const settings = await readSettings()
  const parentEffective = await resolveEffectiveSettings(parentId, settings)
  const inheritedSettings = parentEffective.childViewSettings

  return await groupItemsRecursive(
    items,
    groupByKey,
    parentId,
    physicalParent,
    parentTokenPath,
    inheritedSettings,
    fieldsToSelect
  )
}

function categorizeItems(items: LibraryItem[]) {
  const physicalFolders: MediaFolder[] = []
  const files: LibraryItem[] = []

  for (const item of items) {
    if (item.type === 'folder') {
      physicalFolders.push(item as MediaFolder)
    } else {
      files.push(item)
    }
  }
  return { physicalFolders, files }
}

async function groupItemsRecursive(
  items: LibraryItem[],
  groupByKey: string,
  currentParentId: string,
  physicalParent: MediaFolder | null,
  parentTokenPath: string,
  inheritedSettings: any,
  fields?: string[]
): Promise<LibraryItem[]> {
  const globalSettings = await readSettings()

  // We use effectiveSettings for internal logic (like determining if we should keep grouping recursively),
  // but we do NOT bake them into the item objects themselves.
  // (Note: inheritedSettings are applied during resolution below)

  // --- Special Handling for "Folder" Grouping ---
  if (groupByKey === 'folder') {
    const { physicalFolders, files: looseFiles } = categorizeItems(items)
    const virtualFolders: LibraryItem[] = []

    // 1. Unwrap Physical Folders & Recurse if needed
    for (const folder of physicalFolders) {
      let children = getChildren(folder.id, fields).filter((c) => !c.isHidden && !c.isMissing)

      // Resolve settings for this folder to see if it acts as a grouping container (Tabs/Sections)
      // We pass inheritedSettings to ensure virtual parent overrides apply.
      const { settings: resolved } = resolveViewSettings(
        folder as any,
        globalSettings,
        new Set(),
        inheritedSettings
      )

      if (['tabs', 'sections'].includes(resolved.layout) && resolved.groupBy) {
        // If this folder is a container (e.g. TV Show -> Tabs), we must populate its structure recursively.
        // We reset parentTokenPath to '' because 'folder' is a physical anchor.
        // We pass down its resolved childViewSettings.
        const nextInheritedSettings = folder.viewSettings?.childViewSettings || resolved.childViewSettings || {}

        children = await groupItemsRecursive(
          children,
          resolved.groupBy,
          folder.id,
          folder, // It becomes the physical parent
          '',
          nextInheritedSettings,
          fields
        )
      }

      folder.children = children
    }

    if (looseFiles.length > 0) {
      const filesBySeason = new Map<number, LibraryItem[]>()
      const unseasonedFiles: LibraryItem[] = []

      for (const file of looseFiles) {
        const seasonNum = 'seasonNumber' in file ? (file as any).seasonNumber : undefined
        if (seasonNum !== undefined && seasonNum !== null) {
          if (!filesBySeason.has(seasonNum)) {
            filesBySeason.set(seasonNum, [])
          }
          filesBySeason.get(seasonNum)!.push(file)
        } else {
          unseasonedFiles.push(file)
        }
      }

      const sortedSeasonNumbers = Array.from(filesBySeason.keys()).sort((a, b) => a - b)
      for (const seasonNum of sortedSeasonNumbers) {
        const groupValue = `__season_${seasonNum}__`
        const token = `${groupByKey}:${groupValue}`
        const fullSettingsKey = parentTokenPath ? `${parentTokenPath}/${token}` : token

        const virtualSettings =
          physicalParent && physicalParent.viewSettings?.virtualFolderSettings
            ? (physicalParent.viewSettings.virtualFolderSettings[fullSettingsKey] ?? {})
            : {}

        let newId = ''
        const existingParentId = isVirtualId(currentParentId)
          ? currentParentId
          : physicalParent?.id || currentParentId
        if (isVirtualId(currentParentId)) {
          newId = `${currentParentId}--${token}`
        } else {
          newId = `virtual--${existingParentId}--${token}`
        }

        const seasonFolder: MediaFolder = {
          id: newId,
          parentId: currentParentId,
          name: `Season ${seasonNum}`,
          title: virtualSettings.title ?? `Season ${seasonNum}`,
          type: 'folder',
          mediaType: 'season',
          isMissing: false,
          isHidden: false,
          path: `virtual/${fullSettingsKey}`,
          isVirtual: true,
          children: filesBySeason.get(seasonNum)!,
          seasonNumber: seasonNum,
          ...virtualSettings,
          viewSettings: {
            ...virtualSettings,
            virtualFolderSettings: physicalParent?.viewSettings?.virtualFolderSettings
          },
          groupByKey: 'folder',
          groupByValue: groupValue
        }
        virtualFolders.push(seasonFolder)
      }

      if (unseasonedFiles.length > 0) {
        const groupValue = '__files__'
        const token = `${groupByKey}:${groupValue}`
        const { id: newId, fullTokenPath, virtualSettings } = getLogicalFolderInfo(
          currentParentId,
          token,
          parentTokenPath,
          physicalParent
        )

        const filesFolder: MediaFolder = {
          id: newId,
          parentId: currentParentId,
          name: 'Files',
          title: (virtualSettings as any).title ?? 'Files',
          type: 'folder',
          mediaType: (unseasonedFiles[0]?.mediaType === 'episode' ? 'season' : null) as any,
          isMissing: false,
          isHidden: false,
          path: `virtual/${fullTokenPath}`,
          isVirtual: true,
          children: unseasonedFiles,
          ...virtualSettings,
          viewSettings: {
            ...virtualSettings,
            virtualFolderSettings: physicalParent?.viewSettings?.virtualFolderSettings
          },
          groupByKey: 'folder',
          groupByValue: groupValue
        } as any
        virtualFolders.push(filesFolder)
      }
    }

    return [...virtualFolders, ...physicalFolders].sort((a, b) => {
      const aSeason = (a as any).seasonNumber
      const bSeason = (b as any).seasonNumber
      if (aSeason != null && bSeason != null) return aSeason - bSeason
      return a.name.localeCompare(b.name, undefined, { numeric: true })
    })
  }

  // --- Standard Metadata Grouping ---
  const groups: Record<string, LibraryItem[]> = {}

  for (const item of items) {
    const values = getValuesForKey(item, groupByKey)
    if (values.length === 0) {
      if (!groups['Uncategorized']) groups['Uncategorized'] = []
      groups['Uncategorized'].push(item)
    } else {
      for (const value of values) {
        if (!groups[value]) groups[value] = []
        groups[value].push(item)
      }
    }
  }

  const virtualFolders: LibraryItem[] = await Promise.all(
    Object.entries(groups).map(async ([groupValue, groupItems]) => {
      const token = `${groupByKey}:${groupValue}`
      const { id: newId, fullTokenPath, virtualSettings } = getLogicalFolderInfo(
        currentParentId,
        token,
        parentTokenPath,
        physicalParent
      )

      const virtualFolder: MediaFolder = {
        id: newId,
        parentId: currentParentId,
        name: groupValue,
        title: (virtualSettings as any).title ?? groupValue,
        type: 'folder',
        mediaType: physicalParent?.mediaType === 'tv' ? null : physicalParent?.mediaType,
        isMissing: false,
        isHidden: false,
        path: `virtual/${fullTokenPath}`,
        isVirtual: true,
        children: [],
        ...virtualSettings,
        viewSettings: {
          ...virtualSettings,
          virtualFolderSettings: physicalParent?.viewSettings?.virtualFolderSettings
        }
      }

      // Use the hint from the parent (inheritedSettings) to decide how to process THIS folder's children.
      const effectiveResolution = resolveViewSettings(
        virtualFolder,
        globalSettings,
        new Set(),
        inheritedSettings
      ).settings

      if (
        ['tabs', 'sections'].includes(effectiveResolution.layout) &&
        effectiveResolution.groupBy
      ) {
        // If this level is ALSO grouping, we pass its childViewSettings down.
        const nextSettings =
          virtualFolder.viewSettings?.childViewSettings || effectiveResolution.childViewSettings || {}

        virtualFolder.children = await groupItemsRecursive(
          groupItems,
          effectiveResolution.groupBy,
          newId,
          physicalParent,
          fullTokenPath,
          nextSettings,
          fields // Pass fields
        )
      } else {
        virtualFolder.children = groupItems
      }

      return virtualFolder
    })
  )

  return virtualFolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}
