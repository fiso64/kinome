/**
 * VIRTUAL FOLDERS SERVICE
 *
 * Owns all write-side operations on virtual folder items:
 *   - compilePoolQuery  — converts a stored PoolQuery descriptor into FindOptions
 *   - applyGrouping     — creates/rebuilds grouping virtual folders for a real folder
 *   - removeGrouping    — tears down grouping virtual folders
 *   - createUserVirtualFolder — creates a user-defined virtual folder
 *   - deleteVirtualFolder     — deletes a user-defined virtual folder
 *
 * The children endpoint (read side) lives in grouping.service.ts and calls
 * compilePoolQuery directly to resolve virtual folder contents.
 */
import crypto from 'crypto'
import { runTransaction } from '../database/client'
import type { FindOptions } from '../database/query-builder'
import {
    insertVirtualItem,
    deleteVirtualItemsByType,
    getDistinctSeasonNumbers,
    getVirtualSeasonFolderIds
} from '../database/repositories/filesystem.repo'
import { mergeSettings } from '../database/repositories/settings.repo'
import { getValuesForKey } from '../database/repo-definitions'
import { find, getItemById, deleteItem } from './repository.service'
import type { PoolQuery } from '@shared/types'

/**
 * Compiles a PoolQuery descriptor into FindOptions for use with find().
 *
 * Always excludes virtual items from results — pool queries operate over
 * real items only, regardless of scope.
 */
export function compilePoolQuery(poolQuery: PoolQuery): FindOptions {
    const options: FindOptions = {
        rawConditions: ['i.is_virtual = 0']
    }

    if (poolQuery.scope?.parentId) {
        options.where = { parentId: poolQuery.scope.parentId }
    }

    if (poolQuery.filters) {
        for (const [key, value] of Object.entries(poolQuery.filters)) {
            if (key === 'addedWithinDays') {
                const n = Number(value)
                options.rawConditions = [
                    ...(options.rawConditions ?? []),
                    `i.added_at > (cast(strftime('%s','now') as int) - ${n} * 86400) * 1000`
                ]
            } else {
                options.where = { ...(options.where ?? {}), [key]: value }
            }
        }
    }

    return options
}

/**
 * Applies a grouping to a real folder.
 *
 * Fetches all real (non-virtual) children, collects unique values for the
 * grouping key, then atomically:
 *   1. Deletes existing grouping virtual folders under this parent.
 *   2. Inserts one new grouping virtual folder per unique value.
 *   3. Sets appliedGrouping on the folder's stored view settings.
 *
 * Real items are never touched.
 */
export function applyGrouping(folderId: string, groupByKey: string): void {
    const realChildren = find({
        where: { parentId: folderId },
        rawConditions: ['i.is_virtual = 0'],
        fields: ['id', 'type', 'mediaType', 'seasonNumber', 'year', 'virtualTags', 'tags', 'genres']
    })

    const uniqueValues = new Set<string>()
    for (const item of realChildren) {
        const vals = getValuesForKey(item, groupByKey)
        if (vals.length === 0) uniqueValues.add('Uncategorized')
        else vals.forEach((v) => uniqueValues.add(v))
    }

    runTransaction(() => {
        deleteVirtualItemsByType(folderId, 'grouping')

        for (const value of uniqueValues) {
            const id = crypto.randomUUID()
            const poolQuery: PoolQuery = {
                scope: { parentId: folderId },
                filters: { [groupByKey]: value }
            }
            insertVirtualItem({
                id,
                parentId: folderId,
                name: value,
                virtualType: 'grouping',
                poolQueryJson: JSON.stringify(poolQuery)
            })
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
    poolQuery?: PoolQuery
): string {
    const id = crypto.randomUUID()
    insertVirtualItem({
        id,
        parentId,
        name,
        virtualType: 'user',
        poolQueryJson: poolQuery ? JSON.stringify(poolQuery) : undefined
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
            const poolQuery: PoolQuery = {
                scope: { parentId: showId },
                filters: { seasonNumber }
            }
            insertVirtualItem({
                id,
                parentId: showId,
                name: `Season ${seasonNumber}`,
                virtualType: 'season',
                poolQueryJson: JSON.stringify(poolQuery),
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
