import type { SearchQuery } from './search-store-v2.svelte'

/**
 * Serializes a SearchQuery object into a string for use in URL parameters.
 * Format: "text :key:value :key2:value2"
 */
export function serializeSearchQuery(query: SearchQuery): string {
    const parts: string[] = []

    if (query.text) {
        parts.push(query.text)
    }

    for (const tag of query.tags) {
        parts.push(`:${tag.key}:${tag.value}`)
    }

    return parts.join(' ')
}

/**
 * Deserializes a search string into a SearchQuery object.
 * Handles format: "text :key:value :key2:value2"
 */
export function deserializeSearchQuery(q: string | null): SearchQuery {
    if (!q) return { text: '', tags: [] }

    const tags: { key: string; value: string }[] = []
    const tagStartRegex = /:([a-zA-Z0-9_.-]+):/g
    const matches = [...q.matchAll(tagStartRegex)]

    let text = q

    if (matches.length > 0) {
        // The part before the first tag is the generic text.
        text = q.substring(0, matches[0].index).trim()

        for (let i = 0; i < matches.length; i++) {
            const key = matches[i][1]
            const start = matches[i].index! + matches[i][0].length
            const end = i + 1 < matches.length ? matches[i + 1].index : q.length
            const value = q.substring(start, end).trim()
            tags.push({ key, value })
        }
    }

    return { text, tags }
}
