/**
 * METADATA REPOSITORY (Logical Content Metadata)
 * Owns the 'metadata' table. Handles TMDB info, genres, people, and images.
 */
import { getDb, runTransaction } from '../client'

/**
 * Fetches credits raw JSON for an item.
 */
export function fetchCredits(itemId: string): any {
    const db = getDb()
    const row = db.prepare('SELECT people_json FROM metadata WHERE item_id = ?').get(itemId) as
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
 * Robust upsert of metadata row.
 */
export function upsertMetadata(itemId: string, updates: any): void {
    const db = getDb()
    const existing = (db.prepare('SELECT * FROM metadata WHERE item_id = ?').get(itemId) as any) || {}

    const params = {
        '@id': itemId,
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
        '@images_json': updates.imagesJson !== undefined ? updates.imagesJson : existing.images_json,
        '@locked_fields_json':
            updates.lockedFields === undefined ? existing.locked_fields_json : (updates.lockedFields === null ? null : JSON.stringify(updates.lockedFields)),
        '@version': updates._v !== undefined ? updates._v : existing.version
    }

    db.prepare(
        `
    INSERT INTO metadata(
      item_id, tmdb_id, media_type, title, overview, year, season_number, episode_number,
      genres_json, tags_json, virtual_tags_json, people_json, seasons_json, episodes_json, images_json, locked_fields_json, last_refreshed_at, version
    ) VALUES(
      @id, @tmdb_id, @media_type, @title, @overview, @year, @season_number, @episode_number,
      @genres_json, @tags_json, @virtual_tags_json, @people_json, @seasons_json, @episodes_json, @images_json, @locked_fields_json, @last_refreshed_at, @version
    )
    ON CONFLICT(item_id) DO UPDATE SET
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
      images_json = excluded.images_json,
      locked_fields_json = excluded.locked_fields_json,
      last_refreshed_at = excluded.last_refreshed_at
    `
    ).run(params)
}

/**
 * Fetches raw metadata row.
 */
export function fetchMetadataRow(itemId: string): any {
    const db = getDb()
    return db.prepare('SELECT * FROM metadata WHERE item_id = ?').get(itemId)
}

/**
 * Updates metadata images.
 */
export function updateMetadataImages(itemId: string, images: any): void {
    const db = getDb()
    db.prepare('UPDATE metadata SET images_json = ? WHERE item_id = ?').run(JSON.stringify(images), itemId)
}

/**
 * Fetches distinct values for a given column in the metadata table.
 */
export function getDistinctMetadataValues(column: string): string[] {
    const db = getDb()
    const rows = db
        .prepare(`SELECT DISTINCT ${column} FROM metadata WHERE ${column} IS NOT NULL`)
        .all() as any[]
    return rows.map((r) => String(r[column]))
}

/**
 * Fetches distinct keys/values from a JSON column in the metadata table.
 */
export function getDistinctJsonEntries(
    jsonColumn: string,
    key?: string
): { key: string; value: string }[] {
    const db = getDb()
    let query: string
    let params: any[] = []

    if (key) {
        query = `SELECT DISTINCT value FROM metadata, json_each(${jsonColumn}) WHERE key = ? AND ${jsonColumn} IS NOT NULL`
        params = [key]
    } else {
        query = `SELECT DISTINCT key, value FROM metadata, json_each(${jsonColumn}) WHERE ${jsonColumn} IS NOT NULL`
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
      FROM metadata, json_each(people_json, '$.cast') as c
      WHERE people_json IS NOT NULL
      UNION
      SELECT DISTINCT json_extract(c.value, '$.name') as name
      FROM metadata, json_each(people_json, '$.crew') as c
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

    // Ensure metadata rows exist
    if (itemIds && itemIds.length > 0) {
        db.prepare(
            `INSERT OR IGNORE INTO metadata (item_id) VALUES ${itemIds.map(() => '(?)').join(',')}`
        ).run(...itemIds)
    } else {
        db.prepare(
            `INSERT OR IGNORE INTO metadata (item_id) SELECT id FROM items WHERE parent_id IS NOT NULL`
        ).run()
    }

    let sql = `UPDATE metadata SET virtual_tags_json = ${jsonBuildSql}`
    let runResult: any

    if (itemIds && itemIds.length > 0) {
        const placeholders = itemIds.map(() => '?').join(',')
        sql += ` WHERE item_id IN (${placeholders})`
        runResult = db.prepare(sql).run(...itemIds)
    } else {
        sql += ` WHERE item_id IN (SELECT id FROM items WHERE parent_id IS NOT NULL)`
        runResult = db.prepare(sql).run()
    }

    return runResult.changes
}

/**
 * Clears virtual tags.
 */
export function clearVirtualTags(itemIds?: string[]): void {
    const db = getDb()
    if (itemIds && itemIds.length > 0) {
        const placeholders = itemIds.map(() => '?').join(',')
        db.prepare(
            `UPDATE metadata SET virtual_tags_json = '{}' WHERE item_id IN (${placeholders})`
        ).run(...itemIds)
    } else {
        db.prepare(`UPDATE metadata SET virtual_tags_json = '{}'`).run()
    }
}


