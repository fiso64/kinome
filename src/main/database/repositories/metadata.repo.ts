/**
 * METADATA REPOSITORY (Logical Content Metadata)
 * Owns effective item metadata, provider credits, tags and virtual tags.
 */
import { EFFECTIVE_METADATA, TMDB_LIST_FIELDS, TMDB_SCALAR_FIELDS, tmdbColumn } from '../item-metadata.sql'
import { getDb, runTransaction } from '../client'
import { ITEM_READ_MODEL } from '../media-read-model.sql'
import { compileFilter, buildWhereFragment } from '../query-builder'
import { ENTITY_SCALAR_METADATA_FIELDS, type TmdbMetadata } from '@shared/metadata-fields'
import type { LibraryItem, VirtualTagConfig } from '@shared/types'
import type { ProviderDetails, ProviderMatch } from '../../services/metadata-provider'

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

export function fetchPerson(id: number): { id: number; name: string; profilePath: string | null } | null {
    const row = getDb().prepare('SELECT id, name, profile_path FROM people WHERE id = ?').get(id) as
        { id: number; name: string; profile_path: string | null } | undefined
    return row ? { id: row.id, name: row.name, profilePath: row.profile_path } : null
}

/**
 * Fetches credits for an item by looking up its entity_id.
 */
export function fetchCreditsByItemId(itemId: string): { cast: any[]; crew: any[] } | null {
    const db = getDb()
    const item = db.prepare('SELECT entity_id FROM media_items WHERE id = ?').get(itemId) as { entity_id: string | null } | undefined
    if (!item?.entity_id) return null
    return fetchCredits(item.entity_id)
}

// ─── Upsert Metadata ────────────────────────────────────────────────────────

function ensureItemMetadata(itemId: string): void {
    const db = getDb()
    const columns = ENTITY_SCALAR_METADATA_FIELDS.map(({ column }) => column).join(', ')
    db.prepare(`
        INSERT OR IGNORE INTO media_item_metadata (item_id, ${columns}, genres_json)
        SELECT item_id, ${columns}, genres_json FROM ${EFFECTIVE_METADATA} WHERE item_id = ? AND metadata_item_id IS NOT NULL
    `).run(itemId)
    db.prepare('INSERT OR IGNORE INTO media_item_metadata (item_id) VALUES (?)').run(itemId)
}

/** Mark known titles and the seasons on their changed files' paths in one transaction. */
export function markMetadataStaleForFiles(fileIds: string[]): string[] {
    if (!fileIds.length) return []
    const columns = ENTITY_SCALAR_METADATA_FIELDS.map(({ column }) => column).join(', ')
    const rows = getDb().query(`
        WITH RECURSIVE ancestors(id, parent_id, kind) AS (
            SELECT i.id, i.parent_item_id, i.media_kind
            FROM json_each(?) files JOIN media_items i ON i.id = files.value
            UNION
            SELECT parent.id, parent.parent_item_id, parent.media_kind
            FROM ancestors child JOIN media_items parent ON parent.id = child.parent_id
            WHERE child.kind IS NULL OR child.kind NOT IN ('movie', 'tv')
        )
        INSERT INTO media_item_metadata (item_id, ${columns}, genres_json, file_change_revision)
        SELECT m.item_id, ${ENTITY_SCALAR_METADATA_FIELDS.map(({ column }) => `m.${column}`).join(', ')}, m.genres_json, lower(hex(randomblob(16)))
        FROM ancestors a JOIN ${EFFECTIVE_METADATA} m ON m.item_id = a.id
        WHERE a.kind = 'season'
           OR (a.kind IN ('movie', 'tv') AND m.tmdb_id > 0)
           OR (a.kind = 'episode' AND EXISTS (
               SELECT 1 FROM media_items parent WHERE parent.id = a.parent_id AND parent.media_kind = 'tv'
           ))
        ON CONFLICT(item_id) DO UPDATE SET file_change_revision = excluded.file_change_revision
        RETURNING item_id
    `).all(JSON.stringify(fileIds)) as { item_id: string }[]
    return rows.map(({ item_id }) => item_id)
}

export function getFileChangeRevisions(ids: string[]): Map<string, string> {
    if (!ids.length) return new Map()
    const rows = getDb().query(`
        SELECT m.item_id, m.file_change_revision
        FROM json_each(?) ids JOIN media_item_metadata m ON m.item_id = ids.value
        WHERE m.file_change_revision IS NOT NULL
    `).all(JSON.stringify(ids)) as { item_id: string; file_change_revision: string }[]
    return new Map(rows.map(({ item_id, file_change_revision }) => [item_id, file_change_revision]))
}

export function completeFileChangeRefresh(revisions: Map<string, string>): void {
    if (!revisions.size) return
    getDb().query(`
        WITH refreshed AS MATERIALIZED (SELECT key, value FROM json_each(?))
        UPDATE media_item_metadata SET file_change_revision = NULL
        WHERE item_id IN (SELECT key FROM refreshed)
          AND file_change_revision = (SELECT value FROM refreshed WHERE key = item_id)
    `).run(JSON.stringify(Object.fromEntries(revisions)))
}

/** Links a materialized item to the shared provider identity and optionally refreshes its facts. */
export function saveProviderMatch(
    itemId: string,
    provider: string,
    match: ProviderMatch,
    details?: ProviderDetails | null,
    options: { supplementalOnly?: boolean } = {},
): { entityId: string; metadataChanged: boolean } {
    return runTransaction(() => {
        const db = getDb()
        ensureItemMetadata(itemId)
        const identity = [provider, String(match.id), match.type] as const
        const existing = db.prepare(`
            SELECT id FROM media_entities WHERE provider = ? AND provider_id = ? AND media_type = ?
        `).get(...identity) as { id: string } | null
        const entityId = existing?.id ?? crypto.randomUUID()
        if (!existing) {
            db.prepare(`
                INSERT INTO media_entities (id, provider, provider_id, media_type, tmdb_id)
                VALUES (?, ?, ?, ?, ?)
            `).run(entityId, ...identity, provider === 'tmdb' ? match.id : null)
        }
        if (details && !options.supplementalOnly) {
            db.prepare(`
                UPDATE media_entities SET title = ?, original_title = ?, overview = ?,
                    release_date = ?, year = ?, tmdb_runtime = ?, fetched_at = ?,
                    poster_path = ?, backdrop_path = ?, logo_path = ?
                WHERE id = ?
            `).run(
                details.title, details.originalTitle, details.overview, details.releaseDate,
                details.year, details.runtime, Date.now(), details.artwork.poster ?? null,
                details.artwork.backdrop ?? null, details.artwork.logo ?? null, entityId
            )
            upsertProviderGenres(entityId, details.genres)
        }
        const metadataChanged = details?.metadata ? saveTmdbMetadata(entityId, details.metadata) : false
        db.prepare('UPDATE media_items SET entity_id = ? WHERE id = ? AND entity_id IS NOT ?')
            .run(entityId, itemId, entityId)
        return { entityId, metadataChanged }
    })
}

function saveTmdbMetadata(entityId: string, metadata: TmdbMetadata): boolean {
    const db = getDb()
    const display = { ...metadata }
    for (const field of [...TMDB_SCALAR_FIELDS, ...TMDB_LIST_FIELDS]) delete display[field]

    const columns = ['tmdb_display_json', ...TMDB_SCALAR_FIELDS.map(tmdbColumn)]
    const values = [JSON.stringify(display), ...TMDB_SCALAR_FIELDS.map((field) => {
        const value = metadata[field]
        return typeof value === 'string' || typeof value === 'number' ? value : null
    })]
    const scalarChanges = db.query(`
        UPDATE media_entities
        SET ${columns.map((column, index) => `${column} = ?${index + 1}`).join(', ')}
        WHERE id = ?${columns.length + 1}
          AND (${columns.map((column, index) => `${column} COLLATE BINARY IS NOT ?${index + 1}`).join(' OR ')})
    `).run(...values, entityId).changes

    const lists = JSON.stringify(Object.fromEntries(TMDB_LIST_FIELDS.map((field) => [field, metadata[field] ?? []])))
    const incoming = `SELECT lists.key AS field, entries.value
        FROM json_each($lists) lists JOIN json_each(lists.value) entries`
    const removed = db.query(`
        WITH incoming AS MATERIALIZED (${incoming})
        DELETE FROM tmdb_entity_values AS old
        WHERE old.entity_id = $entityId
          AND NOT EXISTS (
            SELECT 1 FROM incoming WHERE field = old.field AND value = old.value COLLATE BINARY
          )
    `).run({ $entityId: entityId, $lists: lists }).changes
    const inserted = db.query(`
        INSERT OR IGNORE INTO tmdb_entity_values (entity_id, field, value)
        SELECT $entityId, field, value FROM (${incoming})
    `).run({ $entityId: entityId, $lists: lists }).changes
    return scalarChanges + removed + inserted > 0
}

/**
 * A show whose stored next air date is behind today. The date says when the
 * provider facts went stale, so this is the one case refreshed without a file change.
 * Expects the entity row as e.
 */
export const AIR_DATE_PASSED_SQL = `e.media_type = 'tv' AND e.tmdb_id > 0 AND e.tmdb_next_air_date < date('now')`

export function hasPassedAirDate(itemId: string): boolean {
    return !!getDb().query(`
        SELECT 1 FROM media_items i JOIN media_entities e ON e.id = i.entity_id
        WHERE i.id = ? AND ${AIR_DATE_PASSED_SQL}
    `).get(itemId)
}

export function hasSupplementalTmdbMetadata(itemId: string): boolean {
    return !!getDb().query(`
        SELECT 1 FROM media_items i JOIN media_entities e ON e.id = i.entity_id
        WHERE i.id = ? AND e.tmdb_display_json IS NOT NULL
    `).get(itemId)
}

export function findOtherItemsForEntity(entityId: string, itemId: string): string[] {
    const rows = getDb().prepare('SELECT id FROM media_items WHERE entity_id = ? AND id != ?')
        .all(entityId, itemId) as { id: string }[]
    return rows.map(({ id }) => id)
}

function upsertProviderGenres(entityId: string, genres: string[]): void {
    const db = getDb()
    db.prepare('DELETE FROM entity_genres WHERE entity_id = ?').run(entityId)
    const insertGenre = db.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)')
    const linkGenre = db.prepare(`
        INSERT OR IGNORE INTO entity_genres (entity_id, genre_id)
        SELECT ?, id FROM genres WHERE name = ?
    `)
    for (const genre of genres) {
        insertGenre.run(genre)
        linkGenre.run(entityId, genre)
    }
}

/**
 * Persists the item's effective metadata and keeps provider credits entity-owned.
 * The first write materializes the item's current values before applying the patch.
 */
export function upsertMetadata(itemId: string, updates: any): void {
    runTransaction(() => {
        const db = getDb()
        const fields = ENTITY_SCALAR_METADATA_FIELDS.filter(({ key }) => updates[key] !== undefined)
        if (fields.length || updates.genres !== undefined) {
            ensureItemMetadata(itemId)

            const assignments = fields.map(({ column }) => `${column} = ?`)
            const values = fields.map(({ key, serialize }) => serialize ? serialize(updates[key]) : updates[key])
            if (updates.genres !== undefined) {
                assignments.push('genres_json = ?')
                values.push(JSON.stringify([...new Set(updates.genres ?? [])]))
            }
            db.prepare(`UPDATE media_item_metadata SET ${assignments.join(', ')} WHERE item_id = ?`)
                .run(...values, itemId)
        }

        if (updates.tags !== undefined) {
            upsertTags(itemId, updates.tags)
        }
    })
}

export function saveProviderCredits(entityId: string, credits: NonNullable<LibraryItem['tmdbCredits']>): void {
    runTransaction(() => replaceProviderCredits(entityId, credits))
}

function replaceProviderCredits(entityId: string, credits: NonNullable<LibraryItem['tmdbCredits']>): void {
    const db = getDb()
    db.prepare('DELETE FROM credits WHERE entity_id = ?').run(entityId)
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

function upsertTags(itemId: string, tags: Record<string, any> | null): void {
    const db = getDb()
    db.prepare('DELETE FROM item_tags WHERE item_id = ?').run(itemId)
    if (!tags) return

    const insertTag = db.prepare('INSERT OR IGNORE INTO item_tags (item_id, key, value) VALUES (?, ?, ?)')
    for (const [key, value] of Object.entries(tags)) {
        if (value !== undefined && value !== null) {
            insertTag.run(itemId, key, String(value))
        }
    }
}

/** Clears effective item metadata and unlinks the provider match. */
export function bulkClearItemMetadata(itemIds: string[]): void {
    if (itemIds.length === 0) return
    const db = getDb()
    const placeholders = itemIds.map(() => '?').join(', ')
    runTransaction(() => {
        db.prepare(`
            INSERT OR IGNORE INTO media_item_metadata (item_id)
            SELECT id FROM media_items WHERE id IN (${placeholders})
        `).run(...itemIds)
        db.prepare(`
            UPDATE media_item_metadata SET
              ${ENTITY_SCALAR_METADATA_FIELDS.map(({ column }) => `${column} = NULL`).join(', ')},
              genres_json = '[]', file_change_revision = NULL
            WHERE item_id IN (${placeholders})
        `).run(...itemIds)
        db.prepare(`UPDATE media_items SET entity_id = NULL WHERE id IN (${placeholders})`).run(...itemIds)
    })
}

// ─── Read Helpers ───────────────────────────────────────────────────────────

export function fetchMetadataRow(itemId: string): any {
    return getDb().prepare(`SELECT * FROM ${EFFECTIVE_METADATA} WHERE item_id = ? AND metadata_item_id IS NOT NULL`).get(itemId)
}

export function getItemArtworkPaths() {
    return getDb().query<{
        item_id: string
        poster_path: string | null
        backdrop_path: string | null
        logo_path: string | null
    }, []>(`
        SELECT item_id, poster_path, backdrop_path, logo_path
        FROM ${EFFECTIVE_METADATA}
        WHERE poster_path IS NOT NULL OR backdrop_path IS NOT NULL OR logo_path IS NOT NULL
    `).all()
}

export function updateMetadataImages(
    itemId: string,
    images: { poster: string | null; backdrop: string | null; logo: string | null }
): void {
    upsertMetadata(itemId, {
        posterPath: images.poster,
        backdropPath: images.backdrop,
        logoPath: images.logo,
    })
}

// ─── Virtual Tags ───────────────────────────────────────────────────────────

/**
 * Bulk-writes virtual tags from computed item results.
 */
export function bulkUpsertVirtualTags(entries: { itemId: string; key: string; value: string }[]): void {
    const db = getDb()
    const insert = db.prepare('INSERT OR REPLACE INTO item_virtual_tags (item_id, key, value) VALUES (?, ?, ?)')
    for (const entry of entries) {
        insert.run(entry.itemId, entry.key, entry.value)
    }
}

/**
 * Fetches the virtual tags for a set of items by item ID.
 * Returns a map of item_id → { key: value } from item_virtual_tags.
 */
export function fetchVirtualTagsForItems(itemIds: string[]): Record<string, Record<string, string>> {
    if (itemIds.length === 0) return {}
    const db = getDb()
    const placeholders = itemIds.map(() => '?').join(',')
    const rows = db.prepare(`
        SELECT vt.item_id, vt.key, vt.value
        FROM item_virtual_tags vt
        WHERE vt.item_id IN (${placeholders})
    `).all(...itemIds) as { item_id: string; key: string; value: string }[]

    const result: Record<string, Record<string, string>> = {}
    for (const { item_id, key, value } of rows) {
        if (!result[item_id]) result[item_id] = {}
        result[item_id][key] = value
    }
    return result
}

/**
 * Clears virtual tags.
 */
function clearVirtualTags(itemIds?: string[]): number {
    const db = getDb()
    if (itemIds) {
        if (!itemIds.length) return 0
        const placeholders = itemIds.map(() => '?').join(',')
        return db.prepare(`DELETE FROM item_virtual_tags WHERE item_id IN (${placeholders})`).run(...itemIds).changes
    }
    return db.prepare('DELETE FROM item_virtual_tags').run().changes
}

/**
 * Evaluates virtual tag configs and inserts results into item_virtual_tags.
 *
 * Each tag's cases are evaluated in order using INSERT OR IGNORE, so the first
 * matching case wins (priority ordering). The defaultResult is applied last for
 * items that matched no case.
 *
 * Returns total number of rows inserted.
 */
function evaluateVirtualTags(tags: VirtualTagConfig[], itemIds?: string[], staged = false): number {
    const db = getDb()
    let totalInserted = 0

    if (itemIds?.length === 0) return 0
    const scopeParams = itemIds ? [...new Set(itemIds)] : []
    // A full rebuild's rules see the results of earlier cases in this rebuild.
    const scope = itemIds
        ? `WITH target_items(id) AS (VALUES ${scopeParams.map(() => '(?)').join(',')})`
        : staged ? 'WITH item_virtual_tags AS (SELECT * FROM temp.virtual_tag_results)' : ''
    const destination = staged ? 'temp.virtual_tag_results' : 'item_virtual_tags'
    const targets = itemIds ? 'SELECT id FROM target_items' : undefined
    const items = itemIds
        ? `target_items target CROSS JOIN ${ITEM_READ_MODEL} i ON i.id = target.id`
        : `${ITEM_READ_MODEL} i`

    for (const tag of tags) {
        // Evaluate each case in order — INSERT OR IGNORE preserves first-match-wins
        for (const vtCase of tag.cases) {
            const compiled = compileFilter(vtCase.filter, { targets })
            // Override includeHidden/includeIgnored: vtags apply to all items
            const { conditions, params, tables } = buildWhereFragment({
                ...compiled,
                includeHidden: true,
                includeIgnored: true
            })

            const baseConditions = [
                'i.parent_id IS NOT NULL',
                ...conditions
            ]
            const joinSql = tables.has('e')
                ? `JOIN ${EFFECTIVE_METADATA} e ON i.id = e.item_id`
                : ''

            const insertSql = `
                ${scope}
                INSERT OR IGNORE INTO ${destination} (item_id, key, value)
                SELECT i.id, ?, ?
                FROM ${items} ${joinSql}
                WHERE ${baseConditions.join(' AND ')}
            `
            const result = db.prepare(insertSql).run(...scopeParams, tag.name, vtCase.result, ...params)
            totalInserted += result.changes
        }

        // Apply defaultResult for items not matched by any case
        if (tag.defaultResult) {
            const defaultSql = `
                ${scope}
                INSERT OR IGNORE INTO ${destination} (item_id, key, value)
                SELECT i.id, ?, ?
                FROM ${items}
                WHERE i.parent_id IS NOT NULL
                  AND i.is_virtual = 0
                  AND NOT EXISTS (
                    SELECT 1 FROM item_virtual_tags WHERE item_id = i.id AND key = ?
                  )
            `
            const result = db.prepare(defaultSql).run(...scopeParams, tag.name, tag.defaultResult, tag.name)
            totalInserted += result.changes
        }
    }

    return totalInserted
}

export function replaceVirtualTags(tags: VirtualTagConfig[] = [], itemIds?: string[]): number {
    if (itemIds?.length === 0) return 0
    const db = getDb()
    return runTransaction(() => {
        if (itemIds || !tags.length || !db.query('SELECT 1 FROM item_virtual_tags LIMIT 1').get()) {
            return clearVirtualTags(itemIds) + evaluateVirtualTags(tags, itemIds)
        }

        db.exec(`
            CREATE TEMP TABLE virtual_tag_results (
                item_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
                PRIMARY KEY (item_id, key)
            ) WITHOUT ROWID
        `)
        try {
            evaluateVirtualTags(tags, undefined, true)
            const removed = db.query(`
                DELETE FROM item_virtual_tags AS existing
                WHERE NOT EXISTS (
                    SELECT 1 FROM temp.virtual_tag_results result
                    WHERE result.item_id = existing.item_id AND result.key = existing.key
                )
            `).run().changes
            const updated = db.query(`
                INSERT INTO item_virtual_tags (item_id, key, value)
                SELECT result.item_id, result.key, result.value
                FROM temp.virtual_tag_results result
                LEFT JOIN item_virtual_tags existing
                  ON existing.item_id = result.item_id AND existing.key = result.key
                WHERE existing.value IS NOT result.value
                ON CONFLICT (item_id, key) DO UPDATE SET value = excluded.value
            `).run().changes
            return removed + updated
        } finally {
            db.exec('DROP TABLE temp.virtual_tag_results')
        }
    })
}

/**
 * Titles that share people, genres or tags with an item, scored as Jellyfin
 * does: a director 50, one of the first fifteen billed actors 15, a genre 10,
 * a tag 5. Genres are the item's effective ones, an override or else the
 * entity's. Every part is an index lookup, and only the best `limit` return.
 */
export function relatedItemScores(itemId: string, entityId: string | null, genres: readonly string[], limit: number): { id: string; score: number }[] {
  const genreList = genres.map(() => '?').join(', ')
  return getDb().prepare(`
    WITH matches(item_id, points) AS (
      SELECT i.id, CASE WHEN source.credit_type = 'crew' THEN 50 ELSE 15 END
      FROM credits source
      JOIN credits other ON other.person_id = source.person_id AND other.credit_type = source.credit_type
        AND other.entity_id != source.entity_id
        AND (source.credit_type = 'crew' OR other.display_order < 15)
      JOIN media_items i ON i.entity_id = other.entity_id
      WHERE source.entity_id = ? AND (
        (source.credit_type = 'crew' AND source.job = 'Director' AND other.job = 'Director')
        OR (source.credit_type = 'cast' AND source.display_order < 15))
      ${genres.length ? `
      UNION ALL
      SELECT g.item_id, 10 FROM item_genres g WHERE g.name IN (${genreList})
      UNION ALL
      SELECT i.id, 10 FROM genres name
      JOIN entity_genres eg ON eg.genre_id = name.id
      JOIN media_items i ON i.entity_id = eg.entity_id
      WHERE name.name IN (${genreList})
        AND NOT EXISTS (SELECT 1 FROM media_item_metadata override WHERE override.item_id = i.id AND override.genres_json IS NOT NULL)` : ''}
      UNION ALL
      SELECT other.item_id, 5 FROM item_tags source
      JOIN item_tags other ON other.key = source.key AND other.value = source.value AND other.item_id != source.item_id
      WHERE source.item_id = ? AND source.key != 'jellyfin'
    )
    SELECT item_id AS id, SUM(points) AS score FROM matches WHERE item_id != ?
    GROUP BY item_id ORDER BY score DESC LIMIT ?
  `).all(entityId ?? '', ...genres, ...genres, itemId, itemId, limit) as { id: string; score: number }[]
}
