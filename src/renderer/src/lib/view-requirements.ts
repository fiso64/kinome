import type { BaseViewSettings } from '../../../shared/types'

export const CORE_FIELDS = [
    'id',
    'parentId',
    'name',
    'type',
    'mediaType',
    'posterPath',
    'watched',
    'isMissing',
    'year',
    'seasonNumber',
    'episodeNumber'
]

/**
 * A mapping of layout modes to the metadata fields they require to render correctly.
 * This ensures that when switching views, we always fetch the necessary data.
 */
export const VIEW_REQUIRED_FIELDS: Record<string, string[]> = {
    list: [...CORE_FIELDS, 'overview'],
    grid: [...CORE_FIELDS],
    'horizontal-grid': [...CORE_FIELDS],
    tree: [...CORE_FIELDS],
    tabs: [...CORE_FIELDS],
    sections: [...CORE_FIELDS]
}

/**
 * Returns the list of additional fields that need to be fetched for a specific layout.
 * Defaults to an empty array if the layout is unknown.
 *
 * @param layout The layout mode (e.g. 'list', 'grid', 'tabs', 'sections')
 * @param groupBy A grouping key (e.g. 'genre', 'vt.is_anime')
 */
export function getRequiredFieldsForLayout(layout: string, groupBy?: string): string[] {
    const baseFields = VIEW_REQUIRED_FIELDS[layout] ?? []
    const groupFields: string[] = []

    if (groupBy) {
        if (groupBy === 'genre' || groupBy === 'genres') {
            groupFields.push('genres')
        } else if (groupBy.startsWith('vt.') || groupBy === 'virtualTags') {
            groupFields.push('virtualTags')
        } else if (groupBy.startsWith('tags.') || groupBy === 'tags') {
            groupFields.push('tags')
        }
    }

    return [...baseFields, ...groupFields]
}
