import * as repositoryService from './repository.service'
import {
    determineSeasonNumbers,
    determineEpisodeNumbers,
    ParsedTvInfo
} from '../utils/tv-parser'
import type { MediaFolder, MediaFile } from '../../shared/types'

/**
 * Syncs the internal season/episode structure of a TV show based on filesystem patterns.
 * This should be called after a folder is identified as a TV Show, or during a rescan
 * of an existing TV Show.
 */
export async function syncTvShowStructure(
    show: MediaFolder,
    seasonStrategy: 'smart' | 'alphabetic' = 'smart',
    episodeStrategy: 'smart' | 'alphabetic' = 'smart'
): Promise<void> {
    if (show.mediaType !== 'tv') return

    // 1. Get current children from DB
    const children = repositoryService.getChildren(show.id)
    const folders = children.filter((c) => c.type === 'folder') as MediaFolder[]
    const files = children.filter((c) => c.type === 'file') as MediaFile[]

    const folderNames = folders.map((f) => f.name)
    const fileNames = files.map((f) => f.name)

    // 2. Identify Seasons
    const seasonMap = determineSeasonNumbers(folderNames, seasonStrategy)

    // 3. Process Season Folders
    const seasonsToProcess: MediaFolder[] = []

    for (const folder of folders) {
        const info = seasonMap.get(folder.name)
        if (info && info.mediaType === 'season') {
            const isLocked = repositoryService.isFieldLocked(folder, 'seasonNumber')
            const targetSeason = isLocked ? folder.seasonNumber : info.season

            if (!isLocked && folder.seasonNumber !== targetSeason) {
                folder.seasonNumber = targetSeason
                // Invalidate metadata if number changed so that rich data (overview, poster) is refetched
                folder.title = null
                folder.overview = null
                folder.posterPath = null
            }
            folder.mediaType = 'season'
            repositoryService.updateItem(folder.id, folder)
            seasonsToProcess.push(folder)
        }
    }

    // 4. Handle Flat Structure vs Season Folders
    if (seasonsToProcess.length === 0 && files.length > 0) {
        // Flat TV show (episodes directly in root) - Assign all to Season 1
        const episodeMap = determineEpisodeNumbers(fileNames, 1, episodeStrategy)
        _applyEpisodeMap(files, episodeMap)
    } else {
        // Process episodes inside detected season folders
        for (const seasonFolder of seasonsToProcess) {
            const seasonChildren = repositoryService.getChildren(seasonFolder.id)
            const seasonFiles = seasonChildren.filter((c) => c.type === 'file') as MediaFile[]
            const seasonFileNames = seasonFiles.map((f) => f.name)

            const episodeMap = determineEpisodeNumbers(seasonFileNames, seasonFolder.seasonNumber, episodeStrategy)
            _applyEpisodeMap(seasonFiles, episodeMap)
        }
    }
}

/**
 * Applies parsed episode info to a list of media files.
 */
function _applyEpisodeMap(files: MediaFile[], episodeMap: Map<string, ParsedTvInfo>): void {
    for (const file of files) {
        const info = episodeMap.get(file.name)
        if (info && info.mediaType === 'episode') {
            const isSeasonLocked = repositoryService.isFieldLocked(file, 'seasonNumber')
            const isEpisodeLocked = repositoryService.isFieldLocked(file, 'episodeNumber')

            let changed = false
            if (!isSeasonLocked && info.season !== undefined && file.seasonNumber !== info.season) {
                file.seasonNumber = info.season
                changed = true
            }
            if (!isEpisodeLocked && info.episode !== undefined && file.episodeNumber !== info.episode) {
                file.episodeNumber = info.episode
                // Invalidate metadata for new episode number
                file.title = null
                file.overview = null
                file.posterPath = null
                changed = true
            }

            if (changed || file.mediaType !== 'episode') {
                file.mediaType = 'episode'
                repositoryService.updateItem(file.id, file)
            }
        }
    }
}

