import { REPOSITORY_SCHEMA } from './repo-definitions'
import { CORE_FIELDS } from '@shared/types'
import type { LibraryFilter, LibraryCondition } from '@shared/types'

/**
 * An operator-aware WHERE condition that maps to a REPOSITORY_SCHEMA field
 * or one of the special field namespaces (genre, tags.key, vt.key).
 */
export interface TypedWhereClause {
    field: string
    op: 'eq' | 'ne' | 'contains' | 'notContains' | 'gt' | 'gte' | 'lt' | 'lte' | 'isNull' | 'isNotNull' | 'isEmpty' | 'isNotEmpty'
    value?: string | number | null
}

/**
 * A compiled SQL fragment with its bound params and required table joins.
 */
export interface CompiledSql {
    sql: string
    params: any[]
    tables: Set<string>
}

export interface OrderByClause {
    field: string
    direction: 'ASC' | 'DESC'
    /** When true, NULL values sort after all non-NULL values regardless of direction. */
    nullsLast?: boolean
}

export interface FindOptions {
    where?: Record<string, any>
    typedWhere?: TypedWhereClause[]
    rawConditions?: string[]
    compiledConditions?: CompiledSql
    fields?: string[]
    orderBy?: OrderByClause | OrderByClause[]
    /** Raw SQL expression prepended to ORDER BY (before schema-based orderBy clauses). */
    compiledOrderPrefix?: { sql: string; params: any[] }
    limit?: number
    offset?: number
    includeHidden?: boolean
    includeIgnored?: boolean
}

// =================================================================
// Primitive: compile a single LibraryCondition to SQL
// =================================================================

/**
 * Compiles a single LibraryCondition into a SQL fragment, params, and required tables.
 * This is the shared primitive used by both compileFilter (OR-of-AND groups)
 * and buildWhereFragment (typedWhere clauses).
 */
/**
 * Resolves a parent-prefixed field into a correlated EXISTS subquery.
 * Supports arbitrary depth: parent.field, parent.parent.field, etc.
 *
 * parent.mediaType = 'tv' →
 *   EXISTS (SELECT 1 FROM items p1
 *     LEFT JOIN media_entities p1e ON p1.entity_id = p1e.id
 *     WHERE p1.id = i.parent_id AND p1e.media_type = ?)
 *
 * parent.parent.mediaType = 'tv' →
 *   EXISTS (SELECT 1 FROM items p1
 *     JOIN items p2 ON p2.id = p1.parent_id
 *     LEFT JOIN media_entities p2e ON p2.entity_id = p2e.id
 *     WHERE p1.id = i.parent_id AND p2e.media_type = ?)
 *
 * JSON sub-paths (e.g., viewSettings.layout) are handled via json_extract().
 */
function compileParentCondition(field: string, op: string, value?: string | number | null): CompiledSql {
    const params: any[] = []
    const tables = new Set<string>()

    // Count parent depth and extract the remaining field path
    let depth = 0
    let remaining = field
    while (remaining.startsWith('parent.')) {
        depth++
        remaining = remaining.slice(7)
    }

    // p1 is the direct parent (anchored via WHERE p1.id = i.parent_id)
    // p2..pN are chained via JOINs
    const joins: string[] = []
    for (let d = 2; d <= depth; d++) {
        joins.push(`JOIN items p${d} ON p${d}.id = p${d - 1}.parent_id`)
    }
    const target = `p${depth}` // alias of the ancestor we're querying

    // Resolve the remaining field path against REPOSITORY_SCHEMA
    const parts = remaining.split('.')
    const schemaKey = parts[0]
    const def = REPOSITORY_SCHEMA[schemaKey]
    if (!def) return { sql: '1=1', params, tables }

    // Remap table aliases: i→target, e→targete, f→targetf, u→targetu
    const remap: Record<string, string> = {
        'i': target, 'e': `${target}e`, 'f': `${target}f`, 'u': `${target}u`,
    }

    // Join the related table on the target parent if needed
    if (def.table === 'e') {
        joins.push(`LEFT JOIN media_entities ${remap['e']} ON ${target}.entity_id = ${remap['e']}.id`)
    } else if (def.table === 'f') {
        joins.push(`LEFT JOIN folder_settings ${remap['f']} ON ${target}.id = ${remap['f']}.item_id`)
    } else if (def.table === 'u') {
        joins.push(`LEFT JOIN user_state ${remap['u']} ON ${target}.id = ${remap['u']}.item_id`)
    }

    // Remap the column SQL to the parent alias
    let columnSql = def.sql
    if (def.table) {
        columnSql = columnSql.replace(new RegExp(`\\b${def.table}\\.`, 'g'), `${remap[def.table]}.`)
    } else {
        columnSql = columnSql.replace(/\bi\./g, `${target}.`)
    }

    // Handle JSON sub-paths (e.g., viewSettings.layout)
    if (parts.length > 1 && def.isJson) {
        const jsonPath = '$.' + parts.slice(1).join('.')
        columnSql = `json_extract(${columnSql}, '${jsonPath}')`
    }

    // Build the inner condition
    let conditionSql: string
    switch (op) {
        case 'eq':         params.push(value); conditionSql = `${columnSql} = ?`; break
        case 'ne':         params.push(value); conditionSql = `${columnSql} != ?`; break
        case 'contains':   params.push(`%${value}%`); conditionSql = `${columnSql} LIKE ?`; break
        case 'notContains':params.push(`%${value}%`); conditionSql = `${columnSql} NOT LIKE ?`; break
        case 'gt':         params.push(value); conditionSql = `${columnSql} > ?`; break
        case 'gte':        params.push(value); conditionSql = `${columnSql} >= ?`; break
        case 'lt':         params.push(value); conditionSql = `${columnSql} < ?`; break
        case 'lte':        params.push(value); conditionSql = `${columnSql} <= ?`; break
        case 'isNull':     conditionSql = `${columnSql} IS NULL`; break
        case 'isNotNull':  conditionSql = `${columnSql} IS NOT NULL`; break
        case 'isEmpty':    conditionSql = `(${columnSql} IS NULL OR ${columnSql} = '')`; break
        case 'isNotEmpty': conditionSql = `(${columnSql} IS NOT NULL AND ${columnSql} != '')`; break
        default:           conditionSql = '1=1'; break
    }

    const joinClause = joins.length > 0 ? ' ' + joins.join(' ') : ''
    const sql = `EXISTS (SELECT 1 FROM items p1${joinClause} WHERE p1.id = i.parent_id AND ${conditionSql})`

    return { sql, params, tables }
}

export function compileConditionToSql(field: string, op: string, value?: string | number | null): CompiledSql {
    // Handle parent.* field references
    if (field.startsWith('parent.')) {
        return compileParentCondition(field, op, value)
    }

    const params: any[] = []
    const tables = new Set<string>()

    if (field === 'genre' || field === 'genres') {
        tables.add('e')
        const subquery = `SELECT 1 FROM entity_genres eg JOIN genres g ON eg.genre_id = g.id WHERE eg.entity_id = e.id`
        if (op === 'isNull' || op === 'isEmpty') return { sql: `NOT EXISTS (${subquery})`, params, tables }
        if (op === 'isNotNull' || op === 'isNotEmpty') return { sql: `EXISTS (${subquery})`, params, tables }
        if (op === 'contains') { params.push(`%${value}%`); return { sql: `EXISTS (${subquery} AND g.name LIKE ?)`, params, tables } }
        if (op === 'notContains') { params.push(`%${value}%`); return { sql: `NOT EXISTS (${subquery} AND g.name LIKE ?)`, params, tables } }
        if (op === 'ne') { params.push(value); return { sql: `NOT EXISTS (${subquery} AND g.name = ?)`, params, tables } }
        params.push(value)
        return { sql: `EXISTS (${subquery} AND g.name = ?)`, params, tables }
    }

    if (field.startsWith('tags.')) {
        const key = field.slice(5)
        tables.add('e')
        const subquery = `SELECT 1 FROM entity_tags WHERE entity_id = e.id AND key = ?`
        if (op === 'isNull' || op === 'isEmpty') { params.push(key); return { sql: `NOT EXISTS (${subquery})`, params, tables } }
        if (op === 'isNotNull' || op === 'isNotEmpty') { params.push(key); return { sql: `EXISTS (${subquery})`, params, tables } }
        if (op === 'contains') { params.push(key, `%${value}%`); return { sql: `EXISTS (${subquery} AND value LIKE ?)`, params, tables } }
        if (op === 'notContains') { params.push(key, `%${value}%`); return { sql: `NOT EXISTS (${subquery} AND value LIKE ?)`, params, tables } }
        if (op === 'ne') { params.push(key, value); return { sql: `NOT EXISTS (${subquery} AND value = ?)`, params, tables } }
        params.push(key, value)
        return { sql: `EXISTS (${subquery} AND value = ?)`, params, tables }
    }

    if (field.startsWith('vt.') || field.startsWith('virtualTags.')) {
        const key = field.split('.')[1]
        tables.add('e')
        const subquery = `SELECT 1 FROM entity_virtual_tags WHERE entity_id = e.id AND key = ?`
        if (op === 'isNull' || op === 'isEmpty') { params.push(key); return { sql: `NOT EXISTS (${subquery})`, params, tables } }
        if (op === 'isNotNull' || op === 'isNotEmpty') { params.push(key); return { sql: `EXISTS (${subquery})`, params, tables } }
        if (op === 'contains') { params.push(key, `%${value}%`); return { sql: `EXISTS (${subquery} AND value LIKE ?)`, params, tables } }
        if (op === 'notContains') { params.push(key, `%${value}%`); return { sql: `NOT EXISTS (${subquery} AND value LIKE ?)`, params, tables } }
        if (op === 'ne') { params.push(key, value); return { sql: `NOT EXISTS (${subquery} AND value = ?)`, params, tables } }
        params.push(key, value)
        return { sql: `EXISTS (${subquery} AND value = ?)`, params, tables }
    }

    const def = REPOSITORY_SCHEMA[field]
    if (!def) return { sql: '1=1', params, tables }
    if (def.table) tables.add(def.table)

    switch (op) {
        case 'eq':         params.push(value); return { sql: `${def.sql} = ?`, params, tables }
        case 'ne':         params.push(value); return { sql: `${def.sql} != ?`, params, tables }
        case 'contains':   params.push(`%${value}%`); return { sql: `${def.sql} LIKE ?`, params, tables }
        case 'notContains':params.push(`%${value}%`); return { sql: `${def.sql} NOT LIKE ?`, params, tables }
        case 'gt':         params.push(value); return { sql: `${def.sql} > ?`, params, tables }
        case 'gte':        params.push(value); return { sql: `${def.sql} >= ?`, params, tables }
        case 'lt':         params.push(value); return { sql: `${def.sql} < ?`, params, tables }
        case 'lte':        params.push(value); return { sql: `${def.sql} <= ?`, params, tables }
        case 'isNull':     return { sql: `${def.sql} IS NULL`, params, tables }
        case 'isNotNull':  return { sql: `${def.sql} IS NOT NULL`, params, tables }
        case 'isEmpty':    return { sql: `(${def.sql} IS NULL OR ${def.sql} = '')`, params, tables }
        case 'isNotEmpty': return { sql: `(${def.sql} IS NOT NULL AND ${def.sql} != '')`, params, tables }
        default:           return { sql: '1=1', params, tables }
    }
}

// =================================================================
// Compile condition groups (OR-of-AND) into a single SQL fragment
// =================================================================

function mergeTables(target: Set<string>, source: Set<string>): void {
    for (const t of source) target.add(t)
}

/**
 * Compiles an array of AND-groups (joined by OR) into a single CompiledSql.
 * Each group's conditions are AND-joined; groups are OR-joined.
 */
export function compileConditionGroups(groups: LibraryCondition[][]): CompiledSql {
    const allParams: any[] = []
    const tables = new Set<string>()

    if (groups.length === 0) return { sql: '', params: allParams, tables }

    const groupSqls: string[] = []
    for (const group of groups) {
        if (group.length === 0) {
            groupSqls.push('1=1')
            continue
        }
        const parts: string[] = []
        for (const cond of group) {
            const compiled = compileConditionToSql(cond.field, cond.op, cond.value)
            parts.push(compiled.sql)
            allParams.push(...compiled.params)
            mergeTables(tables, compiled.tables)
        }
        groupSqls.push(parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`)
    }

    const sql = groupSqls.length === 1 ? groupSqls[0] : `(${groupSqls.join(' OR ')})`
    return { sql, params: allParams, tables }
}

// =================================================================
// compileFilter: LibraryFilter → FindOptions (single code path)
// =================================================================

/**
 * Compiles a LibraryFilter into FindOptions for use with find() or buildFindQuery().
 *
 * Always adds `i.is_virtual = 0` — pool queries and vtag filters operate over
 * real items only, regardless of scope.
 *
 * Normalizes conditions/conditionGroups into OR-of-AND groups and compiles
 * them into a single CompiledSql fragment via compileConditionGroups.
 */
export function compileFilter(filter: LibraryFilter): FindOptions {
    // Manual scope: no dynamic children — return impossible condition
    if (filter.scope?.manual) {
        return { rawConditions: ['0 = 1'] }
    }

    const where: Record<string, any> = {}
    const rawConditions: string[] = ['i.is_virtual = 0']

    if (filter.scope?.parentId) {
        where.parentId = filter.scope.parentId
    }

    // Normalize: conditionGroups takes precedence over legacy conditions
    const groups = filter.conditionGroups ?? (filter.conditions ? [filter.conditions] : [])

    let compiledConditions: CompiledSql | undefined
    if (groups.length > 0) {
        compiledConditions = compileConditionGroups(groups)
    }

    return {
        where: Object.keys(where).length ? where : undefined,
        rawConditions,
        compiledConditions,
    }
}

// =================================================================
// buildWhereFragment: FindOptions → SQL conditions + params + tables
// =================================================================

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

    // typedWhere: still supported for manual FindOptions construction (parseFindOptions, etc.)
    if (options.typedWhere) {
        for (const { field, op, value } of options.typedWhere) {
            const compiled = compileConditionToSql(field, op, value)
            conditions.push(compiled.sql)
            params.push(...compiled.params)
            mergeTables(tables, compiled.tables)
        }
    }

    // compiledConditions: structured SQL from compileFilter (params tied to SQL)
    if (options.compiledConditions) {
        conditions.push(options.compiledConditions.sql)
        params.push(...options.compiledConditions.params)
        mergeTables(tables, options.compiledConditions.tables)
    }

    if (options.rawConditions) {
        for (const cond of options.rawConditions) {
            conditions.push(cond)
        }
    }

    return { conditions, params, tables }
}

// =================================================================
// buildFindQuery: FindOptions → full SELECT query
// =================================================================

/**
 * Compiles sortTop/sortBottom arrays into a compiledOrderPrefix for use in FindOptions.
 * Items in sortTop are ranked 0..N-1, items in sortBottom are ranked 1000..1000+M-1,
 * and everything else gets the middle rank N (sits between the two pinned groups).
 */
export function buildSortPinPrefix(
    sortTop?: string[],
    sortBottom?: string[]
): { sql: string; params: any[] } | undefined {
    if (!sortTop?.length && !sortBottom?.length) return undefined

    const caseParts: string[] = []
    const params: any[] = []
    let rank = 0

    for (const id of sortTop ?? []) {
        caseParts.push('WHEN i.id = ? THEN ?')
        params.push(id, rank++)
    }

    const middleRank = rank
    const bottomBase = middleRank + 1000

    for (let i = 0; i < (sortBottom?.length ?? 0); i++) {
        caseParts.push('WHEN i.id = ? THEN ?')
        params.push(sortBottom![i], bottomBase + i)
    }

    return {
        sql: `CASE ${caseParts.join(' ')} ELSE ${middleRank} END ASC`,
        params,
    }
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
        const clauses = Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy]
        for (const c of clauses) processField(c.field)
    }

    // compiledConditions may require table joins — register them before building JOINs
    if (options.compiledConditions) {
        mergeTables(usedTables, options.compiledConditions.tables)
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

    {
        const orderParts: string[] = []

        if (options.compiledOrderPrefix) {
            orderParts.push(options.compiledOrderPrefix.sql)
            params.push(...options.compiledOrderPrefix.params)
        }

        if (options.orderBy) {
            const clauses = Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy]
            for (const c of clauses) {
                const def = REPOSITORY_SCHEMA[c.field]
                if (!def) continue
                if (c.nullsLast) {
                    orderParts.push(`(CASE WHEN ${def.sql} IS NULL THEN 1 ELSE 0 END) ASC, ${def.sql} ${c.direction}`)
                } else {
                    orderParts.push(`${def.sql} ${c.direction}`)
                }
            }
        }

        if (orderParts.length > 0) {
            query += ` ORDER BY ${orderParts.join(', ')}`
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
