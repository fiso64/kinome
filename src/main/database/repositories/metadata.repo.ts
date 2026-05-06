/**
 * METADATA REPOSITORY (Logical Content Metadata)
 * Owns the 'media_entities' table and its normalized relational tables
 * (genres, entity_genres, people, credits, entity_tags, entity_virtual_tags).
 */
import { getDb, runTransaction } from '../client'
import { compileFilter, buildWhereFragment } from '../query-builder'
import { ENTITY_SCALAR_METADATA_FIELDS } from '@shared/metadata-fields'
import type { VirtualTagConfig } from '@shared/types'

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
    const params: Record<string, unknown> = { '@id': entityId }
    for (const field of ENTITY_SCALAR_METADATA_FIELDS) {
        const hasUpdate = updates[field.key] !== undefined
        const nextValue = hasUpdate ? updates[field.key] : existing[field.column]
        params[`@${field.column}`] = hasUpdate && field.serialize ? field.serialize(nextValue) : nextValue
    }

    const columns = ['id', ...ENTITY_SCALAR_METADATA_FIELDS.map((field) => field.column)]
    const valueParams = ['@id', ...ENTITY_SCALAR_METADATA_FIELDS.map((field) => `@${field.column}`)]
    const updateAssignments = ENTITY_SCALAR_METADATA_FIELDS.map((field) => `${field.column} = excluded.${field.column}`)

    db.prepare(`
    INSERT INTO media_entities(${columns.join(', ')})
    VALUES(${valueParams.join(', ')})
    ON CONFLICT(id) DO UPDATE SET
      ${updateAssignments.join(',\n      ')}
    `).run(params as any)

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

/**
 * Looks up entity IDs for a set of item IDs in one query.
 */
export function fetchEntityIdsForItemIds(itemIds: string[]): string[] {
    if (itemIds.length === 0) return []
    const db = getDb()
    const placeholders = itemIds.map(() => '?').join(', ')
    const rows = db.prepare(
        `SELECT entity_id FROM items WHERE id IN (${placeholders}) AND entity_id IS NOT NULL`
    ).all(...itemIds) as { entity_id: string }[]
    return rows.map(r => r.entity_id)
}

/**
 * Bulk-clears all metadata for a set of items in a few SQL statements.
 * Use for recursive clear-metadata operations instead of N individual upsertMetadata calls.
 * Operates on entity IDs (not item IDs).
 */
export function bulkClearEntityMetadata(entityIds: string[]): void {
    if (entityIds.length === 0) return
    const db = getDb()
    const placeholders = entityIds.map(() => '?').join(', ')

    runTransaction(() => {
        db.prepare(`
            UPDATE media_entities SET
              ${ENTITY_SCALAR_METADATA_FIELDS.map((field) => `${field.column} = NULL`).join(',\n              ')}
            WHERE id IN (${placeholders})
        `).run(...entityIds)

        db.prepare(`DELETE FROM entity_genres WHERE entity_id IN (${placeholders})`).run(...entityIds)
        db.prepare(`DELETE FROM credits WHERE entity_id IN (${placeholders})`).run(...entityIds)
        db.prepare(`DELETE FROM entity_tags WHERE entity_id IN (${placeholders})`).run(...entityIds)
    })
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
 * Fetches the virtual tags for a set of items by item ID.
 * Returns a map of item_id → { key: value } pulled from entity_virtual_tags via entity join.
 */
export function fetchVirtualTagsForItems(itemIds: string[]): Record<string, Record<string, string>> {
    if (itemIds.length === 0) return {}
    const db = getDb()
    const placeholders = itemIds.map(() => '?').join(',')
    const rows = db.prepare(`
        SELECT i.id AS item_id, vt.key, vt.value
        FROM items i
        JOIN entity_virtual_tags vt ON i.entity_id = vt.entity_id
        WHERE i.id IN (${placeholders})
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
        db.prepare(
            `DELETE FROM entity_virtual_tags
             WHERE entity_id IN (SELECT entity_id FROM items WHERE id IN (${placeholders}) AND entity_id IS NOT NULL)`
        ).run(...itemIds)
    } else {
        db.prepare('DELETE FROM entity_virtual_tags').run()
    }
}

/**
 * Evaluates virtual tag configs and inserts results into entity_virtual_tags.
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
                'i.entity_id IS NOT NULL',
                'i.parent_id IS NOT NULL',
                ...conditions
            ]
            const whereSql = baseConditions.length
                ? `WHERE ${baseConditions.join(' AND ')} ${scopeCondition}`
                : `WHERE 1=1 ${scopeCondition}`

            const joinSql = tables.has('e')
                ? 'LEFT JOIN media_entities e ON i.entity_id = e.id'
                : ''

            const insertSql = `
                INSERT OR IGNORE INTO entity_virtual_tags (entity_id, key, value)
                SELECT i.entity_id, ?, ?
                FROM items i ${joinSql}
                ${whereSql}
            `
            const result = db.prepare(insertSql).run(tag.name, vtCase.result, ...params, ...scopeParams)
            totalInserted += result.changes
        }

        // Apply defaultResult for items not matched by any case
        if (tag.defaultResult) {
            const defaultSql = `
                INSERT OR IGNORE INTO entity_virtual_tags (entity_id, key, value)
                SELECT i.entity_id, ?, ?
                FROM items i
                WHERE i.entity_id IS NOT NULL
                  AND i.parent_id IS NOT NULL
                  AND i.is_virtual = 0
                  ${scopeCondition}
                  AND i.entity_id NOT IN (
                    SELECT entity_id FROM entity_virtual_tags WHERE key = ?
                  )
            `
            const result = db.prepare(defaultSql).run(tag.name, tag.defaultResult, ...scopeParams, tag.name)
            totalInserted += result.changes
        }
    }

    return totalInserted
}
