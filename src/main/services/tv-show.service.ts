import * as repositoryService from './repository.service'
import {
    determineExplicitSeasonNumbers,
    determineAlphabeticSeasonNumbers,
    determineEpisodeNumbers,
    isSupportedVideoFile,
    ParsedTvInfo
} from '../utils/tv-parser'
import type { MediaFolder, MediaFile, LibraryItem } from '../../shared/types'
import { updateIfChangedAndBroadcast } from './item-update.service'

/**
 * Syncs the internal season/episode structure of a TV show based on filesystem patterns.
 * This should be called after a folder is identified as a TV Show, or during a rescan
 * of an existing TV Show.
 */
export async function syncTvShowStructure(
    show: MediaFolder,
    seasonStrategy: 'smart' | 'alphabetic' = 'smart',
    episodeStrategy: 'smart' | 'alphabetic' = 'smart',
    options: { force?: boolean } = {}
): Promise<LibraryItem[]> {
    if (show.mediaType !== 'tv' || (show.process_tv_children === false && !options.force)) return []

    const allModified: LibraryItem[] = []

    // 1. Fetch immediate children
    const children = repositoryService.getChildren(show.id)
    const folders = children.filter((c) => c.type === 'folder') as MediaFolder[]
    const files = children.filter((c) => c.type === 'file') as MediaFile[]
    const videoFiles = files.filter((f) => isSupportedVideoFile(f.name))

    let seasonMap = new Map<string, ParsedTvInfo>()
    let isFlatShow = false

    // --- Hierarchy Strategy ---
    if (seasonStrategy === 'smart') {
        seasonMap = determineExplicitSeasonNumbers(folders.map((f) => f.name))
        if (seasonMap.size === 0) {
            if (videoFiles.length > 0) {
                isFlatShow = true
            } else {
                seasonMap = determineAlphabeticSeasonNumbers(folders.map((f) => f.name))
            }
        }
    } else {
        seasonMap = determineAlphabeticSeasonNumbers(folders.map((f) => f.name))
    }

    // 2. Process Detected Season Folders
    const seasonsToProcess: MediaFolder[] = []
    if (!isFlatShow) {
        for (const folder of folders) {
            const info = seasonMap.get(folder.name)
            if (info && info.mediaType === 'season') {
                const isLocked = repositoryService.isFieldLocked(folder, 'seasonNumber')
                const targetSeason = isLocked ? folder.seasonNumber : info.season

                let changedForFolder = false
                if (!isLocked && folder.seasonNumber !== targetSeason) {
                    folder.seasonNumber = targetSeason
                    folder.title = null
                    folder.overview = null
                    folder.posterPath = null
                    changedForFolder = true
                }
                if (folder.mediaType !== 'season') {
                    folder.mediaType = 'season'
                    changedForFolder = true
                }

                if (changedForFolder) {
                    allModified.push(folder)
                }
                seasonsToProcess.push(folder)
            }
        }
    }

    // 3. Process Episodes
    if (isFlatShow) {
        const episodeMap = determineEpisodeNumbers(
            videoFiles.map((f) => f.name),
            1,
            episodeStrategy
        )
        allModified.push(..._applyEpisodeMap(videoFiles, episodeMap))
    } else {
        for (const seasonFolder of seasonsToProcess) {
            const seasonChildren = repositoryService.getChildren(seasonFolder.id)
            const seasonFiles = seasonChildren.filter(
                (c) => c.type === 'file' && isSupportedVideoFile(c.name)
            ) as MediaFile[]
            const seasonFileNames = seasonFiles.map((f) => f.name)

            // OPTIMIZATION: If the season folder's number is locked, use it for all children
            // and tell the parser it's a fixed season context.
            const isSeasonLocked = repositoryService.isFieldLocked(seasonFolder, 'seasonNumber')
            const effectiveSeasonNumber = isSeasonLocked ? seasonFolder.seasonNumber : seasonFolder.seasonNumber

            const episodeMap = determineEpisodeNumbers(
                seasonFileNames,
                effectiveSeasonNumber,
                episodeStrategy
            )
            allModified.push(..._applyEpisodeMap(seasonFiles, episodeMap, isSeasonLocked ? effectiveSeasonNumber : undefined))
        }
    }

    // Finalize all structural changes at once to minimize IPC overhead
    if (allModified.length > 0) {
        await updateIfChangedAndBroadcast(allModified)
    }

    return allModified
}

/**
 * Applies parsed episode info to a list of media files.
 */
function _applyEpisodeMap(
    files: MediaFile[],
    episodeMap: Map<string, ParsedTvInfo>,
    forcedSeasonNumber?: number | null
): MediaFile[] {
    const modified: MediaFile[] = []
    for (const file of files) {
        const info = episodeMap.get(file.name)
        if (info && info.mediaType === 'episode') {
            const isSeasonLocked = repositoryService.isFieldLocked(file, 'seasonNumber')
            const isEpisodeLocked = repositoryService.isFieldLocked(file, 'episodeNumber')

            let changed = false
            const targetSeason = forcedSeasonNumber !== undefined ? forcedSeasonNumber : info.season

            if (!isSeasonLocked && targetSeason !== undefined && file.seasonNumber !== targetSeason) {
                file.seasonNumber = targetSeason
                changed = true
            }
            if (
                !isEpisodeLocked &&
                info.episode !== undefined &&
                file.episodeNumber !== info.episode
            ) {
                file.episodeNumber = info.episode
                file.title = null
                file.overview = null
                file.posterPath = null
                changed = true
            }

            if (changed || file.mediaType !== 'episode') {
                file.mediaType = 'episode'
                modified.push(file)
            }
        }
    }
    return modified
}
