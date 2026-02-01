import { LibraryItem, MediaFolder } from '../../shared/types'
import { find, getItemById, getRoot, getValuesForKey, FindOptions, getChildren } from './repository.service'
import { isVirtualId, parseVirtualId, buildVirtualItem } from './virtual-item.factory'
import { resolveViewSettings } from '../../shared/settings-helpers'
import { readSettings } from './settings.service'

const log = (msg: string) => console.log(`[GroupingService] ${msg}`)

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
export async function groupItemsForDetailView(parent: MediaFolder): Promise<LibraryItem[]> {
    const rawChildren = getChildren(parent.id).filter((c: LibraryItem) => !c.isHidden && !c.isMissing)

    // Currently, only TV shows get special automatic virtualization for the detail view.
    if (parent.mediaType === 'tv') {
        log(`Applying automatic TV virtualization for "${parent.name}"`)
        // We reuse the existing recursive engine by forcing a "folder" grouping.
        // This handles both virtual seasons and the "Files" tab.
        return await groupItemsRecursive(
            rawChildren,
            'folder',
            parent.id,
            parent,
            '',
            parent.childViewSettings || {}
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
        inheritedSettings
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
    inheritedSettings: any
): Promise<LibraryItem[]> {
    // --- Special Handling for "Folder" Grouping (Mixed Content / TV virtualization) ---
    if (groupByKey === 'folder') {
        const { physicalFolders, files: looseFiles } = categorizeItems(items)
        const virtualFolders: LibraryItem[] = []

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
                        ? physicalParent.virtualFolderSettings[fullSettingsKey] ?? {}
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
                    ...inheritedSettings,
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
                        ? physicalParent.virtualFolderSettings[fullSettingsKey] ?? {}
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
                    ...inheritedSettings,
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

    const settingsPromise = readSettings()

    const virtualFolders: LibraryItem[] = await Promise.all(
        Object.entries(groups).map(async ([groupValue, groupItems]) => {
            const token = `${groupByKey}:${groupValue}`
            const fullSettingsKey = parentTokenPath ? `${parentTokenPath}/${token}` : token

            const virtualSettings =
                physicalParent && physicalParent.virtualFolderSettings
                    ? physicalParent.virtualFolderSettings[fullSettingsKey] ?? {}
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
                ...inheritedSettings,
                ...virtualSettings
            }

            const settings = await settingsPromise
            const resolved = resolveViewSettings(virtualFolder as any, settings).settings

            if (['tabs', 'sections'].includes(resolved.layout) && resolved.groupBy) {
                const nextSettings = (virtualFolder as any).childViewSettings || {}

                virtualFolder.children = await groupItemsRecursive(
                    groupItems,
                    resolved.groupBy,
                    newId,
                    physicalParent,
                    fullSettingsKey,
                    nextSettings
                )
            } else {
                virtualFolder.children = groupItems
            }

            return virtualFolder
        })
    )

    return virtualFolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}
