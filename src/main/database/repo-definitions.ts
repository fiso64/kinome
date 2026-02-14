import type { LibraryItem } from '@shared/types'

export interface RepositoryFieldDef {
    sql: string
    table?: 'i' | 'm' | 'u' | 'f' // Dependency table
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

    // Metadata Table
    tmdbId: { sql: 'm.tmdb_id', table: 'm' },
    mediaType: {
        sql: 'm.media_type',
        table: 'm',
        getValue: (item) => (item.mediaType ? [item.mediaType] : [])
    },
    title: { sql: 'm.title', table: 'm' },
    originalTitle: { sql: 'm.original_title', table: 'm' },
    overview: { sql: 'm.overview', table: 'm' },
    releaseDate: { sql: 'm.release_date', table: 'm' },
    runtime: { sql: 'm.runtime', table: 'm' },
    year: {
        sql: 'm.year',
        table: 'm',
        getValue: (item) => (item.year ? [item.year.toString()] : [])
    },
    seasonNumber: { sql: 'm.season_number', table: 'm' },
    episodeNumber: { sql: 'm.episode_number', table: 'm' },
    // Images (JSON extraction helpers)
    posterPath: { sql: "json_extract(m.images_json, '$.poster')", table: 'm' },
    backdropPath: { sql: "json_extract(m.images_json, '$.backdrop')", table: 'm' },
    logoPath: { sql: "json_extract(m.images_json, '$.logo')", table: 'm' },
    // Metadata JSONs
    genres: {
        sql: 'm.genres_json',
        table: 'm',
        isJson: true,
        getValue: (item) => item.genres ?? []
    },
    tags: { sql: 'm.tags_json', table: 'm', isJson: true },
    virtualTags: { sql: 'm.virtual_tags_json', table: 'm', isJson: true },
    tmdbCredits: { sql: 'm.people_json', table: 'm', isJson: true },
    tmdbSeasons: { sql: 'm.seasons_json', table: 'm', isJson: true },
    tmdbEpisodes: { sql: 'm.episodes_json', table: 'm', isJson: true },
    lockedFields: { sql: 'm.locked_fields_json', table: 'm', isJson: true },
    lastRefreshedAt: { sql: 'm.last_refreshed_at', table: 'm' },
    _v: { sql: 'm.version', table: 'm' },

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
