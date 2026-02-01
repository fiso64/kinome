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

function groupItemsRecursive(
    items: LibraryItem[],
    groupByKey: string,
    currentParentId: string,
    physicalParent: MediaFolder | null,
    parentTokenPath: string,
    inheritedSettings: any
): LibraryItem[] {
    const groups: Record<string, LibraryItem[]> = {}

    for (const item of items) {
        const values = getValuesForKey(item, groupByKey) // Imported from repo service? No, getValuesForKey is internal to repo usually.
        // I need to import getValuesForKey or reimplement it. It's exported from repository.service.ts line 1045?
        // Start of file showed it exported in recent view? 
        // I'll assume it is or check. If not, I'll copy it.
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
