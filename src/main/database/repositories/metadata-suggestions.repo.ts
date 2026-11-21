import { DEFAULT_AUTOCOMPLETE_LIMIT, isLocalMediaField, isTmdbFilterField } from '@shared/metadata-fields'
import { getDb } from '../client'
import type { EFFECTIVE_SUGGESTION_COLUMNS } from '../item-metadata.sql'
import { ITEM_READ_MODEL, withAccountLocations } from '../media-read-model.sql'
import { localMediaFact, readMetadataFact, tmdbFact } from '../metadata-facts.sql'
import { hasSmallVisibleItemSet } from './account-filter.repo'

type Fact = ReturnType<typeof readMetadataFact>

function matchPosition(value: string): string {
    return `instr(lower(${value}), lower($query))`
}

function matchesQuery(value: string): string {
    return `($query = '' OR ${matchPosition(value)} > 0)`
}

function suggestionOrder(value: string, sortValue = value): string {
    return `ORDER BY ${matchPosition(value)}, ${sortValue} COLLATE NOCASE LIMIT $limit`
}

function candidateValues(fact: Fact): string {
    return `SELECT DISTINCT ${fact.value} AS value
        FROM ${fact.source} WHERE ${fact.present} AND ${matchesQuery(fact.value)}`
}

function fileSuggestionsSql(fact: Fact, scoped: boolean): string {
    return scoped ? `
        SELECT DISTINCT CAST(${fact.value} AS TEXT) AS suggestion
        FROM account_visible_items visible
        CROSS JOIN ${ITEM_READ_MODEL} i ON i.id = visible.item_id
        CROSS JOIN media_locations l ON l.id = i.selected_location_id AND l.is_present = 1
        CROSS JOIN ${fact.source} ON ${fact.owner} = l.id
        WHERE visible.account_id = $accountId AND i.is_item_hidden = 0 AND l.is_hidden = 0 AND l.is_ignored = 0
          AND ${fact.present} AND ${matchesQuery(fact.value)}
        ${suggestionOrder(fact.value)}
    ` : `
        SELECT CAST(candidate.value AS TEXT) AS suggestion
        FROM (${candidateValues(fact)}) candidate
        WHERE EXISTS (
            SELECT 1 FROM ${fact.source}
            CROSS JOIN media_locations l ON l.id = ${fact.owner}
            WHERE ${fact.present} AND ${fact.value} = candidate.value
              AND l.is_present = 1 AND l.is_hidden = 0 AND l.is_ignored = 0
              AND l.id = (
                SELECT i.selected_location_id FROM ${ITEM_READ_MODEL} i
                WHERE i.id = l.item_id AND i.is_item_hidden = 0 AND i.is_account_visible = 1
              )
        )
        ${suggestionOrder('candidate.value')}
    `
}

function tmdbSuggestionsSql(fact: Fact, scoped: boolean): string {
    // Use the spelling on a visible entity when several entities have the same value.
    return scoped ? `
        SELECT DISTINCT ${fact.value} AS suggestion
        FROM account_visible_items visible
        CROSS JOIN ${ITEM_READ_MODEL} i ON i.id = visible.item_id
        CROSS JOIN ${fact.source} ON ${fact.owner} = i.entity_id
        WHERE visible.account_id = $accountId AND i.is_hidden = 0 AND i.is_ignored = 0
          AND ${fact.present} AND ${matchesQuery(fact.value)}
        ${suggestionOrder(fact.value, 'suggestion')}
    ` : `
        SELECT suggestion
        FROM (
            SELECT candidate.value, (
                SELECT ${fact.value} FROM ${fact.source}
                WHERE ${fact.present} AND ${fact.value} = candidate.value
                  AND EXISTS (
                      SELECT 1 FROM ${ITEM_READ_MODEL} i
                      WHERE i.entity_id = ${fact.owner} AND i.is_hidden = 0 AND i.is_ignored = 0
                        AND i.is_account_visible = 1
                  )
                LIMIT 1
            ) AS suggestion
            FROM (${candidateValues(fact)}) candidate
        )
        WHERE suggestion IS NOT NULL
        ${suggestionOrder('value')}
    `
}

export function suggestStoredMetadataValues(field: string, query: string, limit: number, accountId?: string): string[] {
    const local = isLocalMediaField(field)
    const definition = local ? localMediaFact(field) : isTmdbFilterField(field) ? tmdbFact(field) : undefined
    if (!definition) return []

    const scoped = hasSmallVisibleItemSet(accountId)
    const fact = readMetadataFact(definition, 'fact', scoped)
    const sql = local ? fileSuggestionsSql(fact, scoped) : tmdbSuggestionsSql(fact, scoped)
    const params = {
        $query: query,
        $limit: Number.isSafeInteger(limit) && limit >= 0 ? limit : DEFAULT_AUTOCOMPLETE_LIMIT
    }
    const db = getDb()
    const rows = accountId
        ? db.query<{ suggestion: string }, typeof params & { $accountId: string }>(
            withAccountLocations(sql, '$accountId')
        ).all({ ...params, $accountId: accountId })
        : db.query<{ suggestion: string }, typeof params>(sql).all(params)
    return rows.map(({ suggestion }) => suggestion)
}

export function getDistinctMetadataValues(column: typeof EFFECTIVE_SUGGESTION_COLUMNS[number], query = ''): string[] {
    const matches = (value: string) => `${value} IS NOT NULL AND ${matchesQuery(value)}`
    const rows = getDb().query(`
        SELECT ${column} AS value FROM media_item_metadata WHERE ${matches(column)}
        UNION
        SELECT candidate.value FROM (
            SELECT DISTINCT ${column} AS value FROM media_entities WHERE ${matches(column)}
        ) candidate
        WHERE EXISTS (
            SELECT 1 FROM media_entities e
            WHERE e.${column} = candidate.value AND EXISTS (
                SELECT 1 FROM media_items i
                WHERE i.entity_id = e.id AND NOT EXISTS (
                    SELECT 1 FROM media_item_metadata m WHERE m.item_id = i.id
                )
            )
        )
    `).all({ $query: query.trim() }) as { value: string | number }[]
    return rows.map(({ value }) => String(value))
}

export function getDistinctGenreNames(): string[] {
    const rows = getDb().query(`
        WITH genre_lists AS (
            SELECT DISTINCT genres_json FROM media_item_metadata WHERE genres_json IS NOT NULL
        )
        SELECT entry.value AS name FROM genre_lists, json_each(genre_lists.genres_json) entry
        UNION
        SELECT g.name FROM genres g WHERE EXISTS (
            SELECT 1 FROM entity_genres eg JOIN media_items i ON i.entity_id = eg.entity_id
            WHERE eg.genre_id = g.id AND NOT EXISTS (
                SELECT 1 FROM media_item_metadata m
                WHERE m.item_id = i.id AND m.genres_json IS NOT NULL
            )
        )
        ORDER BY name
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

export function getCustomTagKeys(): string[] {
    return getDb().query<{ key: string }, []>('SELECT DISTINCT key FROM item_tags').all().map(({ key }) => key)
}

/**
 * Fetches distinct person names from the normalized people table.
 */
export function getDistinctPersonNames(): string[] {
    return (getDb().query("SELECT DISTINCT name FROM people WHERE name <> ''").values() as [string][])
        .map(([name]) => name)
}
