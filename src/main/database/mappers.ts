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

        // 1. JSON Parsing (subqueries and blob columns both return JSON strings)
        if (def.isJson && typeof val === 'string') {
            val = parseJsonSafe(val, def.jsonDefault ?? {})
        }

        // 2. Transform (field-specific cleanup for JSON, Boolean coercion for flags, etc.)
        if (val !== undefined && val !== null && def.parser) {
            val = def.parser(val)
        }

        if (val !== undefined) {
            item[alias] = val
        }
    }

    // 2. Computed / Logic-heavy fields
    const ver = item._v
    const tid = item.tmdbId
    const entityJoinId = row._entity_id

    const actuallyHasMetadata =
        entityJoinId !== undefined
            ? entityJoinId !== null
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
        // Assemble folderSettings from individual DB columns
        if (item.retrieveChildrenMetadata !== undefined || item.childrenTypeHint !== undefined || item.processTvChildren !== undefined) {
            item.folderSettings = {
                retrieveChildrenMetadata: !!item.retrieveChildrenMetadata,
                childrenTypeHint: item.childrenTypeHint ?? null,
                processTvChildren: item.processTvChildren !== false && item.processTvChildren !== 0,
            }
            delete item.retrieveChildrenMetadata
            delete item.childrenTypeHint
            delete item.processTvChildren
        }
    }

    return item as LibraryItem
}
