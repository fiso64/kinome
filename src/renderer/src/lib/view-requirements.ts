import type { BaseViewSettings, Settings } from '../../../shared/types'
import { CORE_FIELDS } from '../../../shared/types'


/**
 * Fields required for the ItemDetail header and primary metadata.
 */
export const DETAIL_HEADER_FIELDS = [
    ...CORE_FIELDS,
    'title',
    'overview',
    'backdropPath',
    'logoPath',
    'runtime',
    'releaseDate',
    'genres',
    'tags',
    'tmdbId',
    '_v'
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

/**
 * Recursively collects all required fields from a settings object and its nested childViewSettings.
 * This handles deep nesting scenarios like Sections -> Tabs -> List.
 *
 * @param settings The fully resolved view settings object (optionally merged with an item for type context) <-- TODO: Merging is retarded, clean it up.
 */
export function getAllRequiredFields(settings: any): string[] {
    const fields = new Set<string>()

    function traverse(currentSettings: any) {
        if (!currentSettings || typeof currentSettings !== 'object') return

        if (currentSettings.layout) {
            const req = getRequiredFieldsForLayout(currentSettings.layout, currentSettings.groupBy)
            req.forEach((f) => fields.add(f))
        }

        if (currentSettings.childViewSettings) {
            traverse(currentSettings.childViewSettings)
        }

        if (currentSettings.virtualFolderSettings) {
            Object.values(currentSettings.virtualFolderSettings).forEach((v) => traverse(v))
        }
    }

    traverse(settings)
    return Array.from(fields)
}
