/**
 * SEARCH REPOSITORY
 * Handles FTS5 indexing and trigram search execution.
 */
import { getDb, runTransaction } from '../client'

/**
 * Rebuilds the Full-Text Search index.
 */
export function rebuildFtsIndex(): void {
    const db = getDb()
    runTransaction(() => {
        db.prepare('DELETE FROM items_fts').run()
        db.prepare(
            `
      INSERT INTO items_fts (id, name, title, original_title, overview)
      SELECT 
        i.id, i.name, 
        e.title, e.original_title, e.overview
      FROM items i
      LEFT JOIN media_entities e ON i.entity_id = e.id
    `
        ).run()
    })
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
    const count = db.prepare('SELECT count(*) as c FROM items_fts').get() as { c: number }
    const itemCount = db.prepare('SELECT count(*) as c FROM items').get() as { c: number }
    return { count: count.c, itemCount: itemCount.c }
}

// Shared SELECT columns for search results
const SEARCH_SELECT = `
    i.id, i.type, i.name, i.path,
    e.title, e.overview, e.media_type, e.year,
    e.poster_path, e.backdrop_path, e.logo_path,
    e.episode_number,
    (SELECT json_group_array(g.name) FROM entity_genres eg JOIN genres g ON eg.genre_id = g.id WHERE eg.entity_id = e.id) AS genres_json,
    (SELECT json_group_object(t.key, t.value) FROM entity_tags t WHERE t.entity_id = e.id) AS tags_json,
    (SELECT json_group_object(vt.key, vt.value) FROM entity_virtual_tags vt WHERE vt.entity_id = e.id) AS virtual_tags_json,
    u.watched`

/**
 * Appends the account visibility filter to a search SQL query.
 * Virtual items bypass the filter; accounts without a rule see everything.
 */
function appendVisibilityFilter(sql: string, params: Record<string, any>, userId?: string): string {
    if (!userId) return sql
    params['@visUserId'] = userId
    params['@visRuleUserId'] = userId
    return (
        sql +
        ` AND (i.is_virtual = 1
      OR EXISTS (SELECT 1 FROM account_visible_items WHERE account_id = @visUserId AND item_id = i.id)
      OR NOT EXISTS (SELECT 1 FROM account_filter_rules WHERE account_id = @visRuleUserId))`
    )
}

/**
 * Appends tag filter conditions to a search SQL query.
 * Shared by all search functions to avoid duplication.
 */
function appendTagFilters(
    sql: string,
    params: Record<string, any>,
    tags: { key: string; value: string }[]
): string {
    tags.forEach((tag, idx) => {
        const pKey = `@tagVal${idx}`
        const tagValue = tag.value.toLowerCase()

        if (tag.key === 'mediaType') {
            sql += ` AND e.media_type = ${pKey}`
            params[pKey] = tagValue
        } else if (tag.key === 'year') {
            sql += ` AND e.year = ${pKey}`
            params[pKey] = parseInt(tagValue) || 0
        } else if (tag.key === 'genre') {
            const pVal = `@genreVal${idx}`
            params[pVal] = tagValue
            sql += ` AND EXISTS (SELECT 1 FROM entity_genres eg JOIN genres g ON eg.genre_id = g.id WHERE eg.entity_id = e.id AND lower(g.name) = ${pVal})`
        } else if (tag.key === 'person') {
            const pVal = `@personVal${idx}`
            params[pVal] = `%${tagValue}%`
            sql += ` AND EXISTS (SELECT 1 FROM credits c JOIN people p ON c.person_id = p.id WHERE c.entity_id = e.id AND lower(p.name) LIKE ${pVal})`
        } else {
            // Custom tag or virtual tag
            const pValKey = `@tagVal${idx}`
            const pValLikeKey = `@tagValLike${idx}`
            const pTagKey = `@tagKey${idx}`
            params[pValKey] = tagValue
            params[pValLikeKey] = `%${tagValue}%`
            params[pTagKey] = tag.key
            sql += ` AND (
                    EXISTS (SELECT 1 FROM entity_tags WHERE entity_id = e.id AND key = ${pTagKey} AND lower(value) = ${pValKey}) OR
                    EXISTS (SELECT 1 FROM entity_tags WHERE entity_id = e.id AND key = ${pTagKey} AND lower(value) LIKE ${pValLikeKey}) OR
                    EXISTS (SELECT 1 FROM entity_virtual_tags WHERE entity_id = e.id AND key = ${pTagKey} AND lower(value) = ${pValKey})
                )`
        }
    })
    return sql
}


/**
 * Finds items matching a short text query (LIKE).
 */
export function findByShortQuery(
    normalized: string,
    tags: { key: string; value: string }[],
    limit: number,
    userId?: string
): any[] {
    const db = getDb()
    const likeQuery = `%${normalized}%`
    const startQuery = `${normalized.toLowerCase()}%`
    const params: any = {
        '@likeQuery': likeQuery,
        '@startQuery': startQuery,
        '@limit': limit
    }

    let sql = `
          SELECT ${SEARCH_SELECT},
            0 as rank,
            0 as static_score
          FROM items i
          LEFT JOIN media_entities e ON i.entity_id = e.id
          LEFT JOIN user_state u ON i.id = u.item_id
          WHERE (i.name LIKE @likeQuery OR e.title LIKE @likeQuery)
            AND i.is_ignored = 0
            AND i.is_hidden = 0
        `

    sql = appendTagFilters(sql, params, tags)
    sql = appendVisibilityFilter(sql, params, userId)

    sql += ` ORDER BY
          CASE WHEN e.media_type IN ('movie', 'tv') THEN 1 ELSE 2 END ASC,
          CASE
            WHEN lower(coalesce(e.title, '')) LIKE @startQuery THEN 1
            WHEN lower(coalesce(e.title, '')) LIKE @likeQuery THEN 2
            WHEN lower(i.name) LIKE @startQuery THEN 3
            ELSE 4
          END ASC,
          e.title ASC, i.name ASC LIMIT @limit`

    return db.prepare(sql).all(params) as any[]
}

/**
 * Finds items using FTS5 match query with tag filtering.
 */
export function findByFtsQuery(
    matchQuery: string,
    tags: { key: string; value: string }[],
    limit: number,
    userId?: string
): any[] {
    const db = getDb()
    const params: any = { '@limit': limit }

    let sql = `
          SELECT ${SEARCH_SELECT},
            items_fts.rank,
            0 as static_score
          FROM items_fts
          JOIN items i ON items_fts.id = i.id
          LEFT JOIN media_entities e ON i.entity_id = e.id
          LEFT JOIN user_state u ON i.id = u.item_id
          WHERE items_fts MATCH @matchQuery
            AND i.is_ignored = 0
            AND i.is_hidden = 0
        `
    params['@matchQuery'] = matchQuery

    sql = appendTagFilters(sql, params, tags)
    sql = appendVisibilityFilter(sql, params, userId)

    sql += ` ORDER BY (CASE WHEN e.media_type IN ('movie', 'tv') THEN 0 ELSE 1 END) ASC, bm25(items_fts, 0.0, 10.0, 5.0, 1.0, 0.1) ASC LIMIT @limit`

    return db.prepare(sql).all(params) as any[]
}

/**
 * Finds items with NO text query, only tag filtering.
 */
export function findByTagsOnly(
    tags: { key: string; value: string }[],
    limit: number,
    userId?: string
): any[] {
    const db = getDb()
    const params: any = { '@limit': limit }

    let sql = `
      SELECT ${SEARCH_SELECT},
        0 as rank,
        0 as static_score
      FROM items i
      LEFT JOIN media_entities e ON i.entity_id = e.id
      LEFT JOIN user_state u ON i.id = u.item_id
      WHERE i.is_ignored = 0
        AND i.is_hidden = 0
    `

    sql = appendTagFilters(sql, params, tags)
    sql = appendVisibilityFilter(sql, params, userId)

    sql += ` ORDER BY e.title ASC, i.name ASC LIMIT @limit`

    return db.prepare(sql).all(params) as any[]
}
