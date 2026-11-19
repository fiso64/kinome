/**
 * METADATA REPOSITORY (Logical Content Metadata)
 * Owns effective item metadata, provider credits, tags and virtual tags.
 */
import { EFFECTIVE_METADATA } from '../item-metadata.sql'
import { getDb, runTransaction } from '../client'
import { compileFilter, buildWhereFragment } from '../query-builder'
import { ENTITY_SCALAR_METADATA_FIELDS } from '@shared/metadata-fields'
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

/** Links a materialized item to the shared provider identity and optionally refreshes its facts. */
export function saveProviderMatch(
    itemId: string,
    provider: string,
    match: ProviderMatch,
    details?: ProviderDetails | null,
): string {
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
        if (details) {
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
        db.prepare('UPDATE media_items SET entity_id = ? WHERE id = ? AND entity_id IS NOT ?')
            .run(entityId, itemId, entityId)
        return entityId
    })
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
              genres_json = '[]'
            WHERE item_id IN (${placeholders})
        `).run(...itemIds)
        db.prepare(`UPDATE media_items SET entity_id = NULL WHERE id IN (${placeholders})`).run(...itemIds)
    })
}

// ─── Read Helpers ───────────────────────────────────────────────────────────

export function fetchMetadataRow(itemId: string): any {
    return getDb().prepare(`SELECT * FROM ${EFFECTIVE_METADATA} WHERE item_id = ? AND metadata_item_id IS NOT NULL`).get(itemId)
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

export function getDistinctMetadataValues(column: string): string[] {
    const db = getDb()
    const rows = db
        .prepare(`SELECT DISTINCT ${column} FROM ${EFFECTIVE_METADATA} WHERE ${column} IS NOT NULL`)
        .all() as any[]
    return rows.map((r) => String(r[column]))
}

export function getDistinctGenreNames(): string[] {
    const rows = getDb().prepare(`
        SELECT DISTINCT g.value AS name FROM ${EFFECTIVE_METADATA} e, json_each(e.genres_json) g ORDER BY name
    `).all() as { name: string }[]
    return rows.map(({ name }) => name)
}

/**
 * Fetches distinct tag keys and optionally values for a given key.
 */
export function getDistinctTagEntries(table: 'item_tags' | 'item_virtual_tags', key?: string): { key: string; value: string }[] {
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
export function clearVirtualTags(itemIds?: string[]): void {
    const db = getDb()
    if (itemIds && itemIds.length > 0) {
        const placeholders = itemIds.map(() => '?').join(',')
        db.prepare(`DELETE FROM item_virtual_tags WHERE item_id IN (${placeholders})`).run(...itemIds)
    } else {
        db.prepare('DELETE FROM item_virtual_tags').run()
    }
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
export function evaluateAndInsertVirtualTags(tags: VirtualTagConfig[], itemIds?: string[]): number {
    const db = getDb()
    let totalInserted = 0

    const scopeCondition = itemIds && itemIds.length > 0
        ? `AND i.id IN (${itemIds.map(() => '?').join(',')})`
        : ''
    const scopeParams = itemIds && itemIds.length > 0 ? itemIds : []

    for (const tag of tags) {
        // Evaluate each case in order — INSERT OR IGNORE preserves first-match-wins
        for (const vtCase of tag.cases) {
            const compiled = compileFilter(vtCase.filter)
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
            const whereSql = baseConditions.length
                ? `WHERE ${baseConditions.join(' AND ')} ${scopeCondition}`
                : `WHERE 1=1 ${scopeCondition}`

            const joinSql = tables.has('e')
                ? `JOIN ${EFFECTIVE_METADATA} e ON i.id = e.item_id`
                : ''

            const insertSql = `
                INSERT OR IGNORE INTO item_virtual_tags (item_id, key, value)
                SELECT i.id, ?, ?
                FROM media_items_read i ${joinSql}
                ${whereSql}
            `
            const result = db.prepare(insertSql).run(tag.name, vtCase.result, ...params, ...scopeParams)
            totalInserted += result.changes
        }

        // Apply defaultResult for items not matched by any case
        if (tag.defaultResult) {
            const defaultSql = `
                INSERT OR IGNORE INTO item_virtual_tags (item_id, key, value)
                SELECT i.id, ?, ?
                FROM media_items_read i
                WHERE i.parent_id IS NOT NULL
                  AND i.is_virtual = 0
                  ${scopeCondition}
                  AND i.id NOT IN (
                    SELECT item_id FROM item_virtual_tags WHERE key = ?
                  )
            `
            const result = db.prepare(defaultSql).run(tag.name, tag.defaultResult, ...scopeParams, tag.name)
            totalInserted += result.changes
        }
    }

    return totalInserted
}
