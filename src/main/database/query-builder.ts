import { REPOSITORY_SCHEMA } from './repo-definitions'
import { CORE_FIELDS } from '@shared/types'
import type { LibraryFilter } from '@shared/types'

/**
 * An operator-aware WHERE condition that maps to a REPOSITORY_SCHEMA field
 * or one of the special field namespaces (genre, tags.key, vt.key).
 */
export interface TypedWhereClause {
    field: string
    op: 'eq' | 'ne' | 'contains' | 'gt' | 'lt'
    value: string | number | null
}

export interface FindOptions {
    where?: Record<string, any>
    typedWhere?: TypedWhereClause[]
    rawConditions?: string[]
    fields?: string[]
    orderBy?: { field: string; direction: 'ASC' | 'DESC' }
    limit?: number
    offset?: number
    includeHidden?: boolean
    includeIgnored?: boolean
}

/**
 * Compiles a LibraryFilter into FindOptions for use with find() or buildFindQuery().
 *
 * Always adds `i.is_virtual = 0` — pool queries and vtag filters operate over
 * real items only, regardless of scope.
 *
 * Handles:
 *   scope.parentId  → where.parentId (equality)
 *   conditions[].field  →
 *     'genre'/'genres'          → typedWhere (EXISTS on entity_genres)
 *     'tags.{key}'              → typedWhere (EXISTS on entity_tags)
 *     'vt.{key}'/'virtualTags.{key}' → typedWhere (EXISTS on entity_virtual_tags)
 *     REPOSITORY_SCHEMA key     → where (eq) or typedWhere (other ops)
 */
export function compileFilter(filter: LibraryFilter): FindOptions {
    const where: Record<string, any> = {}
    const typedWhere: TypedWhereClause[] = []
    const rawConditions: string[] = ['i.is_virtual = 0']

    if (filter.scope?.parentId) {
        where.parentId = filter.scope.parentId
    }

    for (const cond of filter.conditions ?? []) {
        const { field, op, value } = cond
        if (op === 'eq' && field !== 'genre' && field !== 'genres' &&
            !field.startsWith('tags.') && !field.startsWith('vt.') && !field.startsWith('virtualTags.')) {
            where[field] = value
        } else {
            typedWhere.push({ field, op, value })
        }
    }

    return {
        where: Object.keys(where).length ? where : undefined,
        typedWhere: typedWhere.length ? typedWhere : undefined,
        rawConditions
    }
}

/**
 * Builds the WHERE conditions, params, and required table set from FindOptions.
 * Exported so that write-path code (e.g. evaluateAndInsertVirtualTags) can
 * reuse the same condition logic without running a full SELECT query.
 */
export function buildWhereFragment(options: FindOptions): {
    conditions: string[]
    params: any[]
    tables: Set<string>
} {
    const conditions: string[] = []
    const params: any[] = []
    const tables = new Set<string>()

    const includeHidden = options.includeHidden ?? false
    const includeIgnored = options.includeIgnored ?? false

    if (!includeHidden) conditions.push('(i.is_hidden IS NULL OR i.is_hidden = 0)')
    if (!includeIgnored) conditions.push('(i.is_ignored IS NULL OR i.is_ignored = 0)')

    if (options.where) {
        for (const [key, value] of Object.entries(options.where)) {
            const def = REPOSITORY_SCHEMA[key]
            if (def) {
                if (def.table) tables.add(def.table)
                if (value === null) {
                    conditions.push(`${def.sql} IS NULL`)
                } else if (value !== null && typeof value === 'object' && (value as any).$ne === null) {
                    conditions.push(`${def.sql} IS NOT NULL`)
                } else if (Array.isArray(value)) {
                    if (value.length > 0) {
                        conditions.push(`${def.sql} IN(${value.map(() => '?').join(',')})`)
                        params.push(...value)
                    } else {
                        conditions.push('1 = 0')
                    }
                } else {
                    conditions.push(`${def.sql} = ?`)
                    params.push(value)
                }
            } else if (key.startsWith('virtualTags.') || key.startsWith('vt.')) {
                const tagKey = key.split('.')[1]
                tables.add('e')
                conditions.push(`EXISTS (SELECT 1 FROM entity_virtual_tags WHERE entity_id = e.id AND key = ? AND value = ?)`)
                params.push(tagKey, value)
            } else if (key.startsWith('tags.')) {
                const tagKey = key.split('.')[1]
                tables.add('e')
                conditions.push(`EXISTS (SELECT 1 FROM entity_tags WHERE entity_id = e.id AND key = ? AND value = ?)`)
                params.push(tagKey, value)
            } else if (key === 'genre' || key === 'genres') {
                tables.add('e')
                conditions.push(`EXISTS (SELECT 1 FROM entity_genres eg JOIN genres g ON eg.genre_id = g.id WHERE eg.entity_id = e.id AND g.name = ?)`)
                params.push(value)
            }
        }
    }

    if (options.typedWhere) {
        for (const { field, op, value } of options.typedWhere) {
            if (field === 'genre' || field === 'genres') {
                tables.add('e')
                if (op === 'contains') {
                    conditions.push(`EXISTS (SELECT 1 FROM entity_genres eg JOIN genres g ON eg.genre_id = g.id WHERE eg.entity_id = e.id AND g.name LIKE ?)`)
                    params.push(`%${value}%`)
                } else {
                    conditions.push(`EXISTS (SELECT 1 FROM entity_genres eg JOIN genres g ON eg.genre_id = g.id WHERE eg.entity_id = e.id AND g.name = ?)`)
                    params.push(value)
                }
            } else if (field.startsWith('tags.')) {
                const key = field.slice(5)
                tables.add('e')
                if (op === 'contains') {
                    conditions.push(`EXISTS (SELECT 1 FROM entity_tags WHERE entity_id = e.id AND key = ? AND value LIKE ?)`)
                    params.push(key, `%${value}%`)
                } else {
                    conditions.push(`EXISTS (SELECT 1 FROM entity_tags WHERE entity_id = e.id AND key = ? AND value = ?)`)
                    params.push(key, value)
                }
            } else if (field.startsWith('vt.') || field.startsWith('virtualTags.')) {
                const key = field.split('.')[1]
                tables.add('e')
                if (op === 'contains') {
                    conditions.push(`EXISTS (SELECT 1 FROM entity_virtual_tags WHERE entity_id = e.id AND key = ? AND value LIKE ?)`)
                    params.push(key, `%${value}%`)
                } else {
                    conditions.push(`EXISTS (SELECT 1 FROM entity_virtual_tags WHERE entity_id = e.id AND key = ? AND value = ?)`)
                    params.push(key, value)
                }
            } else {
                const def = REPOSITORY_SCHEMA[field]
                if (def) {
                    if (def.table) tables.add(def.table)
                    switch (op) {
                        case 'eq':  conditions.push(`${def.sql} = ?`);        params.push(value); break
                        case 'ne':  conditions.push(`${def.sql} != ?`);       params.push(value); break
                        case 'contains': conditions.push(`${def.sql} LIKE ?`); params.push(`%${value}%`); break
                        case 'gt':  conditions.push(`${def.sql} > ?`);        params.push(value); break
                        case 'lt':  conditions.push(`${def.sql} < ?`);        params.push(value); break
                    }
                }
            }
        }
    }

    if (options.rawConditions) {
        for (const cond of options.rawConditions) {
            conditions.push(cond)
        }
    }

    return { conditions, params, tables }
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
        if (def) {
            if (def.table) usedTables.add(def.table)
            // Subquery fields reference e.id, so they need the entity table joined
            if (def.isSubquery) usedTables.add('e')
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

    // Resolve WHERE conditions early so their table requirements inform JOIN decisions
    const { conditions, params, tables: whereTables } = buildWhereFragment(options)
    for (const t of whereTables) usedTables.add(t)

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
