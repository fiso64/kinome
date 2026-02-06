import { LibraryItem, MediaFolder } from '@shared/types'
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
  let finalGroupBy: string | undefined = undefined

  if (rawGroupBy === 'auto' || rawGroupBy === undefined) {
    const item = isVirtualId(targetId)
      ? getVirtualItem(targetId)
      : getItemById(targetId)

    const resolved = resolveViewSettings(item as any, settings).settings
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
      parent.childViewSettings || {},
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

  let inheritedSettings = {}
  if (parentIsVirtual) {
    const virtualParent = getVirtualItem(parentId)
    if (virtualParent && (virtualParent as any).childViewSettings) {
      inheritedSettings = (virtualParent as any).childViewSettings
    }
  } else {
    if (physicalParent && physicalParent.childViewSettings) {
      inheritedSettings = physicalParent.childViewSettings
    }
  }

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
      // We merge inheritedSettings to ensure virtual parent overrides apply.
      const effectiveItem = { ...inheritedSettings, ...folder }
      const { settings: resolved } = resolveViewSettings(effectiveItem, globalSettings)

      if (['tabs', 'sections'].includes(resolved.layout) && resolved.groupBy) {
        // If this folder is a container (e.g. TV Show -> Tabs), we must populate its structure recursively.
        // We reset parentTokenPath to '' because 'folder' is a physical anchor.
        // We pass down its resolved childViewSettings.
        const nextInheritedSettings = folder.childViewSettings || resolved.childViewSettings || {}

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
          physicalParent && physicalParent.virtualFolderSettings
            ? (physicalParent.virtualFolderSettings[fullSettingsKey] ?? {})
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
          virtualFolderSettings: physicalParent?.virtualFolderSettings,
          seasonNumber: seasonNum,
          ...virtualSettings,
          groupByKey: 'folder',
          groupByValue: groupValue
        }
        virtualFolders.push(seasonFolder)
      }

      if (unseasonedFiles.length > 0) {
        const groupValue = '__files__'
        const token = `${groupByKey}:${groupValue}`
        const fullSettingsKey = parentTokenPath ? `${parentTokenPath}/${token}` : token
        const virtualSettings =
          physicalParent && physicalParent.virtualFolderSettings
            ? (physicalParent.virtualFolderSettings[fullSettingsKey] ?? {})
            : {}

        const existingParentId = isVirtualId(currentParentId)
          ? currentParentId
          : physicalParent?.id || currentParentId
        let newId = ''
        if (isVirtualId(currentParentId)) {
          newId = `${currentParentId}--${token}`
        } else {
          newId = `virtual--${existingParentId}--${token}`
        }

        const filesFolder: MediaFolder = {
          id: newId,
          parentId: currentParentId,
          name: 'Files',
          title: virtualSettings.title ?? 'Files',
          type: 'folder',
          mediaType: 'folder' as any,
          isMissing: false,
          isHidden: false,
          path: `virtual/${fullSettingsKey}`,
          isVirtual: true,
          children: unseasonedFiles,
          virtualFolderSettings: physicalParent?.virtualFolderSettings,
          ...virtualSettings,
          groupByKey: 'folder',
          groupByValue: groupValue
        }
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
      const fullSettingsKey = parentTokenPath ? `${parentTokenPath}/${token}` : token

      const virtualSettings =
        physicalParent && physicalParent.virtualFolderSettings
          ? (physicalParent.virtualFolderSettings[fullSettingsKey] ?? {})
          : {}

      let newId = ''
      if (isVirtualId(currentParentId)) {
        newId = `${currentParentId}--${token}`
      } else {
        const pid = physicalParent?.id || currentParentId
        newId = `virtual--${pid}--${token}`
      }

      const virtualFolder: MediaFolder = {
        id: newId,
        parentId: currentParentId,
        name: groupValue,
        title: virtualSettings.title ?? groupValue,
        type: 'folder',
        mediaType: physicalParent?.mediaType,
        isMissing: false,
        isHidden: false,
        path: `virtual/${fullSettingsKey}`,
        isVirtual: true,
        children: [],
        virtualFolderSettings: physicalParent?.virtualFolderSettings,
        ...virtualSettings
      }

      // Use the hint from the parent (inheritedSettings) to decide how to process THIS folder's children,
      // but keep the virtualFolder object clean of those hints for its own identity.
      const effectiveResolution = resolveViewSettings(
        { ...inheritedSettings, ...virtualSettings, ...virtualFolder } as any,
        globalSettings
      ).settings

      if (
        ['tabs', 'sections'].includes(effectiveResolution.layout) &&
        effectiveResolution.groupBy
      ) {
        // If this level is ALSO grouping, we pass its childViewSettings down.
        const nextSettings =
          (virtualFolder as any).childViewSettings || effectiveResolution.childViewSettings || {}

        virtualFolder.children = await groupItemsRecursive(
          groupItems,
          effectiveResolution.groupBy,
          newId,
          physicalParent,
          fullSettingsKey,
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
