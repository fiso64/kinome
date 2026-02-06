import * as repositoryService from './repository.service'
import * as settingsService from './settings.service'
import type { AutocompleteSuggestions } from '../../shared/types'

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

export const invalidateCache = () => {
    personCache = null
}
