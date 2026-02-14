import type { LibraryItem } from '@shared/types'
import { REPOSITORY_SCHEMA, type RepositoryFieldDef } from './repo-definitions'

/**
 * Safely parse JSON strings with a fallback value.
 */
export function parseJsonSafe<T>(jsonString: string | null, fallback: T): T {
    if (!jsonString) return fallback
    try {
        const parsed = JSON.parse(jsonString)
        return parsed === null ? fallback : parsed
    } catch (e) {
        return fallback
    }
}

/**
 * Helper to get a value from a row, prioritizing the alias but falling back to raw column name if needed.
 */
function getRowValue(row: any, alias: string, def: RepositoryFieldDef) {
    if (row[alias] !== undefined) return row[alias]
    const rawCol = def.sql.includes('.') ? def.sql.split('.')[1] : def.sql
    if (row[rawCol] !== undefined) return row[rawCol]
    return undefined
}

/**
 * Maps a raw database row into a LibraryItem object.
 */
export function mapRowToLibraryItem(row: any): LibraryItem {
    const item: any = {}

    // 1. Core Identity & Flat Fields
    for (const [alias, def] of Object.entries(REPOSITORY_SCHEMA)) {
        let val = getRowValue(row, alias, def)

        // Special handling for JSON extraction fallback
        const isImage = ['posterPath', 'backdropPath', 'logoPath'].includes(alias)
        if (val === undefined && isImage && row.images_json) {
            const images = parseJsonSafe(row.images_json, {}) as any
            const key = alias.replace('Path', '') // posterPath -> poster
            val = images[key]
        }

        // Generic JSON Parsing
        if (def.isJson) {
            if (typeof val === 'string') {
                const isArray = ['lockedFields', 'genres'].includes(alias)
                const isNullable = ['tmdbCredits', 'tmdbSeasons', 'tmdbEpisodes'].includes(alias)
                const fallback = isArray ? [] : isNullable ? null : {}
                val = parseJsonSafe(val, fallback)

                // Sanity Check / Auto-Heal
                if (
                    (alias === 'tmdbSeasons' || alias === 'tmdbEpisodes') &&
                    val !== null &&
                    !Array.isArray(val)
                ) {
                    val = null
                }
            }
        }

        // Generic Parser (Boolean etc)
        if (val !== undefined && def.parser && val !== null) {
            val = def.parser(val)
        }

        if (val !== undefined) {
            item[alias] = val
        }
    }

    // 2. Computed / Logic-heavy fields
    const ver = item._v
    const tid = item.tmdbId
    const metaJoinId = row.item_id

    const actuallyHasMetadata =
        metaJoinId !== undefined
            ? metaJoinId !== null
            : item.title !== undefined || item._v !== undefined

    if (!actuallyHasMetadata) {
        item.tmdbId = undefined
        item.mediaType = undefined
        item.lockedFields = undefined
    } else {
        if (tid === null || tid === undefined) {
            item.tmdbId = ver != null ? null : undefined
        }
    }

    // 3. Folder specific logic
    if (item.type === 'folder') {
        item.children = null
    }

    return item as LibraryItem
}
