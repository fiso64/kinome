/**
 * SEARCH REPOSITORY
 * Handles FTS5 indexing and trigram search execution.
 */
import {
    EFFECTIVE_METADATA, effectiveMetadataColumn, FTS_TABLE, ITEM_METADATA_JOINS, REBUILD_SEARCH_INDEX_SQL, SEARCH_RANK_WEIGHTS
} from '../item-metadata.sql'
import { getDb, runTransaction } from '../client'
import { getMetadataSearchField, isLocalMediaField } from '@shared/metadata-fields'
import { compileConditionToSql, compilePlayableFileMatches, type FileCondition } from '../query-builder'
import { accountItemVisibilitySql, ITEM_READ_MODEL, withAccountLocations } from '../media-read-model.sql'
import { hasFilterRule } from './account-filter.repo'

const TITLE_PRIORITY = `CASE WHEN ${effectiveMetadataColumn('media_type')} IN ('movie', 'tv') THEN 0 ELSE 1 END`
const EFFECTIVE_TITLE = effectiveMetadataColumn('title')
const MAX_RANKED_PREFIX = 256
const CREDIT_LOOKUP_BUDGET = 64

type SearchTag = { key: string; value: string }
type ResolvedTag = SearchTag & { field: ReturnType<typeof getMetadataSearchField> }
type SearchParams = Record<string, string | number | null>
type RankedItem = { id: string }
type RankMode = 'prefix' | 'titles' | 'complete'

/**
 * Rebuilds the Full-Text Search index.
 */
export function rebuildFtsIndex(): void {
    runTransaction(() => getDb().exec(REBUILD_SEARCH_INDEX_SQL))
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
    params: SearchParams,
    tags: ResolvedTag[],
    narrowText = false
): string {
    tags.forEach((tag, idx) => {
        const pKey = `@tagVal${idx}`
        const tagValue = tag.value.toLowerCase()

        const { field } = tag
        if (field && isLocalMediaField(field)) return
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
function searchFileFilter(tags: ResolvedTag[]) {
    const conditions: FileCondition[] = []
    let preferTitle = true
    for (const { field, value } of tags) {
        if (field && isLocalMediaField(field)) conditions.push({ field, op: 'eq', value })
        if (field === 'mediaType' && ['season', 'episode'].includes(value.toLowerCase())) preferTitle = false
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

function querySearch<Row = any>(sql: string, params: SearchParams, userId?: string, ctes: string[] = []): Row[] {
    const withClause = ctes.join(', ')
    if (!userId) return getDb().prepare<Row, SearchParams>(withClause ? `WITH ${withClause} ${sql}` : sql).all(params)
    return getDb().prepare<Row, SearchParams>(withAccountLocations(sql, '@locationAccount', withClause))
        .all({ ...params, '@locationAccount': userId })
}

interface SearchQuery {
    from: string
    where?: string
    order: string[]
    ctes?: string[]
    params?: SearchParams
    ftsMatch?: string
}

function hasFewTextMatches(match: string): boolean {
    const row = getDb().query<{ count: number }, [string, number]>(`
        SELECT count(*) AS count FROM (SELECT 1 FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ? LIMIT ?)
    `).get(match, CREDIT_LOOKUP_BUDGET)
    return !!row && row.count < CREDIT_LOOKUP_BUDGET
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
    const [row] = querySearch<{ dense: number }>(`
        SELECT count(*) >= @enough AS dense
        FROM sample CROSS JOIN media_items i ON i.id = sample.id
        ${ITEM_METADATA_JOINS}
        WHERE i.is_hidden = 0 AND ${TITLE_PRIORITY} = 0
        ${fileFilter ? 'AND i.id IN (SELECT item_id FROM sample_files)' : ''}
    `, params, undefined, ctes)
    return row.dense === 1
}

function searchResultsSql(order: string, matchFiles: boolean, includeTotal = false): string {
    return `
        SELECT ${SEARCH_SELECT}
               ${matchFiles ? ', fm.matching_files' : ''}
               ${includeTotal ? ', count(*) OVER () AS total_count' : ''}
        FROM ranked
        ${matchFiles ? 'JOIN search_file_details fm ON fm.item_id = ranked.id' : ''}
        CROSS JOIN ${ITEM_READ_MODEL} i ON i.id = ranked.id
        JOIN ${EFFECTIVE_METADATA} e ON e.item_id = i.id
        LEFT JOIN user_state u ON u.item_id = i.id AND u.user_id = @watchUser
        WHERE i.is_hidden = 0 AND i.is_ignored = 0
        ORDER BY ${order}
        LIMIT @limit
    `
}

function readRankedPrefix(
    prefix: RankedItem[],
    fileFilter: ReturnType<typeof searchFileFilter>,
    params: SearchParams,
    userId?: string,
    includeTotal = false
): any[] {
    if (prefix.length === 0) return []
    const rows = prefix.map(({ id }, index) => {
        params[`@id${index}`] = id
        return `(@id${index}, ${index})`
    })
    const ctes = [`ranked(id, position) AS (VALUES ${rows.join(', ')})`]
    if (fileFilter) {
        const scoped = compilePlayableFileMatches(fileFilter.conditions, {
            preferTitle: fileFilter.preferTitle,
            targets: 'SELECT id FROM ranked'
        })
        ctes.push(searchFileDetails(searchFileQuery(scoped, params)))
    }
    return querySearch(searchResultsSql('ranked.position', !!fileFilter, includeTotal), params, userId, ctes)
}

function search(query: SearchQuery, inputTags: SearchTag[], limit: number, userId?: string, includeTotal = false): any[] {
    const tags = inputTags.map(tag => ({ ...tag, field: getMetadataSearchField(tag.key) }))
    const watchParams = { '@watchUser': userId ?? null }
    const params = { ...query.params, ...watchParams, '@limit': limit }
    const baseCtes = query.ctes ?? []
    const fileFilter = searchFileFilter(tags)
    const fullFileMatches = fileFilter && compilePlayableFileMatches(fileFilter.conditions, fileFilter)
    const seed = fullFileMatches?.locationSeed
    const probeSize = Number.isInteger(limit) && limit > 0 && limit <= MAX_RANKED_PREFIX
        ? Math.min(limit * 4, MAX_RANKED_PREFIX)
        : 0
    const locationCount = seed ? getDb().query<{ count: number }, (string | number)[]>(`
        SELECT count(*) AS count FROM (${seed.sql} LIMIT ?)
    `).get(...seed.params, probeSize || 1)?.count : undefined
    if (locationCount === 0) return []

    const fileFirst = query.ftsMatch && locationCount !== undefined && locationCount < probeSize
    // Keep the ordering identical before and after applying a file filter.
    const order = [TITLE_PRIORITY, ...query.order, 'i.id']
    const columns = order.map((expression, index) => `${expression} AS sort_${index}`)
    const sortKeys = order.map((_expression, index) => `sort_${index}`).join(', ')
    // Selective text queries can check their own credits. Broad queries start from matching people.
    const narrowText = !!query.ftsMatch && tags.some(({ field }) => field === 'person') && hasFewTextMatches(query.ftsMatch)
    let where = `WHERE i.is_hidden = 0 ${query.where ?? ''}`
    where = appendTagFilters(where, params, tags, narrowText)
    where = appendVisibilityFilter(where, params, userId)

    const rankCandidates = (mode: RankMode) => `
        SELECT i.id${mode === 'titles' ? '' : `, ${columns.join(', ')}`}
        FROM ${mode === 'complete' && fileFirst ? `(SELECT DISTINCT item_id FROM file_matches) candidate
            CROSS JOIN media_items i ON i.id = candidate.item_id
            CROSS JOIN ${FTS_TABLE} ON ${FTS_TABLE}.rowid = i.search_document_id` : query.from}
        ${ITEM_METADATA_JOINS}
        ${where} ${mode === 'complete' ? `AND EXISTS (SELECT 1 FROM ${ITEM_READ_MODEL} eligible
            WHERE eligible.id = i.id AND eligible.is_hidden = 0 AND eligible.is_ignored = 0)` : ''}
        ${mode === 'complete' && fileFilter && !fileFirst ? 'AND i.id IN (SELECT item_id FROM file_matches)' : ''}
        ${mode === 'titles' ? `AND ${TITLE_PRIORITY} = 0 AND ${FTS_TABLE}.rank MATCH 'bm25(${SEARCH_RANK_WEIGHTS})'` : ''}
        ORDER BY ${mode === 'titles' ? `${FTS_TABLE}.rank` : sortKeys}
    `

    // When file facts are selective, start from their index. Otherwise defer
    // file and location checks until we have a ranked prefix of the item set.
    if (probeSize && (locationCount === undefined || locationCount >= probeSize)) {
        // FTS5 can order titles by weighted rank without sorting joined rows.
        // An entire page of titles outranks every non-title hit.
        const nativeTitles = !!query.ftsMatch && probeSize >= limit * 2
            && tags.every(({ field }) => field && isLocalMediaField(field))
            && (!userId || !hasFilterRule(userId))
            && hasDenseTitleSample(query.ftsMatch, fileFilter, limit, probeSize)
        const prefix = querySearch<RankedItem>(`${rankCandidates(nativeTitles ? 'titles' : 'prefix')} LIMIT @probeSize`,
            { ...params, '@probeSize': probeSize }, undefined, baseCtes)
        const exhausted = !nativeTitles && prefix.length < probeSize
        // A complete prefix can yield an exact total without traversing any
        // more candidates. The window counts only visible, matching rows.
        const results = readRankedPrefix(prefix, fileFilter, { ...watchParams, '@limit': limit }, userId,
            includeTotal && exhausted && prefix.length > limit)
        if (results.length === limit || exhausted) return results
    }

    const ctes = [...baseCtes]
    if (fullFileMatches) ctes.push(`file_matches AS MATERIALIZED (${searchFileQuery(fullFileMatches, params)})`)
    ctes.push(`ranked AS MATERIALIZED (${rankCandidates('complete')} LIMIT @limit)`)
    if (fileFilter) ctes.push(searchFileDetails(`
        SELECT m.item_id, m.file_id
        FROM file_matches m WHERE m.item_id IN (SELECT id FROM ranked)
    `))
    return querySearch(searchResultsSql(sortKeys, !!fileFilter), params, userId, ctes)
}

/** Finds items matching a short text query (LIKE). */
export function findByShortQuery(normalized: string, tags: SearchTag[], limit: number, userId?: string, includeTotal = false): any[] {
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
    }, tags, limit, userId, includeTotal)
}

/** Finds items using FTS5 match query with tag filtering. */
export function findByFtsQuery(matchQuery: string, tags: SearchTag[], limit: number, userId?: string, includeTotal = false): any[] {
    return search({
        from: `${FTS_TABLE} CROSS JOIN media_items i ON i.search_document_id = ${FTS_TABLE}.rowid`,
        where: `AND ${FTS_TABLE} MATCH @matchQuery`,
        order: [`bm25(${FTS_TABLE}, ${SEARCH_RANK_WEIGHTS})`],
        params: { '@matchQuery': matchQuery },
        ftsMatch: matchQuery
    }, tags, limit, userId, includeTotal)
}

/** Finds items with no text query, only tag filtering. */
export function findByTagsOnly(tags: SearchTag[], limit: number, userId?: string, includeTotal = false): any[] {
    return search({ from: 'media_items i', order: [EFFECTIVE_TITLE, 'i.name'] }, tags, limit, userId, includeTotal)
}
