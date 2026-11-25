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

// Rows from find() use field aliases. Rows from raw item queries use column names.
// An alias takes precedence over a column of the same field.
const BY_ALIAS = new Map<string, RepositoryFieldDef>(Object.entries(REPOSITORY_SCHEMA))
const BY_COLUMN = new Map<string, string>()
for (const [alias, def] of Object.entries(REPOSITORY_SCHEMA)) {
    const column = def.sql.includes('.') ? def.sql.split('.')[1] : def.sql
    if (!BY_ALIAS.has(column) && !BY_COLUMN.has(column)) BY_COLUMN.set(column, alias)
}

/**
 * Maps a raw database row into a LibraryItem object.
 */
export function mapRowToLibraryItem(row: any): LibraryItem {
    const item: any = {}

    // 1. Core Identity & Flat Fields
    // A row holds only the selected fields, so visit its keys rather than every schema field.
    for (const key in row) {
        const alias = BY_ALIAS.has(key) ? key : BY_COLUMN.get(key)
        if (!alias || (alias !== key && row[alias] !== undefined)) continue
        const def = BY_ALIAS.get(alias)!
        let val = row[key]

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
