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
 */
export function isItemDataSame(existing: LibraryItem, updated: LibraryItem): boolean {
    const snap1 = getComparisonSnapshot(existing)
    const snap2 = getComparisonSnapshot(updated)

    const isSame = equal(snap1, snap2)

    if (!isSame && snap1 && snap2) {
        // [TRACE] Determine exactly what changed
        const diffs: string[] = []
        const allKeys = new Set([...Object.keys(snap1), ...Object.keys(snap2)])
        for (const key of allKeys) {
            const v1 = (snap1 as any)[key]
            const v2 = (snap2 as any)[key]
            if (!equal(v1, v2)) {
                diffs.push(`${key}: ${JSON.stringify(v1)} -> ${JSON.stringify(v2)}`)
            }
        }
        if (diffs.length > 0) {
            console.log(`[Item Update Service] [TRACE] Diffs for ${existing.id}:`, diffs.join(', '))
        }
    }

    return isSame
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
