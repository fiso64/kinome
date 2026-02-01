import { LibraryItem, MediaFolder } from '../../shared/types'
import { find, getItemById, getRoot, getValuesForKey, FindOptions } from './repository.service'
import { isVirtualId, parseVirtualId, buildVirtualItem } from './virtual-item.factory'

// const log = (msg: string) => console.log(`[ViewService] ${msg}`)

export function getVirtualItem(id: string): LibraryItem | null {
    const { parentId } = parseVirtualId(id)
    if (!parentId) return null

    // Resolve Parent
    // Parent could be Physical or Virtual (if we supported virtual-on-virtual lookup not via recursion)
    // But standard usage is usually resolving against a physical ancestor?
    // Actually, 'virtual--{parentId}--...' 
    // If parentId is physical, we fetch it.
    // If parentId is virtual, we'd need to resolve IT first.
    // For now, assuming parentId is physical (the root of the virtual chain).
    const parent = getItemById(parentId) as MediaFolder
    if (!parent) return null

    return buildVirtualItem(id, parent)
}

export function getGroups(parentId: string, groupByKey: string, options: FindOptions): LibraryItem[] {
    // 1. Fetch items
    const fieldsToSelect = options.fields && options.fields.length > 0 ? options.fields : undefined

    // log(`Grouping by ${groupByKey}. Fields to select: ${JSON.stringify(fieldsToSelect)}`)

    const items = find({
        ...options,
        fields: fieldsToSelect
    })

    // 2. Identify Parent (for ID and Settings)
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

    // Resolve Immediate Parent Settings (to inherit childViewSettings)
    let inheritedSettings = {}
    if (parentIsVirtual) {
        // If parent is virtual, reconstruct it to get its settings
        // We can use our own getVirtualItem if parentId is the ID
        const virtualParent = getVirtualItem(parentId)
        if (virtualParent && (virtualParent as any).childViewSettings) {
            inheritedSettings = (virtualParent as any).childViewSettings
        }
    } else {
        // Physical parent
        if (physicalParent && physicalParent.childViewSettings) {
            inheritedSettings = physicalParent.childViewSettings
        }
    }

    // 3. Delegate to Recursive Helper
    return groupItemsRecursive(items, groupByKey, parentId, physicalParent, parentTokenPath, inheritedSettings)
}

// Helper to categorize library items
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

function groupItemsRecursive(
    items: LibraryItem[],
    groupByKey: string,
    currentParentId: string,
    physicalParent: MediaFolder | null,
    parentTokenPath: string,
    inheritedSettings: any
): LibraryItem[] {

    // --- Special Handling for "Folder" Grouping (Mixed Content) ---
    if (groupByKey === 'folder') {
        const { physicalFolders, files: looseFiles } = categorizeItems(items)
        const virtualFolders: LibraryItem[] = []

        if (looseFiles.length > 0) {
            const filesBySeason = new Map<number, LibraryItem[]>()
            const unseasonedFiles: LibraryItem[] = []

            // 1. Categorize all loose files
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

            // 2. Create virtual folders for each season
            const sortedSeasonNumbers = Array.from(filesBySeason.keys()).sort((a, b) => a - b)
            for (const seasonNum of sortedSeasonNumbers) {
                const groupValue = `__season_${seasonNum}__`
                const token = `${groupByKey}:${groupValue}`
                const fullSettingsKey = parentTokenPath ? `${parentTokenPath}/${token}` : token

                const virtualSettings = physicalParent && physicalParent.virtualFolderSettings
                    ? physicalParent.virtualFolderSettings[fullSettingsKey] ?? {}
                    : {}

                // Use a consistent ID generation strategy
                let newId = ''
                const existingParentId = isVirtualId(currentParentId) ? currentParentId : (physicalParent?.id || currentParentId)
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
                    mediaType: 'season', // Context specific
                    isMissing: false,
                    isHidden: false,
                    isUserEdited: false,
                    path: `virtual/${fullSettingsKey}`,
                    isVirtual: true,
                    children: filesBySeason.get(seasonNum)!, // Pre-populate children
                    virtualFolderSettings: physicalParent?.virtualFolderSettings,
                    seasonNumber: seasonNum,
                    ...inheritedSettings,
                    ...virtualSettings,
                    // Ensure internal grouping properties are set for the frontend to use if needed (though we return flat list now)
                    groupByKey: 'folder',
                    groupByValue: groupValue
                }
                virtualFolders.push(seasonFolder)
            }

            // 3. Create a virtual folder for "Files" (Unseasoned)
            if (unseasonedFiles.length > 0) {
                const groupValue = '__files__'
                const token = `${groupByKey}:${groupValue}`
                const fullSettingsKey = parentTokenPath ? `${parentTokenPath}/${token}` : token
                const virtualSettings = physicalParent && physicalParent.virtualFolderSettings
                    ? physicalParent.virtualFolderSettings[fullSettingsKey] ?? {}
                    : {}

                const existingParentId = isVirtualId(currentParentId) ? currentParentId : (physicalParent?.id || currentParentId)
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
                    mediaType: physicalParent?.mediaType,
                    isMissing: false,
                    isHidden: false,
                    isUserEdited: false,
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

        // Return combined list: Virtual Folders + Physical Folders
        // Sort everything by name/season
        return [...virtualFolders, ...physicalFolders].sort((a, b) => {
            // Sort Seasons first
            const aSeason = (a as any).seasonNumber
            const bSeason = (b as any).seasonNumber
            if (aSeason != null && bSeason != null) return aSeason - bSeason

            return a.name.localeCompare(b.name, undefined, { numeric: true })
        })
    }

    // --- Standard Metadata Grouping (e.g. Genre, Year) ---
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

    const virtualFolders: LibraryItem[] = Object.entries(groups).map(([groupValue, groupItems]) => {
        const token = `${groupByKey}:${groupValue}`
        const fullSettingsKey = parentTokenPath ? `${parentTokenPath}/${token}` : token

        const virtualSettings = physicalParent && physicalParent.virtualFolderSettings
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
            isUserEdited: false,
            path: `virtual/${fullSettingsKey}`,
            isVirtual: true,
            children: [],
            virtualFolderSettings: physicalParent?.virtualFolderSettings,
            ...inheritedSettings,
            ...virtualSettings
        }

        if ((virtualFolder as any).groupBy) {
            const nextSettings = (virtualFolder as any).childViewSettings || {}

            virtualFolder.children = groupItemsRecursive(
                groupItems,
                (virtualFolder as any).groupBy,
                newId,
                physicalParent,
                fullSettingsKey,
                nextSettings
            )
        } else {
            virtualFolder.children = groupItems
        }

        return virtualFolder
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

    return virtualFolders
}
