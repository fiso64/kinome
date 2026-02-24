import type { LibraryItem } from '@shared/types'

export interface RepositoryFieldDef {
    sql: string
    table?: 'i' | 'e' | 'u' | 'f' // i=items, e=media_entities, u=user_state, f=folder_settings
    isJson?: boolean
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
    // Images (direct columns now, not JSON extraction)
    posterPath: { sql: 'e.poster_path', table: 'e' },
    backdropPath: { sql: 'e.backdrop_path', table: 'e' },
    logoPath: { sql: 'e.logo_path', table: 'e' },
    // Entity JSONs
    genres: {
        sql: 'e.genres_json',
        table: 'e',
        isJson: true,
        getValue: (item) => item.genres ?? []
    },
    tags: { sql: 'e.tags_json', table: 'e', isJson: true },
    virtualTags: { sql: 'e.virtual_tags_json', table: 'e', isJson: true },
    tmdbCredits: { sql: 'e.people_json', table: 'e', isJson: true },
    tmdbSeasons: { sql: 'e.seasons_json', table: 'e', isJson: true },
    tmdbEpisodes: { sql: 'e.episodes_json', table: 'e', isJson: true },
    lockedFields: { sql: 'e.locked_fields_json', table: 'e', isJson: true },
    lastRefreshedAt: { sql: 'e.last_refreshed_at', table: 'e' },
    _v: { sql: 'e.version', table: 'e' },

    // User State Table
    watched: { sql: 'u.watched', table: 'u', parser: Boolean },
    lastWatched: { sql: 'u.last_watched_at', table: 'u' },
    continueWatchingDismissed: { sql: 'u.continue_watching_dismissed', table: 'u', parser: Boolean },
    nextUpDismissed: { sql: 'u.next_up_dismissed', table: 'u', parser: Boolean },
    nextUpEpisodeId: { sql: 'u.next_up_episode_id', table: 'u' },

    // Folder Settings
    scraperSettings: { sql: 'f.scraper_settings_json', table: 'f', isJson: true },
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
export function getValuesForKey(item: LibraryItem, key: string): string[] {
    const def = REPOSITORY_SCHEMA[key]
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
