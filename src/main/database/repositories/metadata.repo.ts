/**
 * METADATA REPOSITORY (Logical Content Metadata)
 * Owns the 'media_entities' table. Handles TMDB info, genres, people, and images.
 */
import { getDb, runTransaction } from '../client'

/**
 * Fetches credits raw JSON for an entity.
 */
export function fetchCredits(entityId: string): any {
    const db = getDb()
    const row = db.prepare('SELECT people_json FROM media_entities WHERE id = ?').get(entityId) as
        | { people_json: string }
        | undefined
    if (!row || !row.people_json) return null
    try {
        return JSON.parse(row.people_json)
    } catch (e) {
        return null
    }
}

/**
 * Fetches credits for an item by looking up its entity_id.
 */
export function fetchCreditsByItemId(itemId: string): any {
    const db = getDb()
    const row = db.prepare(`
        SELECT e.people_json FROM items i
        JOIN media_entities e ON i.entity_id = e.id
        WHERE i.id = ?
    `).get(itemId) as
        | { people_json: string }
        | undefined
    if (!row || !row.people_json) return null
    try {
        return JSON.parse(row.people_json)
    } catch (e) {
        return null
    }
}

/**
 * Ensures a media_entity row exists for the given item, creating one if needed.
 * Returns the entity_id (existing or newly created).
 */
export function ensureEntityForItem(itemId: string): string {
    const db = getDb()

    // Check if item already has an entity_id
    const item = db.prepare('SELECT entity_id FROM items WHERE id = ?').get(itemId) as { entity_id: string | null } | undefined
    if (item?.entity_id) {
        return item.entity_id
    }

    // Create a new entity and link it
    const entityId = crypto.randomUUID()
    db.prepare('INSERT INTO media_entities (id) VALUES (?)').run(entityId)
    db.prepare('UPDATE items SET entity_id = ? WHERE id = ?').run(entityId, itemId)
    return entityId
}

/**
 * Robust upsert of metadata for an item's entity.
 * Creates the entity and link if they don't exist yet.
 */
export function upsertMetadata(itemId: string, updates: any): void {
    const db = getDb()

    // Ensure entity exists and is linked
    const entityId = ensureEntityForItem(itemId)

    const existing = (db.prepare('SELECT * FROM media_entities WHERE id = ?').get(entityId) as any) || {}

    const params = {
        '@id': entityId,
        '@tmdb_id': updates.tmdbId !== undefined ? updates.tmdbId : existing.tmdb_id,
        '@media_type': updates.mediaType !== undefined ? updates.mediaType : existing.media_type,
        '@title': updates.title !== undefined ? updates.title : existing.title,
        '@overview': updates.overview !== undefined ? updates.overview : existing.overview,
        '@year': updates.year !== undefined ? updates.year : existing.year,
        '@season_number': updates.seasonNumber !== undefined ? updates.seasonNumber : existing.season_number,
        '@episode_number': updates.episodeNumber !== undefined ? updates.episodeNumber : existing.episode_number,
        '@genres_json': updates.genres === undefined ? existing.genres_json : (updates.genres === null ? null : JSON.stringify(updates.genres)),
        '@tags_json': updates.tags === undefined ? existing.tags_json : (updates.tags === null ? null : JSON.stringify(updates.tags)),
        '@virtual_tags_json':
            updates.virtualTags === undefined ? existing.virtual_tags_json : (updates.virtualTags === null ? null : JSON.stringify(updates.virtualTags)),
        '@last_refreshed_at':
            updates.lastRefreshedAt !== undefined ? updates.lastRefreshedAt : existing.last_refreshed_at,
        '@people_json': updates.tmdbCredits === undefined ? existing.people_json : (updates.tmdbCredits === null ? null : JSON.stringify(updates.tmdbCredits)),
        '@seasons_json': updates.tmdbSeasons === undefined ? existing.seasons_json : (updates.tmdbSeasons === null ? null : JSON.stringify(updates.tmdbSeasons)),
        '@episodes_json': updates.tmdbEpisodes === undefined ? existing.episodes_json : (updates.tmdbEpisodes === null ? null : JSON.stringify(updates.tmdbEpisodes)),
        '@poster_path': updates.posterPath !== undefined ? updates.posterPath : existing.poster_path,
        '@backdrop_path': updates.backdropPath !== undefined ? updates.backdropPath : existing.backdrop_path,
        '@logo_path': updates.logoPath !== undefined ? updates.logoPath : existing.logo_path,
        '@locked_fields_json':
            updates.lockedFields === undefined ? existing.locked_fields_json : (updates.lockedFields === null ? null : JSON.stringify(updates.lockedFields)),
        '@version': updates._v !== undefined ? updates._v : existing.version
    }

    db.prepare(
        `
    INSERT INTO media_entities(
      id, tmdb_id, media_type, title, overview, year, season_number, episode_number,
      genres_json, tags_json, virtual_tags_json, people_json, seasons_json, episodes_json,
      poster_path, backdrop_path, logo_path,
      locked_fields_json, last_refreshed_at, version
    ) VALUES(
      @id, @tmdb_id, @media_type, @title, @overview, @year, @season_number, @episode_number,
      @genres_json, @tags_json, @virtual_tags_json, @people_json, @seasons_json, @episodes_json,
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
      genres_json = excluded.genres_json,
      tags_json = excluded.tags_json,
      virtual_tags_json = excluded.virtual_tags_json,
      people_json = excluded.people_json,
      seasons_json = excluded.seasons_json,
      episodes_json = excluded.episodes_json,
      poster_path = excluded.poster_path,
      backdrop_path = excluded.backdrop_path,
      logo_path = excluded.logo_path,
      locked_fields_json = excluded.locked_fields_json,
      last_refreshed_at = excluded.last_refreshed_at
    `
    ).run(params)
}

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
 * Fetches distinct keys/values from a JSON column in the media_entities table.
 */
export function getDistinctJsonEntries(
    jsonColumn: string,
    key?: string
): { key: string; value: string }[] {
    const db = getDb()
    let query: string
    let params: any[] = []

    if (key) {
        query = `SELECT DISTINCT value FROM media_entities, json_each(${jsonColumn}) WHERE key = ? AND ${jsonColumn} IS NOT NULL`
        params = [key]
    } else {
        query = `SELECT DISTINCT key, value FROM media_entities, json_each(${jsonColumn}) WHERE ${jsonColumn} IS NOT NULL`
    }

    const rows = db.prepare(query).all(...params) as any[]
    return rows
        .map((r) => ({
            key: r.key ?? key,
            value: String(r.value)
        }))
}

/**
 * Fetches distinct person names from the people_json blob.
 */
export function getDistinctPersonNames(): string[] {
    const db = getDb()
    const rows = db
        .prepare(
            `
      SELECT DISTINCT json_extract(c.value, '$.name') as name
      FROM media_entities, json_each(people_json, '$.cast') as c
      WHERE people_json IS NOT NULL
      UNION
      SELECT DISTINCT json_extract(c.value, '$.name') as name
      FROM media_entities, json_each(people_json, '$.crew') as c
      WHERE people_json IS NOT NULL
    `
        )
        .all() as { name: string }[]
    return rows.map((r) => r.name).filter(Boolean)
}

/**
 * Executes a bulk update of virtual tags.
 */
export function applyVirtualTagsUpdate(jsonBuildSql: string, itemIds?: string[]): number {
    const db = getDb()

    // Ensure media_entity rows exist for items that need virtual tags
    if (itemIds && itemIds.length > 0) {
        // For specific items, ensure they have entities
        for (const itemId of itemIds) {
            ensureEntityForItem(itemId)
        }
    } else {
        // For bulk: create entities for all non-root items that don't have one
        db.prepare(
            `INSERT OR IGNORE INTO media_entities (id)
             SELECT hex(randomblob(16)) FROM items WHERE parent_id IS NOT NULL AND entity_id IS NULL`
        ).run()
        // Link them
        db.prepare(
            `UPDATE items SET entity_id = (
                SELECT id FROM media_entities WHERE media_entities.id NOT IN (SELECT entity_id FROM items WHERE entity_id IS NOT NULL)
                LIMIT 1
             ) WHERE parent_id IS NOT NULL AND entity_id IS NULL`
        ).run()
    }

    // Build the update query using entity_ids derived from the item_ids
    if (itemIds && itemIds.length > 0) {
        const placeholders = itemIds.map(() => '?').join(',')
        const sql = `UPDATE media_entities SET virtual_tags_json = ${jsonBuildSql}
                     WHERE id IN (SELECT entity_id FROM items WHERE id IN (${placeholders}) AND entity_id IS NOT NULL)`
        const runResult = db.prepare(sql).run(...itemIds)
        return runResult.changes
    } else {
        const sql = `UPDATE media_entities SET virtual_tags_json = ${jsonBuildSql}
                     WHERE id IN (SELECT entity_id FROM items WHERE parent_id IS NOT NULL AND entity_id IS NOT NULL)`
        const runResult = db.prepare(sql).run()
        return runResult.changes
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
            `UPDATE media_entities SET virtual_tags_json = '{}'
             WHERE id IN (SELECT entity_id FROM items WHERE id IN (${placeholders}) AND entity_id IS NOT NULL)`
        ).run(...itemIds)
    } else {
        db.prepare(`UPDATE media_entities SET virtual_tags_json = '{}'`).run()
    }
}
