import * as repositoryService from './repository.service'
import * as settingsService from './settings.service'
import * as virtualTagsService from './virtualTags.service'
import { getTransport } from '../transport.registry'
import type { LibraryItem } from '../../shared/types'
import { VIEW_SETTINGS_KEYS, METADATA_KEYS } from '../../shared/types'

const log = (message: string): void => {
    console.log(`[${new Date().toISOString()}] [Item Update Service] ${message}`)
}

/**
 * Deeply compares two objects for equality based on specific metadata and user state keys.
 */
export function isItemDataSame(existing: LibraryItem, updated: LibraryItem): boolean {
    // 1. Check Metadata Keys
    for (const key of METADATA_KEYS) {
        const k = key as keyof LibraryItem
        const v1 = JSON.stringify(existing[k])
        const v2 = JSON.stringify(updated[k])
        if (v1 !== v2) return false
    }

    // 2. Check User State Keys
    const USER_KEYS: (keyof LibraryItem)[] = [
        'watched',
        'lastWatched',
        'continueWatchingDismissed',
        'nextUpDismissed'
    ]
    for (const key of USER_KEYS) {
        if (existing[key] !== updated[key]) return false
    }

    // 3. Check Folder Settings
    for (const key of VIEW_SETTINGS_KEYS) {
        const k = key as keyof LibraryItem
        if (JSON.stringify(existing[k]) !== JSON.stringify(updated[k])) return false
    }

    // 4. Check Locking
    const locks1 = JSON.stringify((existing.lockedFields || []).sort())
    const locks2 = JSON.stringify((updated.lockedFields || []).sort())
    if (locks1 !== locks2) return false

    // 5. Check System Flags
    if (existing.isHidden !== updated.isHidden) return false
    if (existing.isMissing !== updated.isMissing) return false

    return true
}

export const getAutocompleteSuggestions = async () => {
    const settings = await settingsService.readSettings()
    const allItems = repositoryService.getAllItemsAsList()

    const mediaTypes = new Set<string>()
    const genres = new Set<string>()
    const persons = new Set<string>()
    const tagKeys = new Set<string>()
    const virtualTagKeys = new Set<string>()
    const tagValues: Record<string, Set<string>> = {}

    if (settings.virtualTags) {
        for (const tag of settings.virtualTags) {
            virtualTagKeys.add(tag.name.trim())
        }
    }

    for (const item of allItems) {
        if (item.mediaType) mediaTypes.add(item.mediaType.trim())
        if (item.genres) item.genres.forEach((g) => genres.add(g.trim()))
        if (item.tmdbCredits) {
            ; (item.tmdbCredits.cast ?? []).forEach((p) => p.name && persons.add(p.name.trim()))
                ; (item.tmdbCredits.crew ?? []).forEach((p) => p.name && persons.add(p.name.trim()))
        }
        if (item.tags) {
            for (const [key, value] of Object.entries(item.tags)) {
                if (key) {
                    tagKeys.add(key.trim())
                    if (!tagValues[key]) tagValues[key] = new Set<string>()
                    value.split(',').forEach((v) => v.trim() && tagValues[key].add(v.trim()))
                }
            }
        }
        if (item.virtualTags) {
            for (const [key, value] of Object.entries(item.virtualTags)) {
                if (key) {
                    virtualTagKeys.add(key.trim())
                    if (!tagValues[key]) tagValues[key] = new Set<string>()
                    if (value) tagValues[key].add(value.trim())
                }
            }
        }
    }

    const tagValuesAsArrays: Record<string, string[]> = {}
    for (const key in tagValues) {
        tagValuesAsArrays[key] = Array.from(tagValues[key]).sort()
    }

    return {
        mediaTypes: Array.from(mediaTypes).sort(),
        genres: Array.from(genres).sort(),
        persons: Array.from(persons).sort(),
        tagKeys: Array.from(tagKeys).sort(),
        virtualTagKeys: Array.from(virtualTagKeys).sort(),
        tagValues: tagValuesAsArrays
    }
}

export async function updateIfChangedAndBroadcast(
    items: LibraryItem | LibraryItem[],
    options: { updateSuggestions?: boolean } = {}
): Promise<void> {
    if (!items || (Array.isArray(items) && items.length === 0)) return
    const itemsArray = Array.isArray(items) ? items : [items]

    const settings = await settingsService.readSettings()
    const modifiedItems: LibraryItem[] = []

    repositoryService.runTransaction(() => {
        for (const item of itemsArray) {
            const newVirtualTags = virtualTagsService.evaluateVirtualTagsForItem(item, settings)
            const virtualTagsChanged = JSON.stringify(item.virtualTags) !== JSON.stringify(newVirtualTags)
            item.virtualTags = newVirtualTags

            const existing = repositoryService.getItemById(item.id)
            const hasRealChanges = !existing || !isItemDataSame(existing, item) || virtualTagsChanged

            if (hasRealChanges) {
                item._v = Date.now()
                if (!item.id.startsWith('virtual--')) {
                    repositoryService._updateItem(item.id, item)
                }
                modifiedItems.push(item)
            }
        }
    })

    if (modifiedItems.length === 0) return

    const plainItems = JSON.parse(JSON.stringify(modifiedItems))
    for (const item of plainItems) {
        const ancestors = repositoryService.getAncestors(item.id)
        item.ancestorIds = ancestors.map((a) => a.id)
    }

    log(`Broadcasting updates for ${modifiedItems.length} items.`)
    getTransport().notifyLibraryItemsUpdated(plainItems)

    if (options.updateSuggestions) {
        const newSuggestions = await getAutocompleteSuggestions()
        getTransport().notifyAutocompleteSuggestionsUpdated(newSuggestions)
    }
}
