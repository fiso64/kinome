import { LibraryItem, MediaFolder } from '../../shared/types'
import { isValidField } from './repository.service'

export const VIRTUAL_ID_PREFIX = 'virtual--'

export function isVirtualId(id: string): boolean {
    return id.startsWith(VIRTUAL_ID_PREFIX)
}

export function parseVirtualId(id: string): { parentId: string | null; tokens: string[] | null } {
    if (!isVirtualId(id)) return { parentId: null, tokens: null }
    const parts = id.split('--')
    // ID format: virtual--{parentId}--{token1}--{token2}
    if (parts.length < 3) return { parentId: null, tokens: null }

    return {
        parentId: parts[1],
        tokens: parts.slice(2)
    }
}

/**
 * Resolves a virtual ID into a set of database filter options.
 * This dynamically maps tokens (e.g., "mediaType:movie") to schema fields.
 */
export function getFiltersFromId(id: string): Record<string, any> {
    const { parentId, tokens } = parseVirtualId(id)
    if (!parentId || !tokens) return {}

    const filters: Record<string, any> = {
        parentId
    }

    for (const token of tokens) {
        const separatorIndex = token.indexOf(':')
        if (separatorIndex === -1) continue

        const key = token.substring(0, separatorIndex)
        const value = token.substring(separatorIndex + 1)

        // 1. Handle Shorthand / Normalization
        if (key === 'genre' || key === 'genres') {
            filters['genres'] = value
        } else if (key === 'folder') {
            // Handle Mixed Content Grouping (Seasons/files)
            if (value.startsWith('__season_')) {
                const seasonNum = parseInt(value.replace('__season_', '').replace('__', ''), 10)
                if (!isNaN(seasonNum)) {
                    filters['seasonNumber'] = seasonNum
                }
            } else if (value === '__files__') {
                // 'Files' usually means things without a season number or explicity unseasoned?
                // For now, let's assume it means seasonNumber is null
                // BUT repository.find might not support explicit null check via typical query?
                // v2.ts parser handles 'null' string.
                // We'll set it to null.
                filters['seasonNumber'] = null
            }
        } else if (key === 'virtualTags' || key.startsWith('vt.')) {
            const tagKey = key.startsWith('vt.') ? key.split('.')[1] : null
            if (tagKey) {
                filters[`virtualTags.${tagKey}`] = value
            }
        } else if (key === 'tags' || key.startsWith('tags.')) {
            const tagKey = key.startsWith('tags.') ? key.replace('tags.', '') : null
            if (tagKey) {
                filters[`tags.${tagKey}`] = value
            }
        }
        // 2. Dynamic Schema Fallback
        else if (isValidField(key)) {
            filters[key] = value
        }
    }

    return filters
}

/**
 * Pure factory function to construct a Virtual Folder based on its ID and resolved Parent.
 */
export function buildVirtualItem(id: string, parent: MediaFolder): LibraryItem {
    const { tokens } = parseVirtualId(id)
    // Should verify tokens exist, but assuming correct usage from ID check
    if (!tokens || tokens.length === 0) {
        throw new Error(`Invalid virtual ID: ${id}`)
    }

    // Resolve Virtual Folder Settings
    const settingsKey = tokens.join('/')
    let appliedSettings: any = {}
    if (parent.virtualFolderSettings && parent.virtualFolderSettings[settingsKey]) {
        appliedSettings = parent.virtualFolderSettings[settingsKey]
    }

    const lastToken = tokens[tokens.length - 1]
    const name = lastToken.includes(':') ? lastToken.split(':')[1] : lastToken

    const item: LibraryItem = {
        id: id,
        parentId: parent.id,
        name: name,
        type: 'folder',
        mediaType: parent.mediaType, // Inherit media type (e.g. 'movie' context)
        isMissing: false,
        isHidden: false,
        path: `virtual/${tokens.join('/')}`,
        isVirtual: true,
        children: [], // Lazy load
        virtualFolderSettings: parent.virtualFolderSettings, // Propagate settings for nested lookups
        ...(parent.childViewSettings || {}), // Inherit generic child view settings (e.g. layout, groupBy)
        ...appliedSettings // Apply specific override (takes precedence)
    }

    return item
}
