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


/**
 * Finds items matching a short text query (LIKE).
 */
export function findByShortQuery(
    normalized: string,
    tags: { key: string; value: string }[],
    limit: number
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
          SELECT 
            i.id, i.type, i.name, i.path,
            e.title, e.overview, e.media_type, e.year, e.genres_json, e.tags_json,
            e.poster_path, e.backdrop_path, e.logo_path,
            e.people_json, e.episode_number, e.virtual_tags_json,
            u.watched,
            0 as rank,
            0 as static_score
          FROM items i
          LEFT JOIN media_entities e ON i.entity_id = e.id
          LEFT JOIN user_state u ON i.id = u.item_id
          WHERE (i.name LIKE @likeQuery OR e.title LIKE @likeQuery)
            AND i.is_ignored = 0
            AND i.is_hidden = 0
        `

    // Append Tag Filters
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
            sql += ` AND lower(e.genres_json) LIKE ${pKey}`
            params[pKey] = `%"${tagValue}"%`
        } else if (tag.key === 'person') {
            sql += ` AND lower(e.people_json) LIKE ${pKey}`
            params[pKey] = `%"${tagValue}"%`
        } else {
            const pValKey = `@tagVal${idx}`
            const pValLikeKey = `@tagValLike${idx}`
            const pPathKey = `@tagPath${idx}`
            params[pValKey] = tagValue
            params[pValLikeKey] = `%${tagValue}%`
            params[pPathKey] = `$.${tag.key}`
            sql += ` AND (
                    lower(json_extract(e.tags_json, ${pPathKey})) = ${pValKey} OR 
                    lower(json_extract(e.tags_json, ${pPathKey})) LIKE ${pValLikeKey} OR
                    lower(json_extract(e.virtual_tags_json, ${pPathKey})) = ${pValKey}
                )`
        }
    })

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
    limit: number
): any[] {
    const db = getDb()
    const params: any = { '@limit': limit }

    // Base FTS Query
    let sql = `
          SELECT 
            i.id, i.type, i.name, i.path,
            e.title, e.overview, e.media_type, e.year, e.genres_json, e.tags_json,
            e.poster_path, e.backdrop_path, e.logo_path,
            e.people_json, e.episode_number, e.virtual_tags_json,
            u.watched,
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

    // Append Tag Filters
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
            sql += ` AND lower(e.genres_json) LIKE ${pKey}`
            params[pKey] = `%"${tagValue}"%`
        } else if (tag.key === 'person') {
            sql += ` AND lower(e.people_json) LIKE ${pKey}`
            params[pKey] = `%"${tagValue}"%`
        } else {
            const pValKey = `@tagVal${idx}`
            const pValLikeKey = `@tagValLike${idx}`
            const pPathKey = `@tagPath${idx}`
            params[pValKey] = tagValue
            params[pValLikeKey] = `%${tagValue}%`
            params[pPathKey] = `$.${tag.key}`
            sql += ` AND (
                    lower(json_extract(e.tags_json, ${pPathKey})) = ${pValKey} OR 
                    lower(json_extract(e.tags_json, ${pPathKey})) LIKE ${pValLikeKey} OR
                    lower(json_extract(e.virtual_tags_json, ${pPathKey})) = ${pValKey}
                )`
        }
    })

    sql += ` ORDER BY (CASE WHEN e.media_type IN ('movie', 'tv') THEN 0 ELSE 1 END) ASC, bm25(items_fts, 0.0, 10.0, 5.0, 1.0, 0.1) ASC LIMIT @limit`

    return db.prepare(sql).all(params) as any[]
}

/**
 * Finds items with NO text query, only tag filtering.
 */
export function findByTagsOnly(
    tags: { key: string; value: string }[],
    limit: number
): any[] {
    const db = getDb()
    const params: any = { '@limit': limit }

    let sql = `
      SELECT 
        i.id, i.type, i.name, i.path,
        e.title, e.overview, e.media_type, e.year, e.genres_json, e.tags_json,
        e.poster_path, e.backdrop_path, e.logo_path,
        e.people_json, e.episode_number, e.virtual_tags_json,
        u.watched,
        0 as rank,
        0 as static_score
      FROM items i
      LEFT JOIN media_entities e ON i.entity_id = e.id
      LEFT JOIN user_state u ON i.id = u.item_id
      WHERE i.is_ignored = 0
        AND i.is_hidden = 0
    `

    // Append Tag Filters (Duplicate logic from above - to be refactored in future cleanup)
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
            sql += ` AND lower(e.genres_json) LIKE ${pKey}`
            params[pKey] = `%"${tagValue}"%`
        } else if (tag.key === 'person') {
            sql += ` AND lower(e.people_json) LIKE ${pKey}`
            params[pKey] = `%"${tagValue}"%`
        } else {
            const pValKey = `@tagVal${idx}`
            const pValLikeKey = `@tagValLike${idx}`
            const pPathKey = `@tagPath${idx}`
            params[pValKey] = tagValue
            params[pValLikeKey] = `%${tagValue}%`
            params[pPathKey] = `$.${tag.key}`
            sql += ` AND (
            lower(json_extract(e.tags_json, ${pPathKey})) = ${pValKey} OR 
            lower(json_extract(e.tags_json, ${pPathKey})) LIKE ${pValLikeKey} OR
            lower(json_extract(e.virtual_tags_json, ${pPathKey})) = ${pValKey}
          )`
        }
    })

    sql += ` ORDER BY e.title ASC, i.name ASC LIMIT @limit`

    return db.prepare(sql).all(params) as any[]
}
