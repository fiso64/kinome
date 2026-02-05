import equal from 'fast-deep-equal'
import * as repositoryService from './repository.service'
import * as settingsService from './settings.service'
import * as virtualTagsService from './virtualTags.service'
import { getTransport } from '../transport.registry'
import type { LibraryItem, AutocompleteSuggestions } from '../../shared/types'

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

export const getGroupByKeys = async () => {
    const settings = await settingsService.readSettings()
    const allItems = repositoryService.getAllItemsAsList()

    const tagKeys = new Set<string>()

    for (const item of allItems) {
        if (item.tags) {
            for (const key of Object.keys(item.tags)) {
                const k = key.trim()
                if (k) tagKeys.add(k)
            }
        }
    }

    return [
        'folder',
        'mediaType',
        'genre',
        'year',
        ...(settings.virtualTags?.map((vt) => `vt.${vt.name}`) ?? []),
        ...Array.from(tagKeys).sort().map((k) => `tags.${k}`)
    ]
}

const fuzzyFilterAndSort = (items: string[], query: string, limit: number): string[] => {
    const lowerQuery = query.toLowerCase().trim()
    if (!lowerQuery) return items.slice(0, limit)

    const results: { item: string; score: number }[] = []
    for (const item of items) {
        const lowerItem = item.toLowerCase()
        const index = lowerItem.indexOf(lowerQuery)
        if (index !== -1) {
            results.push({ item, score: index === 0 ? 0 : index + 1 })
        }
    }

    return results
        .sort((a, b) => {
            if (a.score !== b.score) return a.score - b.score
            return a.item.localeCompare(b.item)
        })
        .slice(0, limit)
        .map((r) => r.item)
}

export const getAutocompleteValues = async (key: string, query: string = '', limit: number = 20): Promise<string[]> => {
    // Specialized high-performance path for persons
    if (key === 'person') {
        return searchPersons(query, limit)
    }

    const allItems = repositoryService.getAllItemsAsList()
    const values = new Set<string>()

    for (const item of allItems) {
        if (key === 'mediaType' && item.mediaType) {
            values.add(item.mediaType.trim())
        } else if (key === 'genre' && item.genres) {
            item.genres.forEach((g) => values.add(g.trim()))
        } else if (key === 'year' && item.year) {
            values.add(item.year.toString())
        } else if (item.tags && item.tags[key]) {
            item.tags[key].split(',').forEach((v) => v.trim() && values.add(v.trim()))
        } else if (item.virtualTags && item.virtualTags[key]) {
            values.add(item.virtualTags[key].trim())
        }
    }

    const list = Array.from(values).sort()
    return fuzzyFilterAndSort(list, query, limit)
}

export const getAutocompleteSuggestions = async (): Promise<AutocompleteSuggestions> => {
    const settings = await settingsService.readSettings()
    const allItems = repositoryService.getAllItemsAsList()

    const mediaType = new Set<string>()
    const genre = new Set<string>()
    const tags: Record<string, Set<string>> = {}
    const virtualTags: Record<string, Set<string>> = {}

    for (const item of allItems) {
        if (item.mediaType) {
            mediaType.add(item.mediaType.trim())
        }
        if (item.genres) {
            item.genres.forEach((g) => genre.add(g.trim()))
        }

        if (item.tags) {
            for (const [key, value] of Object.entries(item.tags)) {
                if (!tags[key]) tags[key] = new Set()
                if (value) {
                    value.split(',').forEach((v) => {
                        const trimmed = v.trim()
                        if (trimmed) tags[key].add(trimmed)
                    })
                }
            }
        }

        if (item.virtualTags) {
            for (const [key, value] of Object.entries(item.virtualTags)) {
                if (!virtualTags[key]) virtualTags[key] = new Set()
                if (value) {
                    const trimmed = value.trim()
                    if (trimmed) virtualTags[key].add(trimmed)
                }
            }
        }
    }

    // Ensure all defined virtual tags are present in the keys, even if empty
    if (settings.virtualTags) {
        for (const vt of settings.virtualTags) {
            if (!virtualTags[vt.name]) virtualTags[vt.name] = new Set()
        }
    }

    const sortSet = (s: Set<string>) => Array.from(s).sort()
    const mapDict = (d: Record<string, Set<string>>) => {
        const result: Record<string, string[]> = {}
        for (const [k, v] of Object.entries(d)) {
            result[k] = sortSet(v)
        }
        return result
    }

    return {
        mediaType: sortSet(mediaType),
        genre: sortSet(genre),
        person: null, // Signalling that person suggestions are server-side
        tags: mapDict(tags),
        virtualTags: mapDict(virtualTags)
    }
}

let personCache: string[] | null = null

export const searchPersons = async (query: string, limit: number = 20): Promise<string[]> => {
    if (!personCache) {
        const allItems = repositoryService.getAllItemsAsList()
        const personSet = new Set<string>()
        for (const item of allItems) {
            if (item.tmdbCredits) {
                const collect = (name: string) => personSet.add(name.trim())
                    ; (item.tmdbCredits.cast ?? []).forEach((p) => p.name && collect(p.name))
                    ; (item.tmdbCredits.crew ?? []).forEach((p) => p.name && collect(p.name))
            }
        }
        personCache = Array.from(personSet).sort()
    }

    return fuzzyFilterAndSort(personCache, query, limit)
}

// Clear person cache when items are updated significantly (implied logic, but for now simple)
export const invalidatePersonCache = () => {
    personCache = null
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
            const newVirtualTags = virtualTagsService.evaluateVirtualTagsForItem(nextState as LibraryItem, settings)

            // Apply the calculated tags to both our comparison object AND the payload
            nextState.virtualTags = newVirtualTags
            item.virtualTags = newVirtualTags

            // 3. Detect Changes using the robust snapshot comparison
            // Now we compare Full Object (Existing) vs Full Object (Next State)
            // We also allow forcing an update if _v was explicitly provided in the update payload.
            const forceUpdate = (item as any)._v !== undefined && (item as any)._v !== (existing as any)?._v
            const hasRealChanges = !existing || forceUpdate || !isItemDataSame(existing, nextState as LibraryItem)

            if (hasRealChanges) {
                item._v = Date.now()
                if (!item.id.startsWith('virtual--')) {
                    repositoryService._updateItem(item.id, item)
                }
                modifiedItems.push(item)
                invalidatePersonCache()
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
        const [suggestions, groupByKeys] = await Promise.all([
            getAutocompleteSuggestions(),
            getGroupByKeys()
        ])
        getTransport().notifyMetadataIndexUpdated({ suggestions, groupByKeys })
    }
}
