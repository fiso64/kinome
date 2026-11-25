import { playableFileMatchesSql } from './playable-files.sql'
import { localMediaFact, readMetadataFact, tmdbFact } from './metadata-facts.sql'
import { EFFECTIVE_METADATA } from './item-metadata.sql'
import { ITEM_READ_MODEL, withAccountLocations } from './media-read-model.sql'
import { isLocalMediaField, isTmdbFilterField, type LocalMediaField } from '@shared/metadata-fields'
import { REPOSITORY_SCHEMA } from './repo-definitions'
import { CORE_FIELDS } from '@shared/types'
import type { LibraryFilter } from '@shared/types'

/**
 * An operator-aware WHERE condition that maps to a REPOSITORY_SCHEMA field
 * or one of the special field namespaces (genre, tags.key, vt.key).
 */
export interface TypedWhereClause {
    field: string
    op: 'eq' | 'ne' | 'contains' | 'notContains' | 'gt' | 'gte' | 'lt' | 'lte' | 'isNull' | 'isNotNull' | 'isEmpty' | 'isNotEmpty'
    value?: string | number | null
}

export type FileCondition = TypedWhereClause & { field: LocalMediaField }

/**
 * A compiled SQL fragment with its bound params and required table joins.
 */
export interface CompiledSql {
    sql: string
    params: any[]
    tables: Set<string>
}

export interface OrderByClause {
    field?: string
    /** Raw SQL expression (e.g. 'RANDOM()'). When set, field/direction/nullsLast are ignored. */
    raw?: string
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
    /** When set, user_state is joined for this user (watched, lastWatched, etc.). */
    userId?: string
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
 *   EXISTS (SELECT 1 FROM media_items_read p1
 *     LEFT JOIN media_entities p1e ON p1.entity_id = p1e.id
 *     WHERE p1.id = i.parent_id AND p1e.media_type = ?)
 *
 * parent.parent.mediaType = 'tv' →
 *   EXISTS (SELECT 1 FROM media_items_read p1
 *     JOIN media_items_read p2 ON p2.id = p1.parent_id
 *     LEFT JOIN media_entities p2e ON p2.entity_id = p2e.id
 *     WHERE p1.id = i.parent_id AND p2e.media_type = ?)
 *
 * JSON sub-paths (e.g., viewSettings.layout) are handled via json_extract().
 */
function compileParentCondition(field: string, op: string, value?: string | number | null, scoped = false): CompiledSql {
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
        joins.push(`JOIN ${ITEM_READ_MODEL} p${d} ON p${d}.id = p${d - 1}.parent_id`)
    }
    const target = `p${depth}` // alias of the ancestor we're querying

    // Resolve the remaining field path against REPOSITORY_SCHEMA
    const parts = remaining.split('.')
    const schemaKey = parts[0]
    const condition = compileMediaCondition(remaining, target, op, value, scoped)
    if (condition) {
        return {
            sql: `EXISTS (SELECT 1 FROM ${ITEM_READ_MODEL} p1 ${joins.join(' ')}
                WHERE p1.id = i.parent_id AND ${condition.sql})`,
            params: condition.params,
            tables
        }
    }
    const def = REPOSITORY_SCHEMA[schemaKey]
    if (!def) return { sql: '1=1', params, tables }

    // Remap table aliases: i→target, e→targete, f→targetf, u→targetu
    const remap: Record<string, string> = {
        'i': target, 'e': `${target}e`, 'f': `${target}f`, 'u': `${target}u`,
    }

    // Join the related table on the target parent if needed
    if (def.table === 'e') {
        joins.push(`JOIN ${EFFECTIVE_METADATA} ${remap['e']} ON ${target}.id = ${remap['e']}.item_id`)
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
    const sql = `EXISTS (SELECT 1 FROM ${ITEM_READ_MODEL} p1${joinClause} WHERE p1.id = i.parent_id AND ${conditionSql})`

    return { sql, params, tables }
}

function compileMediaCondition(field: string, itemAlias: string, op: string, value?: string | number | null, scoped = false) {
    if (isTmdbFilterField(field)) {
        return compileStoredFactCondition(`${itemAlias}.entity_id`, tmdbFact(field), op, value, scoped)
    }
}

function compileStoredFactCondition(
    entity: string,
    fact: ReturnType<typeof tmdbFact>,
    op: string,
    value: string | number | null | undefined,
    scoped: boolean
) {
    const read = readMetadataFact(fact, 'fact', scoped)
    return compileFactCondition(entity, `SELECT ${read.owner} FROM ${read.source} WHERE ${read.present}`,
        read.value, fact.kind, op, value, scoped ? read.owner : undefined)
}

function compileMembership(entity: string, candidates: string, lookupKey?: string) {
    // For a small target set, probe facts by owner rather than building a library-wide set.
    const matching = (predicate = '') => lookupKey
        ? `EXISTS (${candidates} AND ${lookupKey} = ${entity}${predicate})`
        : `${entity} IN (${candidates}${predicate})`
    const excluding = (predicate = '') => lookupKey
        ? `NOT ${matching(predicate)}`
        : `(${entity} IS NULL OR ${entity} NOT IN (${candidates}${predicate}))`
    return { matching, excluding }
}

function compileFactCondition(
    entity: string,
    candidates: string,
    column: string,
    kind: 'text' | 'number' | 'list',
    op: string,
    value?: string | number | null,
    lookupKey?: string
): { sql: string; params: (string | number)[]; owners?: string } {
    const empty = op === 'isNull' || op === 'isEmpty'
    const present = op === 'isNotNull' || op === 'isNotEmpty'
    const relation = kind === 'list'
    const { matching, excluding } = compileMembership(entity, candidates, lookupKey)
    const include = (predicate = '', params: (string | number)[] = []) => ({
        sql: matching(predicate), params, owners: lookupKey ? undefined : candidates + predicate
    })
    const exclude = (predicate = '', params: (string | number)[] = []) => ({
        sql: excluding(predicate), params
    })

    if (empty || present) return empty ? exclude() : include()
    if (value == null) return { sql: '0', params: [] }
    if (op === 'contains' || op === 'notContains') {
        const like = ` AND ${column} LIKE ?`
        const params = [`%${value}%`]
        if (op === 'contains') return include(like, params)
        return relation ? exclude(like, params) : include(` AND ${column} NOT LIKE ?`, params)
    }

    if (relation && op !== 'eq' && op !== 'ne') return { sql: '0', params: [] }
    const valueToCompare = kind === 'number' ? Number(value) : value
    if (kind === 'number' && (String(value).trim() === '' || !Number.isFinite(valueToCompare))) return { sql: '0', params: [] }
    const operators = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }
    if (!Object.hasOwn(operators, op)) return { sql: '0', params: [] }
    return relation && op === 'ne' ? exclude(` AND ${column} = ?`, [valueToCompare])
        : include(` AND ${column} ${operators[op as keyof typeof operators]} ?`, [valueToCompare])
}

function compileTagCondition(field: string, op: string, value: string | number | null | undefined, scoped: boolean) {
    const custom = field.startsWith('tags.')
    const table = custom ? 'item_tags' : 'item_virtual_tags'
    const key = custom ? field.slice(5) : field.split('.')[1]
    const { matching, excluding } = compileMembership('i.id',
        `SELECT item_id FROM ${table} WHERE key = ?`, scoped ? 'item_id' : undefined)
    const params: (string | number | null | undefined)[] = [key]
    if (op === 'isNull' || op === 'isEmpty') return { sql: excluding(), params }
    if (op === 'isNotNull' || op === 'isNotEmpty') return { sql: matching(), params }
    if (op === 'contains' || op === 'notContains') {
        params.push(`%${value}%`)
        return { sql: (op === 'contains' ? matching : excluding)(' AND value LIKE ?'), params }
    }
    params.push(value)
    return { sql: (op === 'ne' ? excluding : matching)(' AND value = ?'), params }
}

export function compilePlayableFileMatches(
    conditions: readonly FileCondition[],
    options: { preferTitle?: boolean; targets?: string } = {}
) {
    const predicates = conditions.map(({ field, op, value }) =>
        compileStoredFactCondition('l.id', localMediaFact(field), op, value, !!options.targets))
    const seedIndex = predicates.findIndex(({ owners }) => owners !== undefined)
    const [seed] = seedIndex === -1 ? [] : predicates.splice(seedIndex, 1)
    // An affirmative predicate supplies candidate locations. Excluding facts
    // can also match locations with no value, so those still start from probes.
    const locationSeed = seed?.owners ? { sql: seed.owners, params: seed.params } : undefined
    return {
        sql: playableFileMatchesSql(predicates.length ? predicates.map(({ sql }) => sql).join(' AND ') : '1',
            { ...options, locations: locationSeed?.sql }),
        params: [...(locationSeed?.params ?? []), ...predicates.flatMap(({ params }) => params)],
        locationSeed
    }
}

export function getFileConditionTarget(field: string): { field: LocalMediaField; depth: number } | undefined {
    let depth = 0
    while (field.startsWith('parent.')) {
        field = field.slice(7)
        depth++
    }
    if (isLocalMediaField(field)) return { field, depth }
}

function compileFileConditions(conditions: FileCondition[], depth: number, targets?: string): CompiledSql {
    if (targets && depth > 0) {
        const ancestors = Array.from({ length: depth }, (_, index) =>
            `JOIN ${ITEM_READ_MODEL} a${index + 1} ON a${index + 1}.id = a${index}.parent_id`)
        targets = `SELECT a${depth}.id FROM (${targets}) target
            JOIN ${ITEM_READ_MODEL} a0 ON a0.id = target.id ${ancestors.join(' ')}`
    }
    const matches = compilePlayableFileMatches(conditions, { targets })
    const id = depth === 0 ? 'i.id' : `p${depth}.id`
    const predicate = `${id} IN (SELECT item_id FROM (${matches.sql}))`
    if (!depth) return { sql: predicate, params: matches.params, tables: new Set() }

    const joins: string[] = []
    for (let level = 2; level <= depth; level++) {
        joins.push(`JOIN ${ITEM_READ_MODEL} p${level} ON p${level}.id = p${level - 1}.parent_id`)
    }
    return {
        sql: `EXISTS (SELECT 1 FROM ${ITEM_READ_MODEL} p1 ${joins.join(' ')}
            WHERE p1.id = i.parent_id AND ${predicate})`,
        params: matches.params,
        tables: new Set()
    }
}

export function compileConditionToSql(field: string, op: TypedWhereClause['op'], value?: string | number | null, targets?: string): CompiledSql {
    const fileTarget = getFileConditionTarget(field)
    if (fileTarget) return compileFileConditions([{ field: fileTarget.field, op, value }], fileTarget.depth, targets)

    // Handle parent.* field references
    if (field.startsWith('parent.')) {
        return compileParentCondition(field, op, value, !!targets)
    }

    const params: any[] = []
    const tables = new Set<string>()

    const mediaCondition = compileMediaCondition(field, 'i', op, value, !!targets)
    if (mediaCondition) return { ...mediaCondition, tables }

    if (field === 'genre' || field === 'genres') {
        tables.add('e')
        const subquery = `SELECT 1 FROM json_each(e.genres_json) WHERE 1=1`
        if (op === 'isNull' || op === 'isEmpty') return { sql: `NOT EXISTS (${subquery})`, params, tables }
        if (op === 'isNotNull' || op === 'isNotEmpty') return { sql: `EXISTS (${subquery})`, params, tables }
        if (op === 'contains') { params.push(`%${value}%`); return { sql: `EXISTS (${subquery} AND value LIKE ?)`, params, tables } }
        if (op === 'notContains') { params.push(`%${value}%`); return { sql: `NOT EXISTS (${subquery} AND value LIKE ?)`, params, tables } }
        if (op === 'ne') { params.push(value); return { sql: `NOT EXISTS (${subquery} AND value = ?)`, params, tables } }
        params.push(value)
        return { sql: `EXISTS (${subquery} AND value = ?)`, params, tables }
    }

    if (field.startsWith('tags.') || field.startsWith('vt.') || field.startsWith('virtualTags.')) {
        return { ...compileTagCondition(field, op, value, !!targets), tables }
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
export function compileConditionGroups(groups: TypedWhereClause[][], targets?: string): CompiledSql {
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
        const fileGroups = new Map<number, FileCondition[]>()
        for (const cond of group) {
            const target = getFileConditionTarget(cond.field)
            if (target) {
                const conditions = fileGroups.get(target.depth) ?? []
                conditions.push({ ...cond, field: target.field })
                fileGroups.set(target.depth, conditions)
                continue
            }
            const compiled = compileConditionToSql(cond.field, cond.op, cond.value, targets)
            parts.push(compiled.sql)
            allParams.push(...compiled.params)
            mergeTables(tables, compiled.tables)
        }
        for (const [depth, conditions] of fileGroups) {
            const compiled = compileFileConditions(conditions, depth, targets)
            parts.push(compiled.sql)
            allParams.push(...compiled.params)
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
export function compileFilter(filter: LibraryFilter, { targets }: { targets?: string } = {}): FindOptions {
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
    let groups = filter.conditionGroups ?? (filter.conditions ? [filter.conditions] : [])
    let requiredConditions = filter.requiredConditions
    // Required file predicates must share the same witness as file predicates
    // in any matching OR branch when they refer to the same item.
    if (requiredConditions?.some(({ field }) => getFileConditionTarget(field))
        && groups.some((group) => group.some(({ field }) => getFileConditionTarget(field)))) {
        groups = groups.map((group) => [...group, ...requiredConditions!])
        requiredConditions = undefined
    }

    let compiledConditions: CompiledSql | undefined
    if (groups.length > 0) {
        compiledConditions = compileConditionGroups(groups, targets)
    }

    // requiredConditions are AND'd on top of the OR groups.
    // Wrap the groups in parens to preserve precedence: (A OR B OR C) AND (D AND E)
    if (requiredConditions?.length) {
        const required = compileConditionGroups([requiredConditions], targets)
        if (compiledConditions) {
            const tables = new Set([...compiledConditions.tables, ...required.tables])
            compiledConditions = {
                sql: `(${compiledConditions.sql}) AND (${required.sql})`,
                params: [...compiledConditions.params, ...required.params],
                tables,
            }
        } else {
            compiledConditions = required
        }
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
 * Exported so that write-path code (e.g. replaceVirtualTags) can
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
                conditions.push(`EXISTS (SELECT 1 FROM item_virtual_tags WHERE item_id = i.id AND key = ? AND value = ?)`)
                params.push(tagKey, value)
            } else if (key.startsWith('tags.')) {
                const tagKey = key.split('.')[1]
                conditions.push(`EXISTS (SELECT 1 FROM item_tags WHERE item_id = i.id AND key = ? AND value = ?)`)
                params.push(tagKey, value)
            } else if (key === 'genre' || key === 'genres') {
                tables.add('e')
                conditions.push(`EXISTS (SELECT 1 FROM json_each(e.genres_json) WHERE value = ?)`)
                params.push(value)
            }
        }
    }

    // typedWhere: still supported for manual FindOptions construction (parseFindOptions, etc.)
    if (options.typedWhere?.length) {
        const compiled = compileConditionGroups([options.typedWhere])
        conditions.push(compiled.sql)
        params.push(...compiled.params)
        mergeTables(tables, compiled.tables)
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
 * When options.userId is set, user_state is joined for that user (watched, lastWatched, etc.).
 * When absent, user_state fields resolve to NULL (join with impossible condition).
 */
export function buildFindQuery(options: FindOptions = {}): { query: string; params: any[] } {
    const userId = options.userId
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
            effectiveFields.add('virtualTags')
        } else if (field.startsWith('tags.')) {
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
        for (const c of clauses) if (c.field) processField(c.field)
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
        selectParts.push('e.metadata_item_id AS _entity_id')
    }

    for (const alias of finalFields) {
        const def = REPOSITORY_SCHEMA[alias]
        if (def) {
            selectParts.push(`${def.sql} AS ${alias}`)
        }
    }

    const selectClause = selectParts.join(', ')
    let query = `SELECT ${selectClause} FROM ${ITEM_READ_MODEL} i`
    const joinParams: any[] = []

    if (usedTables.has('e')) {
        query += ` JOIN ${EFFECTIVE_METADATA} e ON i.id = e.item_id`
    }
    if (usedTables.has('u')) {
        if (userId) {
            query += ` LEFT JOIN user_state u ON i.id = u.item_id AND u.user_id = ?`
            joinParams.push(userId)
        } else {
            // No user context — user state fields return NULL
            query += ` LEFT JOIN user_state u ON i.id = u.item_id AND 1=0`
        }
    }
    if (usedTables.has('f')) {
        query += ` LEFT JOIN folder_settings f ON i.id = f.item_id`
    }

    // Account visibility filter: pre-materialized visible item set.
    // Virtual items (is_virtual=1) always bypass the filter.
    // Accounts without a filter rule see everything (NOT EXISTS branch).
    if (userId) {
        query += ` LEFT JOIN account_visible_items avi ON avi.account_id = ? AND avi.item_id = i.id`
        joinParams.push(userId)
        conditions.push(
            `(i.is_virtual = 1 OR avi.item_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM account_filter_rules WHERE account_id = ?))`
        )
        params.push(userId)
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
                if (c.raw) {
                    orderParts.push(c.raw)
                    continue
                }
                const def = REPOSITORY_SCHEMA[c.field!]
                if (!def) continue
                if (c.nullsLast) {
                    orderParts.push(`(CASE WHEN ${def.sql} IS NULL THEN 1 ELSE 0 END) ASC, ${def.sql} ${c.direction}`)
                } else {
                    orderParts.push(`${def.sql} ${c.direction}`)
                }
            }
        }

        if (orderParts.length > 0) {
            // Final tiebreaker: keeps tied rows in a stable order across refetches and pages.
            const idSql = REPOSITORY_SCHEMA.id.sql
            if (!orderParts.some((part) => part.startsWith(`${idSql} `))) orderParts.push(`${idSql} ASC`)
            query += ` ORDER BY ${orderParts.join(', ')}`
        }
    }

    if (options.limit) {
        query += ` LIMIT ${options.limit}`
        if (options.offset) {
            query += ` OFFSET ${options.offset}`
        }
    }

    return userId
        ? { query: withAccountLocations(query, '?'), params: [userId, ...joinParams, ...params] }
        : { query, params: [...joinParams, ...params] }
}
