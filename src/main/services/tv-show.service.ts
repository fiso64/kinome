import * as repositoryService from './repository.service'
import {
  determineExplicitSeasonNumbers,
  determineAlphabeticSeasonNumbers,
  determineEpisodeNumbers,
  isSupportedVideoFile,
  ParsedTvInfo,
  TvParserDiagnosticSink
} from '../utils/tv-parser'
import type { MediaFolder, MediaFile, LibraryItem } from '@shared/types'
import { updateIfChangedAndBroadcast } from './item-update.service'
import { syncVirtualSeasonFolders } from './grouping.service'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [TV Show Service] ${message}`)
}

const VERBOSE_VALUES = new Set(['1', 'true', 'yes', 'on', 'debug', 'trace', 'verbose'])

function isVerboseTvLoggingEnabled(): boolean {
  return (
    VERBOSE_VALUES.has((process.env.KINOME_VERBOSE || '').toLowerCase()) ||
    VERBOSE_VALUES.has((process.env.KINOME_LOG_LEVEL || '').toLowerCase()) ||
    process.argv.includes('--verbose')
  )
}

function logVerbose(message: string, details?: Record<string, unknown>): void {
  if (!isVerboseTvLoggingEnabled()) return

  const prefix = `[${new Date().toISOString()}] [TV Show Service] [verbose] ${message}`
  if (details) {
    console.log(prefix, details)
  } else {
    console.log(prefix)
  }
}

function createParserDiagnosticSink(context: Record<string, unknown>): TvParserDiagnosticSink | undefined {
  if (!isVerboseTvLoggingEnabled()) return undefined
  return (diagnostic) => {
    logVerbose('TV parser diagnostic.', {
      ...context,
      ...diagnostic
    })
  }
}

/**
 * Syncs the internal season/episode structure of a TV show based on filesystem patterns.
 * This should be called after a folder is identified as a TV Show, or during a rescan
 * of an existing TV Show.
 */
export async function syncTvShowStructure(
  show: MediaFolder,
  seasonStrategy: 'smart' | 'alphabetic' = 'smart',
  episodeStrategy: 'smart' | 'alphabetic' = 'smart',
  options: { force?: boolean; scopedToId?: string } = {}
): Promise<LibraryItem[]> {
  const processingDisabled = show.folderSettings?.processTvChildren === false
  const isTargeted = !!options.scopedToId
  const isForced = !!options.force

  // Guard: Exit if not TV, or if disabled AND neither forced nor targeted.
  if (show.mediaType !== 'tv') return []
  if (processingDisabled && !isForced && !isTargeted) return []

  const allModified: LibraryItem[] = []

  // 1. Fetch immediate children
  const children = repositoryService.getChildren(show.id)
  const folders = children.filter((c) => c.type === 'folder' && !c.isVirtual) as MediaFolder[]
  const files = children.filter((c) => c.type === 'file') as MediaFile[]
  const videoFiles = files.filter((f) => isSupportedVideoFile(f.name))

  logVerbose('Starting TV structure sync.', {
    showId: show.id,
    showName: show.name,
    seasonStrategy,
    episodeStrategy,
    force: isForced,
    scopedToId: options.scopedToId,
    processingDisabled,
    childCount: children.length,
    physicalFolderCount: folders.length,
    fileCount: files.length,
    rootVideoFileCount: videoFiles.length,
    physicalFolders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      mediaType: f.mediaType,
      seasonNumber: f.seasonNumber,
      lockedFields: f.lockedFields
    })),
    rootVideoFiles: videoFiles.map((f) => ({
      id: f.id,
      name: f.name,
      mediaType: f.mediaType,
      seasonNumber: f.seasonNumber,
      episodeNumber: f.episodeNumber,
      lockedFields: f.lockedFields
    }))
  })

  let seasonMap = new Map<string, ParsedTvInfo>()
  let isFlatShow = false

  // --- Hierarchy Strategy ---
  if (seasonStrategy === 'smart') {
    seasonMap = determineExplicitSeasonNumbers(folders.map((f) => f.name))
    if (seasonMap.size === 0) {
      if (videoFiles.length > 0) {
        isFlatShow = true
        logVerbose('No explicit physical season folders found; treating show root as flat episode list.', {
          showId: show.id,
          showName: show.name,
          rootVideoFileCount: videoFiles.length
        })
      } else {
        seasonMap = determineAlphabeticSeasonNumbers(folders.map((f) => f.name))
        logVerbose('No explicit season folders or root video files; using alphabetic season folder assignment.', {
          showId: show.id,
          showName: show.name,
          assignedSeasons: [...seasonMap.entries()].map(([name, info]) => ({ name, season: info.season }))
        })
      }
    }
  } else {
    seasonMap = determineAlphabeticSeasonNumbers(folders.map((f) => f.name))
    logVerbose('Using alphabetic season folder assignment.', {
      showId: show.id,
      showName: show.name,
      assignedSeasons: [...seasonMap.entries()].map(([name, info]) => ({ name, season: info.season }))
    })
  }

  // 2. Process Detected Season Folders
  const seasonsToProcess: MediaFolder[] = []
  if (!isFlatShow) {
    for (const folder of folders) {
      // SCOPE CHECK: If a target ID is provided, skip any folder that isn't the target.
      if (isTargeted && folder.id !== options.scopedToId) {
        continue
      }

      const info = seasonMap.get(folder.name)
      const isManuallyAssignedSeason = folder.mediaType === 'season'

      if ((info && info.mediaType === 'season') || isManuallyAssignedSeason) {
        const isLocked = repositoryService.isFieldLocked(folder, 'seasonNumber')
        const targetSeason = isLocked ? folder.seasonNumber : (info?.season ?? folder.seasonNumber)

        logVerbose('Evaluating physical season folder.', {
          showId: show.id,
          showName: show.name,
          folderId: folder.id,
          folderName: folder.name,
          currentMediaType: folder.mediaType,
          currentSeasonNumber: folder.seasonNumber,
          parsedSeasonNumber: info?.season,
          isManuallyAssignedSeason,
          isSeasonLocked: isLocked,
          targetSeason
        })

        let changedForFolder = false
        if (!isLocked && folder.seasonNumber !== targetSeason) {
          folder.seasonNumber = targetSeason
          folder.title = null
          folder.overview = null
          folder.posterPath = null
          folder.lastRefreshedAt = null
          changedForFolder = true
        }
        if (folder.mediaType !== 'season') {
          folder.mediaType = 'season'
          folder.lastRefreshedAt = null
          changedForFolder = true
        }

        if (changedForFolder) {
          allModified.push(folder)
        }
        seasonsToProcess.push(folder)
      }
    }
  }

  // 3. Process Episodes in Season Folders
  for (const seasonFolder of seasonsToProcess) {
    const seasonChildren = repositoryService.getChildren(seasonFolder.id)
    const seasonFiles = seasonChildren.filter(
      (c) => c.type === 'file' && isSupportedVideoFile(c.name)
    ) as MediaFile[]
    const seasonFileNames = seasonFiles.map((f) => f.name)

    // OPTIMIZATION: If the season folder's number is locked, use it for all children
    // and tell the parser it's a fixed season context.
    const isSeasonLocked = repositoryService.isFieldLocked(seasonFolder, 'seasonNumber')
    const effectiveSeasonNumber = isSeasonLocked
      ? seasonFolder.seasonNumber
      : seasonFolder.seasonNumber

    const episodeMap = determineEpisodeNumbers(
      seasonFileNames,
      effectiveSeasonNumber,
      episodeStrategy,
      createParserDiagnosticSink({
        showId: show.id,
        showName: show.name,
        location: 'physical-season-folder',
        seasonFolderId: seasonFolder.id,
        seasonFolderName: seasonFolder.name,
        effectiveSeasonNumber,
        forcedSeasonNumber: isSeasonLocked ? effectiveSeasonNumber : undefined
      })
    )
    allModified.push(
      ..._applyEpisodeMap(
        seasonFiles,
        episodeMap,
        isSeasonLocked ? effectiveSeasonNumber : undefined,
        {
          showId: show.id,
          showName: show.name,
          location: 'physical-season-folder',
          parentId: seasonFolder.id,
          parentName: seasonFolder.name
        }
      )
    )
  }

  // 4. Process Loose Episodes (in the show root)
  // Flat shows and mixed shows with files in the root cannot be scoped to a Season Folder ID.
  if (!isTargeted && videoFiles.length > 0) {
    // For purely flat shows, fallback to Season 1. For mixed shows, rely entirely on the filename pattern.
    const fallbackSeason = isFlatShow ? 1 : undefined
    const episodeMap = determineEpisodeNumbers(
      videoFiles.map((f) => f.name),
      fallbackSeason,
      episodeStrategy,
      createParserDiagnosticSink({
        showId: show.id,
        showName: show.name,
        location: 'show-root',
        isFlatShow,
        fallbackSeason
      })
    )
    allModified.push(..._applyEpisodeMap(videoFiles, episodeMap, undefined, {
      showId: show.id,
      showName: show.name,
      location: 'show-root',
      parentId: show.id,
      parentName: show.name,
      fallbackSeason,
      isFlatShow
    }))
  }

  // Finalize all structural changes at once to minimize IPC overhead
  if (allModified.length > 0) {
    await updateIfChangedAndBroadcast(allModified)
  }

  // Sync virtual season folders for any loose episodes sitting directly under the show.
  // Must run after updateIfChangedAndBroadcast so season numbers are committed to DB.
  if (videoFiles.length > 0) {
    syncVirtualSeasonFolders(show.id)
  }

  log(
    `[Structure Sync] "${show.name}" scan complete. Found ${allModified.length} internal changes.`
  )
  return allModified
}

/**
 * Applies parsed episode info to a list of media files.
 */
function _applyEpisodeMap(
  files: MediaFile[],
  episodeMap: Map<string, ParsedTvInfo>,
  forcedSeasonNumber?: number | null,
  logContext: Record<string, unknown> = {}
): MediaFile[] {
  const modified: MediaFile[] = []
  for (const file of files) {
    const info = episodeMap.get(file.name)
    if (!info || info.mediaType !== 'episode') {
      logVerbose('No episode assignment produced for file.', {
        ...logContext,
        fileId: file.id,
        fileName: file.name,
        currentMediaType: file.mediaType,
        currentSeasonNumber: file.seasonNumber,
        currentEpisodeNumber: file.episodeNumber
      })
    }
    if (info && info.mediaType === 'episode') {
      const isSeasonLocked = repositoryService.isFieldLocked(file, 'seasonNumber')
      const isEpisodeLocked = repositoryService.isFieldLocked(file, 'episodeNumber')

      let changed = false
      const targetSeason = forcedSeasonNumber !== undefined ? forcedSeasonNumber : info.season
      const before = {
        mediaType: file.mediaType,
        seasonNumber: file.seasonNumber,
        episodeNumber: file.episodeNumber,
        title: file.title,
        lastRefreshedAt: file.lastRefreshedAt
      }

      if (!isSeasonLocked && targetSeason !== undefined && file.seasonNumber !== targetSeason) {
        file.seasonNumber = targetSeason
        file.lastRefreshedAt = null
        changed = true
      }
      if (!isEpisodeLocked && info.episode !== undefined && file.episodeNumber !== info.episode) {
        file.episodeNumber = info.episode
        file.title = null
        file.overview = null
        file.posterPath = null
        file.lastRefreshedAt = null
        changed = true
      }

      if (changed || file.mediaType !== 'episode') {
        file.mediaType = 'episode'
        file.lastRefreshedAt = null
        modified.push(file)
      }

      logVerbose('Applied episode assignment decision.', {
        ...logContext,
        fileId: file.id,
        fileName: file.name,
        parsedSeasonNumber: info.season,
        parsedEpisodeNumber: info.episode,
        forcedSeasonNumber,
        targetSeason,
        isSeasonLocked,
        isEpisodeLocked,
        changed,
        markedModified: modified.includes(file),
        before,
        after: {
          mediaType: file.mediaType,
          seasonNumber: file.seasonNumber,
          episodeNumber: file.episodeNumber,
          title: file.title,
          lastRefreshedAt: file.lastRefreshedAt
        }
      })
    }
  }
  return modified
}
