/**
 * SEARCH REPOSITORY
 * Handles FTS5 indexing and trigram search execution.
 */
import {
    EFFECTIVE_METADATA, effectiveMetadataColumn, FTS_TABLE, ITEM_METADATA_JOINS, REBUILD_SEARCH_INDEX_SQL, SEARCH_RANK_WEIGHTS
} from '../item-metadata.sql'
import { getDb, runTransaction } from '../client'
import { getMetadataSearchField, isFileScopedField } from '@shared/metadata-fields'
import { compileConditionToSql, compilePlayableFileMatches, type FileCondition } from '../query-builder'
import { accountItemVisibilitySql, ITEM_READ_MODEL, withAccountLocations } from '../media-read-model.sql'
import { hasFilterRule } from './account-filter.repo'

const TITLE_PRIORITY = `CASE WHEN ${effectiveMetadataColumn('media_type')} IN ('movie', 'tv') THEN 0 ELSE 1 END`
const EFFECTIVE_TITLE = effectiveMetadataColumn('title')

/**
 * Rebuilds the Full-Text Search index.
 */
export function rebuildFtsIndex(): void {
    runTransaction(() => getDb().exec(REBUILD_SEARCH_INDEX_SQL))
}

/**
 * Executes a raw SQL search query.
 */
export function executeSearchSql(sql: string, params: any): any[] {
    const db = getDb()
    return db.prepare(sql).all(params) as any[]
}

/**
 * Checks for FTS index count.
 */
export function getFtsIndexCount(): { count: number; itemCount: number } {
    const db = getDb()
    const count = db.prepare(`SELECT count(*) as c FROM ${FTS_TABLE}`).get() as { c: number }
    const itemCount = db.prepare('SELECT count(*) as c FROM media_items').get() as { c: number }
    return { count: count.c, itemCount: itemCount.c }
}

// Shared SELECT columns for search results
const SEARCH_SELECT = `
    i.id, i.type, i.name, i.path,
    e.title, e.overview, e.media_type, e.year, e.tmdb_runtime,
    e.poster_path, e.backdrop_path, e.logo_path,
    e.episode_number,
    e.genres_json AS genres_json,
    (SELECT json_group_object(t.key, t.value) FROM item_tags t WHERE t.item_id = i.id) AS tags_json,
    (SELECT json_group_object(vt.key, vt.value) FROM item_virtual_tags vt WHERE vt.item_id = i.id) AS virtual_tags_json,
    u.watched`

/**
 * Appends the account visibility filter to a search SQL query.
 * Virtual items bypass the filter; accounts without a rule see everything.
 */
function appendVisibilityFilter(sql: string, params: SearchParams, userId?: string): string {
    if (!userId) return sql
    params['@visibilityAccount'] = userId
    return `${sql} AND (i.is_virtual = 1 OR ${accountItemVisibilitySql('@visibilityAccount', 'i.id')})`
}

/**
 * Appends tag filter conditions to a search SQL query.
 * Shared by all search functions to avoid duplication.
 */
function appendTagFilters(
    sql: string,
    params: Record<string, any>,
    tags: { key: string; value: string }[],
    narrowText = false
): string {
    tags.forEach((tag, idx) => {
        const pKey = `@tagVal${idx}`
        const tagValue = tag.value.toLowerCase()

        const field = getMetadataSearchField(tag.key)
        if (field && isFileScopedField(field)) return
        if (field === 'mediaType') {
            sql += ` AND ${effectiveMetadataColumn('media_type')} = ${pKey}`
            params[pKey] = tagValue
        } else if (field === 'year') {
            sql += ` AND ${effectiveMetadataColumn('year')} = ${pKey}`
            params[pKey] = parseInt(tagValue) || 0
        } else if (field === 'genre') {
            const pVal = `@genreVal${idx}`
            params[pVal] = tagValue
            sql += ` AND CASE WHEN m.genres_json IS NULL THEN EXISTS (
                SELECT 1 FROM entity_genres eg JOIN genres g ON g.id = eg.genre_id
                WHERE eg.entity_id = e.id AND lower(g.name) = ${pVal}
            ) ELSE EXISTS (
                SELECT 1 FROM json_each(m.genres_json) WHERE lower(value) = ${pVal}
            ) END`
        } else if (field === 'person') {
            const pVal = `@personVal${idx}`
            params[pVal] = `%${tagValue}%`
            sql += narrowText
                ? ` AND EXISTS (SELECT 1 FROM credits c JOIN people p ON p.id = c.person_id
                    WHERE c.entity_id = e.id AND lower(p.name) LIKE ${pVal})`
                : ` AND i.entity_id IN (SELECT c.entity_id FROM people p
                    CROSS JOIN credits c ON c.person_id = p.id WHERE lower(p.name) LIKE ${pVal})`
        } else if (field) {
            const condition = compileConditionToSql(field, 'eq', tag.value)
            sql += ` AND ${condition.sql.replace('?', pKey)}`
            if (condition.params.length) params[pKey] = condition.params[0]
        } else {
            // Custom tag or virtual tag
            const pValKey = `@tagVal${idx}`
            const pValLikeKey = `@tagValLike${idx}`
            const pTagKey = `@tagKey${idx}`
            params[pValKey] = tagValue
            params[pValLikeKey] = `%${tagValue}%`
            params[pTagKey] = tag.key
            sql += ` AND i.id IN (
                    SELECT item_id FROM item_tags
                    WHERE key = ${pTagKey} AND (lower(value) = ${pValKey} OR lower(value) LIKE ${pValLikeKey})
                    UNION ALL
                    SELECT item_id FROM item_virtual_tags
                    WHERE key = ${pTagKey} AND lower(value) = ${pValKey}
                )`
        }
    })
    return sql
}
type SearchTag = { key: string; value: string }
type SearchParams = Record<string, string | number | null>

function searchFileFilter(tags: SearchTag[]) {
    const conditions: FileCondition[] = []
    let preferTitle = true
    for (const tag of tags) {
        const field = getMetadataSearchField(tag.key)
        if (field && isFileScopedField(field)) conditions.push({ field, op: 'eq', value: tag.value })
        if (field === 'mediaType' && ['season', 'episode'].includes(tag.value.toLowerCase())) preferTitle = false
    }
    return conditions.length ? { conditions, preferTitle } : undefined
}

function searchFileQuery(
    matches: ReturnType<typeof compilePlayableFileMatches>,
    params: SearchParams
) {
    let index = 0
    return matches.sql.replace(/\?/g, () => {
        const parameter = `@fileMatch${index}`
        params[parameter] = matches.params[index++]
        return parameter
    })
}

function searchFileDetails(sql: string) {
    return `search_file_details AS (
        SELECT m.item_id,
               json_group_array(json_object('id', m.file_id, 'title',
                   CASE WHEN parent.media_kind = 'season' THEN parent.name || ' / ' || file.name ELSE file.name END
               ) ORDER BY parent.name, file.name, file.id) AS matching_files
        FROM (${sql}) m CROSS JOIN media_items file
        LEFT JOIN media_items parent ON parent.id = file.parent_item_id
        WHERE file.id = m.file_id
        GROUP BY m.item_id
    )`
}

function querySearch(sql: string, params: SearchParams, userId?: string, ctes: string[] = []): any[] {
    const withClause = ctes.join(', ')
    if (!userId) return getDb().prepare(withClause ? `WITH ${withClause} ${sql}` : sql).all(params)
    return getDb().prepare(withAccountLocations(sql, '@locationAccount', withClause))
        .all({ ...params, '@locationAccount': userId })
}

interface SearchQuery {
    from: string
    where?: string
    order: string[]
    ctes?: string[]
    params?: SearchParams
    narrowText?: boolean
    ftsMatch?: string
}

function hasDenseTitleSample(match: string, fileFilter: ReturnType<typeof searchFileFilter>, limit: number, sampleSize: number) {
    const params: SearchParams = { '@match': match, '@sampleSize': sampleSize, '@enough': limit * 2 }
    const ctes = [`sample AS MATERIALIZED (
        SELECT i.id FROM ${FTS_TABLE}
        CROSS JOIN media_items i ON i.search_document_id = ${FTS_TABLE}.rowid
        WHERE ${FTS_TABLE} MATCH @match LIMIT @sampleSize
    )`]
    if (fileFilter) {
        const scoped = compilePlayableFileMatches(fileFilter.conditions, {
            preferTitle: fileFilter.preferTitle,
            targets: 'SELECT id FROM sample'
        })
        ctes.push(`sample_files AS (${searchFileQuery(scoped, params)})`)
    }
    const [row] = querySearch(`
        SELECT count(*) >= @enough AS dense
        FROM sample CROSS JOIN media_items i ON i.id = sample.id
        ${ITEM_METADATA_JOINS}
        WHERE i.is_hidden = 0 AND ${TITLE_PRIORITY} = 0
        ${fileFilter ? 'AND i.id IN (SELECT item_id FROM sample_files)' : ''}
    `, params, undefined, ctes)
    return row.dense === 1
}

function search(query: SearchQuery, tags: SearchTag[], limit: number, userId?: string): any[] {
    const watchParams = { '@watchUser': userId ?? null }
    const params = { ...query.params, ...watchParams, '@limit': limit }
    const baseCtes = query.ctes ?? []
    const fileFilter = searchFileFilter(tags)
    const fullFileMatches = fileFilter && compilePlayableFileMatches(fileFilter.conditions, fileFilter)
    const seed = fullFileMatches?.locationSeed
    const probeSize = Number.isInteger(limit) && limit > 0 && limit <= 256 ? Math.min(limit * 4, 256) : 0
    const locationCount = seed ? getDb().query<{ count: number }, (string | number)[]>(`
        SELECT count(*) AS count FROM (${seed.sql} LIMIT ?)
    `).get(...seed.params, probeSize || 1)?.count : undefined
    if (locationCount === 0) return []

    const fileFirst = query.ftsMatch && locationCount !== undefined && locationCount < probeSize
    // Keep the ordering identical before and after applying a file filter.
    const order = [TITLE_PRIORITY, ...query.order, 'i.id']
    const columns = order.map((expression, index) => `${expression} AS sort_${index}`)
    const sortKeys = order.map((_expression, index) => `sort_${index}`).join(', ')
    let where = `WHERE i.is_hidden = 0 ${query.where ?? ''}`
    where = appendTagFilters(where, params, tags, query.narrowText)
    where = appendVisibilityFilter(where, params, userId)

    const rankCandidates = (probe: boolean, nativeTitles = false) => `
        SELECT i.id${nativeTitles ? '' : `, ${columns.join(', ')}`}
        FROM ${!probe && fileFirst ? `(SELECT DISTINCT item_id FROM file_matches) candidate
            CROSS JOIN media_items i ON i.id = candidate.item_id
            CROSS JOIN ${FTS_TABLE} ON ${FTS_TABLE}.rowid = i.search_document_id` : query.from}
        ${ITEM_METADATA_JOINS}
        ${where} ${probe ? '' : `AND EXISTS (SELECT 1 FROM ${ITEM_READ_MODEL} eligible
            WHERE eligible.id = i.id AND eligible.is_hidden = 0 AND eligible.is_ignored = 0)`}
        ${!probe && fileFilter && !fileFirst ? 'AND i.id IN (SELECT item_id FROM file_matches)' : ''}
        ${nativeTitles ? `AND ${TITLE_PRIORITY} = 0 AND ${FTS_TABLE}.rank MATCH 'bm25(${SEARCH_RANK_WEIGHTS})'` : ''}
        ORDER BY ${nativeTitles ? `${FTS_TABLE}.rank` : sortKeys}
    `
    const projectResults = (sort: string, matchFiles: boolean) => `
        SELECT ${SEARCH_SELECT}
               ${matchFiles ? ', fm.matching_files' : ''}
        FROM ranked
        ${matchFiles ? 'JOIN search_file_details fm ON fm.item_id = ranked.id' : ''}
        CROSS JOIN ${ITEM_READ_MODEL} i ON i.id = ranked.id
        JOIN ${EFFECTIVE_METADATA} e ON e.item_id = i.id
        LEFT JOIN user_state u ON u.item_id = i.id AND u.user_id = @watchUser
        WHERE i.is_hidden = 0 AND i.is_ignored = 0
        ORDER BY ${sort}
        LIMIT @limit
    `

    // When file facts are selective, start from their index. Otherwise defer
    // file and location checks until we have a ranked prefix of the item set.
    if (probeSize && (locationCount === undefined || locationCount >= probeSize)) {
        // FTS5 can order titles by weighted rank without sorting joined rows.
        // An entire page of titles outranks every non-title hit.
        const nativeTitles = !!query.ftsMatch && probeSize >= limit * 2
            && tags.every(({ key }) => {
                const field = getMetadataSearchField(key)
                return field && isFileScopedField(field)
            })
            && (!userId || !hasFilterRule(userId))
            && hasDenseTitleSample(query.ftsMatch, fileFilter, limit, probeSize)
        const prefix = querySearch(`${rankCandidates(true, nativeTitles)} LIMIT @probeSize`,
            { ...params, '@probeSize': probeSize }, undefined, baseCtes)
        if (prefix.length === 0 && !nativeTitles) return []
        const scopedParams: SearchParams = { ...watchParams, '@limit': limit }
        const rows = prefix.map(({ id }, index) => {
            scopedParams[`@id${index}`] = id
            return `(@id${index}, ${index})`
        })
        const ctes = [`ranked(id, position) AS (VALUES ${rows.join(', ')})`]
        if (fileFilter) {
            const scoped = compilePlayableFileMatches(fileFilter.conditions, {
                preferTitle: fileFilter.preferTitle,
                targets: 'SELECT id FROM ranked'
            })
            ctes.push(searchFileDetails(searchFileQuery(scoped, scopedParams)))
        }
        const results = prefix.length ? querySearch(projectResults('ranked.position', !!fileFilter), scopedParams, userId, ctes) : []
        if (results.length === limit || (!nativeTitles && prefix.length < probeSize)) return results
    }

    const ctes = [...baseCtes]
    if (fullFileMatches) ctes.push(`file_matches AS MATERIALIZED (${searchFileQuery(fullFileMatches, params)})`)
    ctes.push(`ranked AS MATERIALIZED (${rankCandidates(false)} LIMIT @limit)`)
    if (fileFilter) ctes.push(searchFileDetails(`
        SELECT m.item_id, m.file_id
        FROM file_matches m WHERE m.item_id IN (SELECT id FROM ranked)
    `))
    return querySearch(projectResults(sortKeys, !!fileFilter), params, userId, ctes)
}

/** Finds items matching a short text query (LIKE). */
export function findByShortQuery(normalized: string, tags: SearchTag[], limit: number, userId?: string): any[] {
    const params: SearchParams = {
        '@likeQuery': `%${normalized}%`,
        '@startQuery': `${normalized.toLowerCase()}%`
    }
    // The same index stores the current item name and effective title. A short
    // LIKE scan reads those columns without joining metadata for every item.
    const candidates = `text_candidates AS MATERIALIZED (
        SELECT rowid FROM ${FTS_TABLE} WHERE name LIKE @likeQuery OR title LIKE @likeQuery
    )`
    return search({
        from: 'text_candidates candidate CROSS JOIN media_items i ON i.search_document_id = candidate.rowid',
        order: [`CASE
            WHEN lower(coalesce(${EFFECTIVE_TITLE}, '')) LIKE @startQuery THEN 1
            WHEN lower(coalesce(${EFFECTIVE_TITLE}, '')) LIKE @likeQuery THEN 2
            WHEN lower(i.name) LIKE @startQuery THEN 3
            ELSE 4
        END`, EFFECTIVE_TITLE, 'i.name'],
        params,
        ctes: [candidates]
    }, tags, limit, userId)
}

/** Finds items using FTS5 match query with tag filtering. */
export function findByFtsQuery(matchQuery: string, tags: SearchTag[], limit: number, userId?: string): any[] {
    // A few text hits can check their own credits. A broad hit set starts from
    // matching people so it does not walk the casts of unrelated titles.
    const creditLookupBudget = 64
    const narrowText = tags.some(({ key }) => getMetadataSearchField(key) === 'person')
        && (getDb().query<{ count: number }, [string, number]>(`
            SELECT count(*) AS count FROM (SELECT 1 FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ? LIMIT ?)
        `).get(matchQuery, creditLookupBudget)?.count ?? creditLookupBudget) < creditLookupBudget
    return search({
        from: `${FTS_TABLE} CROSS JOIN media_items i ON i.search_document_id = ${FTS_TABLE}.rowid`,
        where: `AND ${FTS_TABLE} MATCH @matchQuery`,
        order: [`bm25(${FTS_TABLE}, ${SEARCH_RANK_WEIGHTS})`],
        params: { '@matchQuery': matchQuery },
        narrowText,
        ftsMatch: matchQuery
    }, tags, limit, userId)
}

/** Finds items with no text query, only tag filtering. */
export function findByTagsOnly(tags: SearchTag[], limit: number, userId?: string): any[] {
    return search({ from: 'media_items i', order: [EFFECTIVE_TITLE, 'i.name'] }, tags, limit, userId)
}
