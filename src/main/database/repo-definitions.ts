import type { LibraryItem } from '@shared/types'

export interface RepositoryFieldDef {
    sql: string
    table?: 'i' | 'e' | 'u' | 'f' // i=items, e=media_entities, u=user_state, f=folder_settings
    isJson?: boolean
    isSubquery?: boolean // If true, sql is a self-contained subquery (not a column reference)
    jsonDefault?: any // Default value when JSON is null/empty (only used with isJson)
    parser?: (val: any) => any
    getValue?: (item: LibraryItem) => string[] // Symmetrical logic for in-memory grouping
}


export const REPOSITORY_SCHEMA: Record<string, RepositoryFieldDef> = {
    // Items Table
    id: { sql: 'i.id', table: 'i' },
    parentId: { sql: 'i.parent_id', table: 'i' },
    name: { sql: 'i.name', table: 'i' },
    path: { sql: 'i.path', table: 'i' },
    type: { sql: 'i.type', table: 'i' },
    size: { sql: 'i.size', table: 'i' },
    birthtime: { sql: 'i.birthtime', table: 'i' },
    mtime: { sql: 'i.mtime', table: 'i' },
    isMissing: { sql: 'i.is_missing', table: 'i', parser: Boolean },
    isHidden: { sql: 'i.is_hidden', table: 'i', parser: Boolean },
    isIgnored: { sql: 'i.is_ignored', table: 'i', parser: Boolean },
    isVirtual: { sql: 'i.is_virtual', table: 'i', parser: Boolean },
    virtualType: { sql: 'i.virtual_type', table: 'i' },
    filter: { sql: 'i.filter_json', table: 'i', isJson: true },
    addedAt: { sql: 'i.added_at', table: 'i' },
    addedDaysAgo: { sql: `((cast(strftime('%s','now') as int) - i.added_at / 1000) / 86400)`, table: 'i' },
    // Computed sort keys
    typeRank: { sql: `CASE WHEN e.media_type = 'season' THEN 0 WHEN i.type = 'folder' THEN 1 ELSE 2 END`, table: 'e' },
    displayName: { sql: `COALESCE(e.title, i.name)`, table: 'e' },
    inode: { sql: 'i.inode', table: 'i' },
    deviceId: { sql: 'i.device_id', table: 'i' },
    entityId: { sql: 'i.entity_id', table: 'i' },

    // Media Entities Table
    tmdbId: { sql: 'e.tmdb_id', table: 'e' },
    mediaType: {
        sql: 'e.media_type',
        table: 'e',
        getValue: (item) => (item.mediaType ? [item.mediaType] : [])
    },
    title: { sql: 'e.title', table: 'e' },
    originalTitle: { sql: 'e.original_title', table: 'e' },
    overview: { sql: 'e.overview', table: 'e' },
    releaseDate: { sql: 'e.release_date', table: 'e' },
    runtime: { sql: 'e.runtime', table: 'e' },
    year: {
        sql: 'e.year',
        table: 'e',
        getValue: (item) => (item.year ? [item.year.toString()] : [])
    },
    seasonNumber: { sql: 'e.season_number', table: 'e' },
    episodeNumber: { sql: 'e.episode_number', table: 'e' },
    // Images (direct columns, not JSON extraction)
    posterPath: { sql: 'e.poster_path', table: 'e' },
    backdropPath: { sql: 'e.backdrop_path', table: 'e' },
    logoPath: { sql: 'e.logo_path', table: 'e' },
    // Relational data (hydrated via subqueries)
    genres: {
        sql: `(SELECT json_group_array(g.name) FROM entity_genres eg JOIN genres g ON eg.genre_id = g.id WHERE eg.entity_id = e.id)`,
        isJson: true,
        isSubquery: true,
        jsonDefault: [],
        // json_group_array returns [null] for empty sets
        parser: (val) => Array.isArray(val) ? val.filter((v: any) => v !== null) : [],
        getValue: (item) => item.genres ?? []
    },
    tags: {
        sql: `(SELECT json_group_object(t.key, t.value) FROM entity_tags t WHERE t.entity_id = e.id)`,
        isJson: true,
        isSubquery: true,
        jsonDefault: {},
        // json_group_object returns {"null":null} for empty sets
        parser: (val) => {
            if (!val || typeof val !== 'object' || Array.isArray(val)) return {}
            const cleaned: Record<string, any> = {}
            for (const [k, v] of Object.entries(val)) {
                if (k !== 'null' && v !== null) cleaned[k] = v
            }
            return cleaned
        },
    },
    virtualTags: {
        sql: `(SELECT json_group_object(vt.key, vt.value) FROM entity_virtual_tags vt WHERE vt.entity_id = e.id)`,
        isJson: true,
        isSubquery: true,
        jsonDefault: {},
        parser: (val) => {
            if (!val || typeof val !== 'object' || Array.isArray(val)) return {}
            const cleaned: Record<string, any> = {}
            for (const [k, v] of Object.entries(val)) {
                if (k !== 'null' && v !== null) cleaned[k] = v
            }
            return cleaned
        },
    },
    tmdbCredits: {
        sql: `(SELECT json_group_array(json_object('id', p.id, 'name', p.name, 'profile_path', p.profile_path, 'credit_type', c.credit_type, 'character', c.character, 'job', c.job, 'order', c.display_order)) FROM credits c JOIN people p ON c.person_id = p.id WHERE c.entity_id = e.id)`,
        isJson: true,
        isSubquery: true,
        jsonDefault: null,
        // Restructure flat credits array into {cast, crew} shape
        parser: (val) => {
            if (!Array.isArray(val)) return null
            const nonNull = val.filter((v: any) => v !== null)
            if (nonNull.length === 0) return null
            return {
                cast: nonNull.filter((c: any) => c.credit_type === 'cast')
                    .map((c: any) => ({ id: c.id, name: c.name, profile_path: c.profile_path, character: c.character, order: c.order })),
                crew: nonNull.filter((c: any) => c.credit_type === 'crew')
                    .map((c: any) => ({ id: c.id, name: c.name, profile_path: c.profile_path, job: c.job, order: c.order }))
            }
        },
    },
    lockedFields: { sql: 'e.locked_fields_json', table: 'e', isJson: true, jsonDefault: [] },
    lastRefreshedAt: { sql: 'e.last_refreshed_at', table: 'e' },
    _v: { sql: 'e.version', table: 'e' },

    // User State Table
    watched: { sql: 'u.watched', table: 'u', parser: Boolean },
    lastWatched: { sql: 'u.last_watched_at', table: 'u' },
    continueWatchingDismissed: { sql: 'u.continue_watching_dismissed', table: 'u', parser: Boolean },
    nextUpDismissed: { sql: 'u.next_up_dismissed', table: 'u', parser: Boolean },
    nextUpEpisodeId: { sql: 'u.next_up_episode_id', table: 'u' },

    // Folder Settings
    retrieveChildrenMetadata: { sql: 'f.retrieve_children_metadata', table: 'f', parser: Boolean },
    childrenTypeHint: { sql: 'f.children_type_hint', table: 'f' },
    processTvChildren: { sql: 'f.process_tv_children', table: 'f', parser: Boolean },
    viewSettings: { sql: 'f.view_settings_json', table: 'f', isJson: true }
}

/**
 * Derived list of fields belonging strictly to the physical 'items' table.
 */
export const ITEM_TABLE_FIELDS = Object.entries(REPOSITORY_SCHEMA)
    .filter(([_, def]) => def.table === 'i')
    .map(([alias, _]) => alias)

/**
 * Extracts grouping values from a LibraryItem based on schema definitions.
 */
const FIELD_ALIASES: Record<string, string> = { genre: 'genres' }

export function getValuesForKey(item: LibraryItem, key: string): string[] {
    const resolvedKey = FIELD_ALIASES[key] ?? key
    const def = REPOSITORY_SCHEMA[resolvedKey]
    if (def?.getValue) return def.getValue(item)

    // Handle nested Virtual Tags (vt.Key or virtualTags.Key)
    if (key.startsWith('vt.') || key.startsWith('virtualTags.')) {
        const tagKey = key.split('.')[1]
        const vtags = item.virtualTags as Record<string, any>
        const val = vtags?.[tagKey]
        if (val === undefined || val === null) return []
        return [String(val)]
    }

    // Handle nested Manual Tags (tags.Key)
    if (key.startsWith('tags.')) {
        const tagKey = key.split('.')[1]
        const tags = item.tags as Record<string, any>
        const val = tags?.[tagKey]
        if (val === undefined || val === null) return []
        return [String(val)]
    }

    const val = (item as any)[key]
    if (val === undefined || val === null) return []
    return [String(val)]
}

/**
 * Checks if a string is a valid field in our schema.
 */
export function isValidField(key: string): boolean {
    return key in REPOSITORY_SCHEMA
}
