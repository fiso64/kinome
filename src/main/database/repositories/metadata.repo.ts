/**
 * METADATA REPOSITORY (Logical Content Metadata)
 * Owns the 'media_entities' table and its normalized relational tables
 * (genres, entity_genres, people, credits, entity_tags, entity_virtual_tags).
 */
import { getDb, runTransaction } from '../client'
import type { VirtualTagConfig, VirtualTagCondition } from '@shared/types'

// ─── Credits (Normalized) ───────────────────────────────────────────────────

/**
 * Fetches credits for an entity from the normalized credits+people tables.
 * Returns { cast: [...], crew: [...] } matching the old people_json shape.
 */
export function fetchCredits(entityId: string): { cast: any[]; crew: any[] } | null {
    const db = getDb()
    const rows = db.prepare(`
        SELECT p.id, p.name, p.profile_path, c.credit_type, c.character, c.job, c.display_order
        FROM credits c JOIN people p ON c.person_id = p.id
        WHERE c.entity_id = ?
        ORDER BY c.display_order ASC
    `).all(entityId) as any[]

    if (rows.length === 0) return null

    const cast = rows
        .filter(r => r.credit_type === 'cast')
        .map(r => ({ id: r.id, name: r.name, profile_path: r.profile_path, character: r.character, order: r.display_order }))
    const crew = rows
        .filter(r => r.credit_type === 'crew')
        .map(r => ({ id: r.id, name: r.name, profile_path: r.profile_path, job: r.job, order: r.display_order }))

    return { cast, crew }
}

/**
 * Fetches credits for an item by looking up its entity_id.
 */
export function fetchCreditsByItemId(itemId: string): { cast: any[]; crew: any[] } | null {
    const db = getDb()
    const item = db.prepare('SELECT entity_id FROM items WHERE id = ?').get(itemId) as { entity_id: string | null } | undefined
    if (!item?.entity_id) return null
    return fetchCredits(item.entity_id)
}

// ─── Entity Lifecycle ───────────────────────────────────────────────────────

/**
 * Ensures a media_entity row exists for the given item, creating one if needed.
 * Returns the entity_id (existing or newly created).
 */
export function ensureEntityForItem(itemId: string): string {
    const db = getDb()

    const item = db.prepare('SELECT entity_id FROM items WHERE id = ?').get(itemId) as { entity_id: string | null } | undefined
    if (item?.entity_id) {
        return item.entity_id
    }

    const entityId = crypto.randomUUID()
    db.prepare('INSERT INTO media_entities (id) VALUES (?)').run(entityId)
    db.prepare('UPDATE items SET entity_id = ? WHERE id = ?').run(entityId, itemId)
    return entityId
}

// ─── Upsert Metadata ────────────────────────────────────────────────────────

/**
 * Robust upsert of metadata for an item's entity.
 * Creates the entity and link if they don't exist yet.
 * Handles both scalar fields (on media_entities) and relational data (junction tables).
 */
export function upsertMetadata(itemId: string, updates: any): void {
    const db = getDb()

    const entityId = ensureEntityForItem(itemId)

    const existing = (db.prepare('SELECT * FROM media_entities WHERE id = ?').get(entityId) as any) || {}

    // 1. Upsert scalar fields on media_entities
    const params = {
        '@id': entityId,
        '@tmdb_id': updates.tmdbId !== undefined ? updates.tmdbId : existing.tmdb_id,
        '@media_type': updates.mediaType !== undefined ? updates.mediaType : existing.media_type,
        '@title': updates.title !== undefined ? updates.title : existing.title,
        '@overview': updates.overview !== undefined ? updates.overview : existing.overview,
        '@year': updates.year !== undefined ? updates.year : existing.year,
        '@season_number': updates.seasonNumber !== undefined ? updates.seasonNumber : existing.season_number,
        '@episode_number': updates.episodeNumber !== undefined ? updates.episodeNumber : existing.episode_number,
        '@last_refreshed_at':
            updates.lastRefreshedAt !== undefined ? updates.lastRefreshedAt : existing.last_refreshed_at,
        '@poster_path': updates.posterPath !== undefined ? updates.posterPath : existing.poster_path,
        '@backdrop_path': updates.backdropPath !== undefined ? updates.backdropPath : existing.backdrop_path,
        '@logo_path': updates.logoPath !== undefined ? updates.logoPath : existing.logo_path,
        '@locked_fields_json':
            updates.lockedFields === undefined ? existing.locked_fields_json : (updates.lockedFields === null ? null : JSON.stringify(updates.lockedFields)),
        '@version': updates._v !== undefined ? updates._v : existing.version
    }

    db.prepare(`
    INSERT INTO media_entities(
      id, tmdb_id, media_type, title, overview, year, season_number, episode_number,
      poster_path, backdrop_path, logo_path,
      locked_fields_json, last_refreshed_at, version
    ) VALUES(
      @id, @tmdb_id, @media_type, @title, @overview, @year, @season_number, @episode_number,
      @poster_path, @backdrop_path, @logo_path,
      @locked_fields_json, @last_refreshed_at, @version
    )
    ON CONFLICT(id) DO UPDATE SET
      tmdb_id = excluded.tmdb_id,
      media_type = excluded.media_type,
      title = excluded.title,
      overview = excluded.overview,
      version = excluded.version,
      year = excluded.year,
      season_number = excluded.season_number,
      episode_number = excluded.episode_number,
      poster_path = excluded.poster_path,
      backdrop_path = excluded.backdrop_path,
      logo_path = excluded.logo_path,
      locked_fields_json = excluded.locked_fields_json,
      last_refreshed_at = excluded.last_refreshed_at
    `).run(params)

    // 2. Upsert relational data (genres, credits, tags)
    if (updates.genres !== undefined) {
        upsertGenres(entityId, updates.genres)
    }
    if (updates.tmdbCredits !== undefined) {
        upsertCredits(entityId, updates.tmdbCredits)
    }
    if (updates.tags !== undefined) {
        upsertTags(entityId, updates.tags)
    }
}

// ─── Relational Upsert Helpers ──────────────────────────────────────────────

function upsertGenres(entityId: string, genres: string[] | null): void {
    const db = getDb()
    db.prepare('DELETE FROM entity_genres WHERE entity_id = ?').run(entityId)
    if (!genres || genres.length === 0) return

    const insertGenre = db.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)')
    const getGenreId = db.prepare('SELECT id FROM genres WHERE name = ?')
    const insertLink = db.prepare('INSERT OR IGNORE INTO entity_genres (entity_id, genre_id) VALUES (?, ?)')

    for (const name of genres) {
        insertGenre.run(name)
        const row = getGenreId.get(name) as { id: number }
        insertLink.run(entityId, row.id)
    }
}

function upsertCredits(entityId: string, credits: { cast?: any[]; crew?: any[] } | null): void {
    const db = getDb()
    db.prepare('DELETE FROM credits WHERE entity_id = ?').run(entityId)
    if (!credits) return

    const upsertPerson = db.prepare(
        'INSERT INTO people (id, name, profile_path) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, profile_path = excluded.profile_path'
    )
    const insertCredit = db.prepare(
        'INSERT OR IGNORE INTO credits (entity_id, person_id, credit_type, character, job, display_order) VALUES (?, ?, ?, ?, ?, ?)'
    )

    for (const member of credits.cast ?? []) {
        if (!member.id) continue
        upsertPerson.run(member.id, member.name, member.profile_path ?? null)
        insertCredit.run(entityId, member.id, 'cast', member.character ?? null, null, member.order ?? null)
    }
    for (const member of credits.crew ?? []) {
        if (!member.id) continue
        upsertPerson.run(member.id, member.name, member.profile_path ?? null)
        insertCredit.run(entityId, member.id, 'crew', null, member.job ?? null, member.order ?? null)
    }
}

function upsertTags(entityId: string, tags: Record<string, any> | null): void {
    const db = getDb()
    db.prepare('DELETE FROM entity_tags WHERE entity_id = ?').run(entityId)
    if (!tags) return

    const insertTag = db.prepare('INSERT OR IGNORE INTO entity_tags (entity_id, key, value) VALUES (?, ?, ?)')
    for (const [key, value] of Object.entries(tags)) {
        if (value !== undefined && value !== null) {
            insertTag.run(entityId, key, String(value))
        }
    }
}

// ─── Read Helpers ───────────────────────────────────────────────────────────

/**
 * Fetches raw entity row for an item (via entity_id link).
 */
export function fetchMetadataRow(itemId: string): any {
    const db = getDb()
    const item = db.prepare('SELECT entity_id FROM items WHERE id = ?').get(itemId) as { entity_id: string | null } | undefined
    if (!item?.entity_id) return null
    return db.prepare('SELECT * FROM media_entities WHERE id = ?').get(item.entity_id)
}

/**
 * Updates entity images directly.
 */
export function updateMetadataImages(itemId: string, images: any): void {
    const db = getDb()
    const item = db.prepare('SELECT entity_id FROM items WHERE id = ?').get(itemId) as { entity_id: string | null } | undefined
    if (!item?.entity_id) return
    db.prepare('UPDATE media_entities SET poster_path = ?, backdrop_path = ?, logo_path = ? WHERE id = ?').run(
        images.poster ?? null,
        images.backdrop ?? null,
        images.logo ?? null,
        item.entity_id
    )
}

/**
 * Fetches distinct values for a given column in the media_entities table.
 */
export function getDistinctMetadataValues(column: string): string[] {
    const db = getDb()
    const rows = db
        .prepare(`SELECT DISTINCT ${column} FROM media_entities WHERE ${column} IS NOT NULL`)
        .all() as any[]
    return rows.map((r) => String(r[column]))
}

/**
 * Fetches distinct genre names.
 */
export function getDistinctGenreNames(): string[] {
    const db = getDb()
    const rows = db.prepare('SELECT name FROM genres ORDER BY name').all() as { name: string }[]
    return rows.map(r => r.name)
}

/**
 * Fetches distinct tag keys and optionally values for a given key.
 */
export function getDistinctTagEntries(table: 'entity_tags' | 'entity_virtual_tags', key?: string): { key: string; value: string }[] {
    const db = getDb()
    if (key) {
        const rows = db.prepare(`SELECT DISTINCT value FROM ${table} WHERE key = ?`).all(key) as { value: string }[]
        return rows.map(r => ({ key, value: r.value }))
    }
    return db.prepare(`SELECT DISTINCT key, value FROM ${table}`).all() as { key: string; value: string }[]
}

/**
 * Fetches distinct person names from the normalized people table.
 */
export function getDistinctPersonNames(): string[] {
    const db = getDb()
    const rows = db.prepare('SELECT DISTINCT name FROM people ORDER BY name').all() as { name: string }[]
    return rows.map((r) => r.name).filter(Boolean)
}

// ─── Virtual Tags ───────────────────────────────────────────────────────────

/**
 * Bulk-writes virtual tags from computed results.
 * The virtualTags service computes tags per entity, then calls this to persist them.
 */
export function bulkUpsertVirtualTags(entries: { entityId: string; key: string; value: string }[]): void {
    const db = getDb()
    const insert = db.prepare('INSERT OR REPLACE INTO entity_virtual_tags (entity_id, key, value) VALUES (?, ?, ?)')
    for (const entry of entries) {
        insert.run(entry.entityId, entry.key, entry.value)
    }
}

/**
 * Clears virtual tags.
 */
export function clearVirtualTags(itemIds?: string[]): void {
    const db = getDb()
    if (itemIds && itemIds.length > 0) {
        const placeholders = itemIds.map(() => '?').join(',')
        db.prepare(
            `DELETE FROM entity_virtual_tags
             WHERE entity_id IN (SELECT entity_id FROM items WHERE id IN (${placeholders}) AND entity_id IS NOT NULL)`
        ).run(...itemIds)
    } else {
        db.prepare('DELETE FROM entity_virtual_tags').run()
    }
}

/**
 * Evaluates virtual tag configs as SQL CASE expressions against media_entities
 * and inserts the results into entity_virtual_tags.
 * Returns total number of rows inserted.
 */
export function evaluateAndInsertVirtualTags(tags: VirtualTagConfig[], itemIds?: string[]): number {
    const db = getDb()
    let totalInserted = 0

    for (const tag of tags) {
        const caseSql = generateCaseSql(tag)
        const tagName = escapeString(tag.name)

        let scopeSql: string
        let scopeParams: any[] = []

        if (itemIds && itemIds.length > 0) {
            const placeholders = itemIds.map(() => '?').join(',')
            scopeSql = `
                SELECT media_entities.id AS entity_id, ${caseSql} AS tag_value
                FROM media_entities
                WHERE media_entities.id IN (SELECT entity_id FROM items WHERE id IN (${placeholders}) AND entity_id IS NOT NULL)
            `
            scopeParams = itemIds
        } else {
            scopeSql = `
                SELECT media_entities.id AS entity_id, ${caseSql} AS tag_value
                FROM media_entities
                WHERE media_entities.id IN (SELECT entity_id FROM items WHERE parent_id IS NOT NULL AND entity_id IS NOT NULL)
            `
        }

        const insertSql = `
            INSERT OR REPLACE INTO entity_virtual_tags (entity_id, key, value)
            SELECT entity_id, '${tagName}', tag_value
            FROM (${scopeSql})
            WHERE tag_value IS NOT NULL
        `
        const result = db.prepare(insertSql).run(...scopeParams)
        totalInserted += result.changes
    }

    return totalInserted
}

// ─── Virtual Tag SQL Builders (internal) ────────────────────────────────────

function escapeString(str: string): string {
    return str.replace(/'/g, "''")
}

function buildConditionSql(condition: VirtualTagCondition): string {
    let column = ''

    switch (condition.target) {
        case 'year':
            column = 'media_entities.year'
            break
        case 'title':
            column = 'media_entities.title'
            break
        case 'mediaType':
            column = 'media_entities.media_type'
            break
        case 'path':
            column = '(SELECT path FROM items WHERE entity_id = media_entities.id LIMIT 1)'
            break
        case 'genre':
            if (condition.operator === 'contains') {
                return `EXISTS (
                    SELECT 1 FROM entity_genres eg JOIN genres g ON eg.genre_id = g.id
                    WHERE eg.entity_id = media_entities.id AND g.name LIKE '%${escapeString(String(condition.value))}%'
                )`
            }
            return `EXISTS (
                SELECT 1 FROM entity_genres eg JOIN genres g ON eg.genre_id = g.id
                WHERE eg.entity_id = media_entities.id AND g.name = '${escapeString(String(condition.value))}'
            )`
        case 'tag':
            if (!condition.targetKey) return '0'
            column = `(SELECT value FROM entity_tags WHERE entity_id = media_entities.id AND key = '${escapeString(condition.targetKey)}')`
            break
        default:
            return '0'
    }

    const valStr = escapeString(String(condition.value))
    const valQuoted = `'${valStr}'`

    switch (condition.operator) {
        case 'equals':
            return `${column} = ${valQuoted}`
        case 'contains':
            return `${column} LIKE '%${valStr}%'`
        case 'greaterThan':
            return `CAST(${column} AS NUMERIC) > CAST(${valQuoted} AS NUMERIC)`
        case 'lessThan':
            return `CAST(${column} AS NUMERIC) < CAST(${valQuoted} AS NUMERIC)`
        default:
            return '0'
    }
}

function generateCaseSql(tag: VirtualTagConfig): string {
    const conditionsSql = tag.conditions
        .map((cond) => {
            const whenSql = buildConditionSql(cond)
            return `WHEN ${whenSql} THEN '${escapeString(cond.result)}'`
        })
        .join(' ')

    const defaultSql = tag.defaultResult ? `ELSE '${escapeString(tag.defaultResult)}'` : 'ELSE NULL'

    return `CASE ${conditionsSql} ${defaultSql} END`
}
