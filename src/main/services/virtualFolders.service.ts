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
    getVirtualSeasonFolderIds
} from '../database/repositories/filesystem.repo'
import { mergeSettings } from '../database/repositories/settings.repo'
import { upsertMetadata } from '../database/repositories/metadata.repo'
import { getValuesForKey } from '../database/repo-definitions'
import { find, getItemById } from './repository.service'
import { compileFilter } from '../database/query-builder'
import { displayTitle } from '@shared/display-names'
import type { LibraryFilter, MediaFolder } from '@shared/types'

/**
 * Applies a grouping to a folder (real or virtual).
 *
 * Fetches all real (non-virtual) children, collects unique values for the
 * grouping key, then atomically:
 *   1. Deletes existing grouping virtual folders under this parent.
 *   2. Inserts one new grouping virtual folder per unique value.
 *   3. Sets appliedGrouping on the folder's stored view settings.
 *
 * For virtual folders, children are resolved via the folder's filter.
 * Real items are never touched.
 */
export function applyGrouping(folderId: string, groupByKey: string): void {
    const folder = getItemById(folderId) as MediaFolder | null
    const fields = ['id', 'type', 'mediaType', 'seasonNumber', 'year', 'virtualTags', 'tags', 'genres']

    let realChildren
    if (folder?.isVirtual && folder.filter) {
        // Virtual folder: resolve children via its filter
        const compiled = compileFilter(folder.filter)
        realChildren = find({ ...compiled, fields })
    } else {
        // Real folder: direct parent_id lookup
        realChildren = find({
            where: { parentId: folderId },
            rawConditions: ['i.is_virtual = 0'],
            fields
        })
    }

    // Determine the scope for grouping filters: for virtual folders,
    // inherit the parent's filter scope; for real folders, scope to self.
    const filterScope = (folder?.isVirtual && folder.filter?.scope)
        ? folder.filter.scope
        : { parentId: folderId }

    const uniqueValues = new Set<string>()
    let hasUncategorized = false
    for (const item of realChildren) {
        const vals = getValuesForKey(item, groupByKey)
        if (vals.length === 0) hasUncategorized = true
        else vals.forEach((v) => uniqueValues.add(v))
    }

    runTransaction(() => {
        deleteVirtualItemsByType(folderId, 'grouping')

        for (const value of uniqueValues) {
            const id = crypto.randomUUID()
            const filter: LibraryFilter = {
                scope: filterScope,
                conditions: [{ field: groupByKey, op: 'eq', value }]
            }
            insertVirtualItem({
                id,
                parentId: folderId,
                name: value,
                virtualType: 'grouping',
                filterJson: JSON.stringify(filter)
            })
            upsertMetadata(id, { title: displayTitle(groupByKey, value) })
        }

        if (hasUncategorized) {
            const id = crypto.randomUUID()
            const filter: LibraryFilter = {
                scope: filterScope,
                conditions: [{ field: groupByKey, op: 'isNull' }]
            }
            insertVirtualItem({
                id,
                parentId: folderId,
                name: 'Uncategorized',
                virtualType: 'grouping',
                filterJson: JSON.stringify(filter)
            })
            upsertMetadata(id, { title: 'Uncategorized' })
        }

        mergeSettings(folderId, { viewSettings: { appliedGrouping: groupByKey } })
    })
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
