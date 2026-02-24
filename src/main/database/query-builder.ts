import { REPOSITORY_SCHEMA } from './repo-definitions'
import { CORE_FIELDS } from '@shared/types'

export interface FindOptions {
    where?: Record<string, any>
    fields?: string[]
    orderBy?: { field: string; direction: 'ASC' | 'DESC' }
    limit?: number
    offset?: number
    includeHidden?: boolean
    includeIgnored?: boolean
}

/**
 * Builds a dynamic SQL query based on find options.
 */
export function buildFindQuery(options: FindOptions = {}): { query: string; params: any[] } {
    const requestedFields = options.fields || []
    const fieldsToSelect: string[] = requestedFields.length > 0 ? [...requestedFields] : [...(CORE_FIELDS as unknown as string[])]

    const usedTables = new Set<string>()
    const effectiveFields = new Set<string>(fieldsToSelect)

    // Helper to handle prefixed fields (vt.*, tags.*)
    const processField = (field: string) => {
        const def = REPOSITORY_SCHEMA[field]
        if (def && def.table) {
            usedTables.add(def.table)
        } else if (field.startsWith('vt.') || field.startsWith('virtualTags.')) {
            usedTables.add('e')
            effectiveFields.add('virtualTags')
        } else if (field.startsWith('tags.')) {
            usedTables.add('e')
            effectiveFields.add('tags')
        }
    }

    for (const field of fieldsToSelect) {
        processField(field)
    }

    if (options.where) {
        for (const key of Object.keys(options.where)) {
            processField(key)
        }
    }

    if (options.orderBy) {
        processField(options.orderBy.field)
    }

    // Convert back to array for iterate
    const finalFields = Array.from(effectiveFields)

    // Always ensure 'i.id' is selected if not requested explicitly (mapper needs it)
    if (!finalFields.includes('id')) {
        finalFields.unshift('id')
    }

    const selectParts: string[] = []
    if (usedTables.has('e')) {
        selectParts.push('e.id AS _entity_id')
    }

    for (const alias of finalFields) {
        const def = REPOSITORY_SCHEMA[alias]
        if (def) {
            selectParts.push(`${def.sql} AS ${alias}`)
        }
    }

    const selectClause = selectParts.join(', ')
    let query = `SELECT ${selectClause} FROM items i`

    if (usedTables.has('e')) {
        query += ` LEFT JOIN media_entities e ON i.entity_id = e.id`
    }
    if (usedTables.has('u')) {
        query += ` LEFT JOIN user_state u ON i.id = u.item_id`
    }
    if (usedTables.has('f')) {
        query += ` LEFT JOIN folder_settings f ON i.id = f.item_id`
    }

    const params: any[] = []
    const conditions: string[] = []

    const includeHidden = options.includeHidden ?? false
    const includeIgnored = options.includeIgnored ?? false

    if (!includeHidden) {
        conditions.push('(i.is_hidden IS NULL OR i.is_hidden = 0)')
    }
    if (!includeIgnored) {
        conditions.push('(i.is_ignored IS NULL OR i.is_ignored = 0)')
    }

    if (options.where) {
        for (const [key, value] of Object.entries(options.where)) {
            const def = REPOSITORY_SCHEMA[key]

            if (def) {
                if (value === null) {
                    conditions.push(`${def.sql} IS NULL`)
                } else if (value !== null && typeof value === 'object' && (value as any).$ne === null) {
                    conditions.push(`${def.sql} IS NOT NULL`)
                } else if (Array.isArray(value)) {
                    if (value.length > 0) {
                        conditions.push(`${def.sql} IN(${value.map(() => '?').join(',')})`)
                        params.push(...value)
                    } else {
                        conditions.push('1 = 0') // Empty IN mismatch
                    }
                } else {
                    conditions.push(`${def.sql} = ?`)
                    params.push(value)
                }
            }
            // Virtual Tags
            else if (key.startsWith('virtualTags.') || key.startsWith('vt.')) {
                const tagKey = key.split('.')[1]
                conditions.push(`json_extract(e.virtual_tags_json, '$.${tagKey}') = ?`)
                params.push(value)
            }
            // Manual Tags
            else if (key.startsWith('tags.')) {
                const tagKey = key.split('.')[1]
                conditions.push(`json_extract(e.tags_json, '$.${tagKey}') = ?`)
                params.push(value)
            }
            // Genres
            else if (key === 'genre' || key === 'genres') {
                conditions.push(`EXISTS (SELECT 1 FROM json_each(e.genres_json) WHERE value = ?)`)
                params.push(value)
            }
        }
    }

    if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`
    }

    if (options.orderBy) {
        const def = REPOSITORY_SCHEMA[options.orderBy.field]
        if (def) {
            query += ` ORDER BY ${def.sql} ${options.orderBy.direction}`
        }
    }

    if (options.limit) {
        query += ` LIMIT ${options.limit}`
        if (options.offset) {
            query += ` OFFSET ${options.offset}`
        }
    }

    return { query, params }
}
