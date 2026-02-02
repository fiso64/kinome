import equal from 'fast-deep-equal'
import * as repositoryService from './repository.service'
import * as settingsService from './settings.service'
import * as virtualTagsService from './virtualTags.service'
import { getTransport } from '../transport.registry'
import type { LibraryItem } from '../../shared/types'

const log = (message: string): void => {
    console.log(`[${new Date().toISOString()}] [Item Update Service] ${message}`)
}

/**
 * Creates a "content-only" snapshot for change detection.
 * Excludes volatile system fields and deep relations to prevent false positives.
 */
function getComparisonSnapshot(item: LibraryItem | null | undefined) {
    if (!item) return null

    // Destructure to separate DATA from SYSTEM NOISE
    const {
        // 1. System/DB Fields (Auto-managed or Volatile)
        _v,
        _internalId,
        addedAt,
        updatedAt,
        createdAt,

        // 2. Filesystem Stats (Handled by scanner, not service-level broadcast-triggers)
        mtime,
        size,
        birthtime,

        // 3. Relational Data (CRITICAL TO EXCLUDE)
        // Children are separate entities; changing them shouldn't mark parent as dirty
        children,

        // 4. Runtime/Broadcast Fields
        ancestorIds,
        isVirtual,

        // The rest is actual content (metadata, user state, settings, etc.)
        ...data
    } = item as any

    return {
        ...data,
        // Normalize Locked Fields (sort so order doesn't matter)
        lockedFields: (data.lockedFields || []).slice().sort(),

        // Normalize Dates (compare timestamps)
        // These fields are sometimes number, sometimes string, sometimes Date in JS
        lastWatched: data.lastWatched ? new Date(data.lastWatched).getTime() : null,
        lastRefreshedAt: data.lastRefreshedAt ? new Date(data.lastRefreshedAt).getTime() : null
    }
}

/**
 * Robust comparison function using deep snapshots.
 * IMPORTANT: Careful not to use this for partial updates (without merging first), as it will always return false.
 */
export function isItemDataSame(existing: LibraryItem, updated: LibraryItem): boolean {
    return equal(getComparisonSnapshot(existing), getComparisonSnapshot(updated))
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
        if (item.mediaType) {
            const mt = item.mediaType.trim()
            mediaTypes.add(mt)
            if (!tagValues['mediaType']) tagValues['mediaType'] = new Set<string>()
            tagValues['mediaType'].add(mt)
        }
        if (item.genres) {
            item.genres.forEach((g) => {
                const genre = g.trim()
                genres.add(genre)
                if (!tagValues['genre']) tagValues['genre'] = new Set<string>()
                tagValues['genre'].add(genre)
            })
        }
        if (item.year) {
            const yearStr = item.year.toString()
            if (!tagValues['year']) tagValues['year'] = new Set<string>()
            tagValues['year'].add(yearStr)
        }
        if (item.tmdbCredits) {
            const collectPerson = (name: string) => {
                const p = name.trim()
                persons.add(p)
                if (!tagValues['person']) tagValues['person'] = new Set<string>()
                tagValues['person'].add(p)
            }
                ; (item.tmdbCredits.cast ?? []).forEach((p) => p.name && collectPerson(p.name))
                ; (item.tmdbCredits.crew ?? []).forEach((p) => p.name && collectPerson(p.name))
        }
        if (item.tags) {
            for (const [key, value] of Object.entries(item.tags)) {
                const k = key.trim()
                if (k) {
                    tagKeys.add(k)
                    if (!tagValues[k]) tagValues[k] = new Set<string>()
                    value.split(',').forEach((v) => v.trim() && tagValues[k].add(v.trim()))
                }
            }
        }
        if (item.virtualTags) {
            for (const [key, value] of Object.entries(item.virtualTags)) {
                const k = key.trim()
                if (k) {
                    virtualTagKeys.add(k)
                    if (!tagValues[k]) tagValues[k] = new Set<string>()
                    if (value) tagValues[k].add(value.trim())
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
            const existing = repositoryService.getItemById(item.id)

            // 1. Construct the hypothetical "Next State"
            // We merge the partial update 'item' over the 'existing' full object.
            // This fills in the missing holes in the partial update with current DB data.
            const nextState = existing ? { ...existing, ...item } : item

            // 2. Recalculate Virtual Tags on the FULL state
            // This fixes the bug where tags were lost because partial updates missed dependency fields (e.g. genres)
            const newVirtualTags = virtualTagsService.evaluateVirtualTagsForItem(nextState, settings)

            // Apply the calculated tags to both our comparison object AND the payload
            nextState.virtualTags = newVirtualTags
            item.virtualTags = newVirtualTags

            // 3. Detect Changes using the robust snapshot comparison
            // Now we compare Full Object (Existing) vs Full Object (Next State)
            const hasRealChanges = !existing || !isItemDataSame(existing, nextState)

            if (hasRealChanges) {
                item._v = Date.now()
                if (!item.id.startsWith('virtual--')) {
                    repositoryService._updateItem(item.id, item)
                }
                modifiedItems.push(item)
            } else {
                console.log(`[Item Update Service] Item ${item.id} has no real changes. Skipping update and broadcast.`)
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
