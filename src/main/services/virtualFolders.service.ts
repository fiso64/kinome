/**
 * VIRTUAL FOLDERS SERVICE
 *
 * Owns all write-side operations on virtual folder items:
 *   - applyGrouping     — creates/rebuilds grouping virtual folders for a real folder
 *   - removeGrouping    — tears down grouping virtual folders
 *   - createUserVirtualFolder — creates a user-defined virtual folder
 *   - deleteVirtualFolder     — deletes a user-defined virtual folder
 *   - syncVirtualSeasonFolders — syncs season virtual folders for a flat TV show
 *
 * The children endpoint (read side) lives in grouping.service.ts and calls
 * compileFilter (from query-builder) directly to resolve virtual folder contents.
 */
import crypto from 'crypto'
import { runTransaction } from '../database/client'
import {
    insertVirtualItem,
    deleteVirtualItemsByType,
    deleteItem,
    getDistinctSeasonNumbers,
    getVirtualSeasonFolderIds,
    getVirtualGroupingFolderIds,
    getFoldersWithActiveGrouping
} from '../database/repositories/filesystem.repo'
import { mergeSettings } from '../database/repositories/settings.repo'
import { upsertMetadata } from '../database/repositories/metadata.repo'
import { getValuesForKey } from '../database/repo-definitions'
import { find, getItemById } from './repository.service'
import { compileFilter } from '../database/query-builder'
import { fetchSettings } from '../database/repositories/settings.repo'
import { parseJsonSafe } from '../database/mappers'
import { displayTitle } from '@shared/display-names'
import type { LibraryCondition, LibraryFilter, MediaFolder } from '@shared/types'

/**
 * Deterministic ID for a grouping virtual folder.
 * Stable across re-syncs so folder_settings (user customizations) are preserved.
 */
function groupingFolderId(parentId: string, groupByKey: string, value: string): string {
    return crypto.createHash('sha256').update(`virtual:grouping:${parentId}:${groupByKey}:${value}`).digest('hex')
}

/**
 * Resolves the real children and filter scope for a folder (real or virtual).
 * Shared by applyGrouping and syncGrouping.
 */
function resolveChildrenAndScope(folderId: string) {
    const folder = getItemById(folderId) as MediaFolder | null
    if (!folder) throw new Error(`applyGrouping: folder '${folderId}' not found`)
    const fields = ['id', 'type', 'mediaType', 'seasonNumber', 'year', 'virtualTags', 'tags', 'genres']

    let realChildren
    if (folder.isVirtual && folder.filter) {
        const compiled = compileFilter(folder.filter)
        realChildren = find({ ...compiled, fields })
    } else {
        realChildren = find({
            where: { parentId: folderId },
            rawConditions: ['i.is_virtual = 0'],
            fields
        })
    }

    // Build the inherited filter base for sub-grouping folders.
    // Sub-groupings intersect the parent's filter with their own grouping condition.
    let inheritedFilter: LibraryFilter
    if (folder.isVirtual && folder.filter) {
        inheritedFilter = folder.filter
    } else {
        inheritedFilter = { scope: { parentId: folderId } }
    }

    return { realChildren, inheritedFilter }
}

/**
 * Collects unique values for a grouping key from a set of items.
 */
function collectUniqueValues(items: any[], groupByKey: string) {
    const uniqueValues = new Set<string>()
    let hasUncategorized = false
    for (const item of items) {
        const vals = getValuesForKey(item, groupByKey)
        if (vals.length === 0) hasUncategorized = true
        else vals.forEach((v) => uniqueValues.add(v))
    }
    return { uniqueValues, hasUncategorized }
}

/**
 * Builds a grouping sub-folder filter by intersecting the parent's filter
 * with an additional grouping condition.
 * If the parent uses conditionGroups, the condition is appended to each group.
 * If it uses flat conditions (or none), a single group is built.
 */
function buildGroupingFilter(parent: LibraryFilter, extra: LibraryCondition): LibraryFilter {
    const groups = parent.conditionGroups
        ?? (parent.conditions ? [parent.conditions] : [[]])
    return {
        scope: parent.scope,
        conditionGroups: groups.map(group => [...group, extra]),
    }
}

/**
 * Applies a grouping to a folder (real or virtual).
 *
 * Uses deterministic IDs so re-applying preserves existing folder settings.
 * Incrementally adds new groups and removes orphaned ones.
 */
export function applyGrouping(folderId: string, groupByKey: string): void {
    const { realChildren, inheritedFilter } = resolveChildrenAndScope(folderId)
    const { uniqueValues, hasUncategorized } = collectUniqueValues(realChildren, groupByKey)

    // Build the desired set of IDs
    const desiredIds = new Set<string>()
    for (const value of uniqueValues) {
        desiredIds.add(groupingFolderId(folderId, groupByKey, value))
    }
    if (hasUncategorized) {
        desiredIds.add(groupingFolderId(folderId, groupByKey, '__uncategorized__'))
    }

    const existingIds = new Set(getVirtualGroupingFolderIds(folderId))

    // Fast path: nothing changed — skip the write transaction
    const unchanged = desiredIds.size === existingIds.size && [...desiredIds].every(id => existingIds.has(id))

    if (!unchanged) {
        runTransaction(() => {
            // Remove orphaned grouping folders
            for (const existingId of existingIds) {
                if (!desiredIds.has(existingId)) {
                    deleteItem(existingId)
                }
            }

            // Add new grouping folders (insertOrIgnore preserves existing rows)
            for (const value of uniqueValues) {
                const id = groupingFolderId(folderId, groupByKey, value)
                const filter = buildGroupingFilter(inheritedFilter, { field: groupByKey, op: 'eq', value })
                insertVirtualItem({
                    id,
                    parentId: folderId,
                    name: value,
                    virtualType: 'grouping',
                    filterJson: JSON.stringify(filter),
                    insertOrIgnore: true
                })
                // Only set default title for newly created folders — preserve user edits
                if (!existingIds.has(id)) {
                    upsertMetadata(id, { title: displayTitle(groupByKey, value) })
                }
            }

            if (hasUncategorized) {
                const id = groupingFolderId(folderId, groupByKey, '__uncategorized__')
                const filter = buildGroupingFilter(inheritedFilter, { field: groupByKey, op: 'isNull' })
                insertVirtualItem({
                    id,
                    parentId: folderId,
                    name: 'Uncategorized',
                    virtualType: 'grouping',
                    filterJson: JSON.stringify(filter),
                    insertOrIgnore: true
                })
                if (!existingIds.has(id)) {
                    upsertMetadata(id, { title: 'Uncategorized' })
                }
            }

            mergeSettings(folderId, { viewSettings: { appliedGrouping: groupByKey } })
        })
    }

    // Propagate nested groupings from parent's childViewSettings.
    // If the parent says "children should group by X", apply that to each
    // newly created grouping folder (up to a reasonable depth).
    const parentRow = fetchSettings(folderId)
    const parentViewSettings = parseJsonSafe(parentRow?.view_settings_json, {}) as any
    const childGroupBy = parentViewSettings?.childViewSettings?.groupBy
    if (childGroupBy && childGroupBy !== 'folder' && childGroupBy !== groupByKey) {
        for (const id of desiredIds) {
            applyGrouping(id, childGroupBy)
        }
    }
}

/**
 * Re-syncs all active groupings.
 *
 * Called after item metadata changes to keep grouping folders in sync.
 * For each folder with appliedGrouping, diffs the current unique values
 * against existing grouping folders and incrementally adds/removes as needed.
 * Deterministic IDs ensure existing folder settings are preserved.
 */
export function syncAllGroupings(): void {
    const activeGroupings = getFoldersWithActiveGrouping()
    for (const { item_id, group_by_key } of activeGroupings) {
        applyGrouping(item_id, group_by_key)
    }
}

/**
 * Removes a grouping from a real folder.
 *
 * Deletes all grouping virtual children and clears appliedGrouping.
 * Real children are untouched.
 */
export function removeGrouping(folderId: string): void {
    runTransaction(() => {
        deleteVirtualItemsByType(folderId, 'grouping')
        mergeSettings(folderId, { viewSettings: { appliedGrouping: null } })
    })
}

/**
 * Creates a user-defined virtual folder under the given parent.
 * Returns the new folder's UUID.
 */
export function createUserVirtualFolder(
    parentId: string,
    name: string,
    filter?: LibraryFilter
): string {
    const id = crypto.randomUUID()
    insertVirtualItem({
        id,
        parentId,
        name,
        virtualType: 'user',
        filterJson: filter ? JSON.stringify(filter) : undefined
    })
    return id
}

/**
 * Syncs virtual season folders for a flat TV show (episodes loose under the show root).
 *
 * Called as a post-step after syncTvShowStructure assigns season numbers to files.
 * Uses deterministic IDs (sha256('virtual:season:' + showId + ':' + seasonNumber))
 * so INSERT OR IGNORE is a no-op on existing folders, preserving their folder_settings.
 *
 * Orphaned virtual season folders (season no longer present in episodes) are deleted.
 * If no seasons are found, all virtual season folders are cleaned up and
 * appliedGrouping is cleared.
 */
export function syncVirtualSeasonFolders(showId: string): void {
    const seasonNumbers = getDistinctSeasonNumbers(showId)

    if (seasonNumbers.length === 0) {
        runTransaction(() => {
            deleteVirtualItemsByType(showId, 'season')
            mergeSettings(showId, { viewSettings: { appliedGrouping: null } })
        })
        return
    }

    const currentIds = new Set(seasonNumbers.map((n) => seasonFolderId(showId, n)))
    const existingIds = getVirtualSeasonFolderIds(showId)

    runTransaction(() => {
        for (const existingId of existingIds) {
            if (!currentIds.has(existingId)) {
                deleteItem(existingId)
            }
        }

        for (const seasonNumber of seasonNumbers) {
            const id = seasonFolderId(showId, seasonNumber)
            const filter: LibraryFilter = {
                scope: { parentId: showId },
                conditions: [{ field: 'seasonNumber', op: 'eq', value: seasonNumber }]
            }
            insertVirtualItem({
                id,
                parentId: showId,
                name: `Season ${seasonNumber}`,
                virtualType: 'season',
                filterJson: JSON.stringify(filter),
                insertOrIgnore: true
            })
            upsertMetadata(id, { seasonNumber, mediaType: 'season' })
        }

        mergeSettings(showId, { viewSettings: { appliedGrouping: 'seasonNumber' } })
    })
}

function seasonFolderId(showId: string, seasonNumber: number): string {
    return crypto.createHash('sha256').update(`virtual:season:${showId}:${seasonNumber}`).digest('hex')
}

/**
 * Deletes a user-created virtual folder.
 * folder_settings cascade-delete automatically via FK.
 * Throws if the target item is not a user virtual folder.
 */
export function deleteVirtualFolder(id: string): void {
    const item = getItemById(id)
    if (!item || !item.isVirtual || item.virtualType !== 'user') {
        throw new Error(`deleteVirtualFolder: item ${id} is not a user virtual folder`)
    }
    deleteItem(id)
}
