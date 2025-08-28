import path from 'path'
import fs from 'fs/promises'
import type { LibraryItem, MediaFile, MediaFolder } from '../../shared/types'
import * as pathsService from './paths.service'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [TV Show Service] ${message}`)
}

const SPECIAL_FOLDER_NAMES_FOR_TV = ['extras', 'specials', 'deleted scenes', 'featurettes', 'nc']

function parseEpisodeInfo(
  name: string
): { season?: number; episode: number; pattern: 'sxxexx' | 'episode_xx' | 'exx' } | null {
  const sxxexxPatterns = [/\bS(\d{1,2})\s?\.?\s?E(\d{1,3})\b/i, /S(\d{1,2})E(\d{1,3})/i]
  for (const pattern of sxxexxPatterns) {
    const match = name.match(pattern)
    if (match) return { season: parseInt(match[1]), episode: parseInt(match[2]), pattern: 'sxxexx' }
  }
  const episodeXXPattern = /\bEpisode\s*(\d{1,2})\b/i
  const episodeMatch = name.match(episodeXXPattern)
  if (episodeMatch) return { episode: parseInt(episodeMatch[1]), pattern: 'episode_xx' }
  const exxPattern = /\bE(\d{2})\b/i
  const exxMatch = name.match(exxPattern)
  if (exxMatch) return { episode: parseInt(exxMatch[1]), pattern: 'exx' }
  return null
}

function processAndAssignEpisodeNumbers(files: MediaFile[], parentSeasonNumber?: number): boolean {
  if (files.length === 0) return true
  const patterns: ('sxxexx' | 'episode_xx' | 'exx')[] = ['sxxexx', 'episode_xx', 'exx']
  const allParsedInfo = files.map((file) => ({ file, parsed: parseEpisodeInfo(file.name) }))
  for (const currentPattern of patterns) {
    const matches = allParsedInfo.filter((info) => info.parsed?.pattern === currentPattern)
    const mismatches = allParsedInfo.length - matches.length
    if (mismatches === 0 || (mismatches <= 2 && matches.length >= 3)) {
      log(
        `Applying pattern "${currentPattern}". Matches: ${matches.length}, Mismatches: ${mismatches}`
      )
      matches.forEach(({ file, parsed }) => {
        if (parsed) {
          file.mediaType = 'episode'
          file.episodeNumber = parsed.episode
          file.seasonNumber = parsed.season ?? parentSeasonNumber
        }
      })
      return true
    }
  }
  return false
}

export function processTvShowStructure(showFolder: MediaFolder): void {
  log(`Analyzing TV structure for: "${showFolder.name}"`)
  const allSubFolders = showFolder.children.filter(
    (c) => c.type === 'folder' && !SPECIAL_FOLDER_NAMES_FOR_TV.includes(c.name.toLowerCase())
  ) as MediaFolder[]
  const assignNewEpisodeNumbers = (files: MediaFile[], seasonNum: number) => {
    const unnumbered = files.filter((f) => typeof f.episodeNumber !== 'number')
    if (unnumbered.length === 0) return
    log(`Found ${unnumbered.length} new episodes in Season ${seasonNum}.`)
    const maxExistingEpisode = Math.max(0, ...files.map((f) => f.episodeNumber ?? 0))
    unnumbered.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    unnumbered.forEach((file, i) => {
      file.episodeNumber = maxExistingEpisode + i + 1
      file.seasonNumber = seasonNum
      file.mediaType = 'episode'
    })
  }
  const immediateFiles = showFolder.children.filter((c) => c.type === 'file') as MediaFile[]
  if (immediateFiles.length > 0) {
    assignNewEpisodeNumbers(immediateFiles, 1)
    return
  }
  if (allSubFolders.length > 0) {
    const seasonPattern = /\b(?:Season\s*|S)(\d{1,2})\b/i
    const unnumberedFolders = allSubFolders.filter((f) => typeof f.seasonNumber !== 'number')
    for (const folder of unnumberedFolders) {
      const match = folder.name.match(seasonPattern)
      if (match) {
        folder.seasonNumber = parseInt(match[1])
        folder.mediaType = 'season'
      }
    }
    const stillUnnumbered = allSubFolders.filter((f) => typeof f.seasonNumber !== 'number')
    if (stillUnnumbered.length > 0) {
      const maxExistingSeason = Math.max(0, ...allSubFolders.map((f) => f.seasonNumber ?? 0))
      stillUnnumbered.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      stillUnnumbered.forEach((folder, i) => {
        folder.seasonNumber = maxExistingSeason + i + 1
        folder.mediaType = 'season'
      })
    }
    for (const seasonFolder of allSubFolders) {
      if (typeof seasonFolder.seasonNumber === 'number') {
        const episodeFiles = seasonFolder.children.filter((c) => c.type === 'file') as MediaFile[]
        assignNewEpisodeNumbers(episodeFiles, seasonFolder.seasonNumber)
      }
    }
  }
}

export function assignEpisodesByStrategy(
  files: MediaFile[],
  seasonNumber: number,
  strategy: 'smart' | 'alphabetic'
) {
  if (strategy === 'alphabetic') {
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    files.forEach((file, index) => {
      file.seasonNumber = seasonNumber
      file.episodeNumber = index + 1
      file.mediaType = 'episode'
    })
    return
  }
  const parsedSuccessfully = processAndAssignEpisodeNumbers(files, seasonNumber)
  if (!parsedSuccessfully) {
    log('Smart Fallback: High-confidence parsing failed, falling back to alphabetical.')
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    files.forEach((file, index) => {
      file.seasonNumber = seasonNumber
      file.episodeNumber = index + 1
      file.mediaType = 'episode'
    })
  }
}

export function assignSeasonsAndEpisodesByStrategy(
  showFolder: MediaFolder,
  seasonStrategy: 'smart' | 'alphabetic',
  episodeStrategy: 'smart' | 'alphabetic'
) {
  const mediaFiles = showFolder.children.filter((c) => c.type === 'file') as MediaFile[]
  const subFolders = showFolder.children.filter(
    (c) => c.type === 'folder' && !SPECIAL_FOLDER_NAMES_FOR_TV.includes(c.name.toLowerCase())
  ) as MediaFolder[]
  const assignEpisodeFunc = (files: MediaFile[], season: number) =>
    assignEpisodesByStrategy(files, season, episodeStrategy)
  if (mediaFiles.length > 0) {
    assignEpisodeFunc(mediaFiles, 1)
    return
  }
  if (subFolders.length > 0) {
    if (seasonStrategy === 'smart') {
      const seasonPattern = /\b(?:Season\s*|S)(\d{1,2})\b/i
      const parsedFolders: { folder: MediaFolder; season: number }[] = []
      for (const folder of subFolders) {
        const seasonMatch = folder.name.match(seasonPattern)
        if (seasonMatch) {
          parsedFolders.push({ folder, season: parseInt(seasonMatch[1]) })
        }
      }
      if (parsedFolders.length > 0) {
        for (const { folder, season } of parsedFolders) {
          folder.seasonNumber = season
          folder.mediaType = 'season'
          const episodeFiles = folder.children.filter((c) => c.type === 'file') as MediaFile[]
          assignEpisodeFunc(episodeFiles, season)
        }
        return
      }
    }
    subFolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    subFolders.forEach((folder, index) => {
      const season = index + 1
      folder.seasonNumber = season
      folder.mediaType = 'season'
      const episodeFiles = folder.children.filter((c) => c.type === 'file') as MediaFile[]
      assignEpisodeFunc(episodeFiles, season)
    })
  }
}

export async function clearTvStructureMetadata(
  folder: MediaFolder,
  imagesDir: string,
  modifiedItems: Set<LibraryItem>
): Promise<void> {
  for (const child of folder.children) {
    let wasModified = false
    if (child.posterPath) {
      if (!pathsService.isRemoteLibrary()) {
        try {
          await fs.unlink(path.join(imagesDir, child.posterPath))
        } catch (e) {}
      }
      child.posterPath = undefined
      wasModified = true
    }
    if (child.title) {
      child.title = undefined
      wasModified = true
    }
    if (child.overview) {
      child.overview = undefined
      wasModified = true
    }
    if (child.mediaType === 'season' || child.mediaType === 'episode') {
      child.mediaType = undefined
      wasModified = true
    }
    if ('seasonNumber' in child && child.seasonNumber !== undefined) {
      child.seasonNumber = undefined
      wasModified = true
    }
    if ('episodeNumber' in child && child.episodeNumber !== undefined) {
      child.episodeNumber = undefined
      wasModified = true
    }
    if ('tmdbDetailsFetched' in child && child.tmdbDetailsFetched) {
      child.tmdbDetailsFetched = false
      wasModified = true
    }
    if ('tmdbEpisodesFetched' in child && child.tmdbEpisodesFetched) {
      child.tmdbEpisodesFetched = false
      wasModified = true
    }
    if ('tmdbEpisodes' in child && child.tmdbEpisodes) {
      child.tmdbEpisodes = undefined
      wasModified = true
    }
    if (wasModified) modifiedItems.add(child)
    if (child.type === 'folder') await clearTvStructureMetadata(child, imagesDir, modifiedItems)
  }
}
