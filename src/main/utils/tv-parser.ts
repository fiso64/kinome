export const VIDEO_EXTENSIONS = [
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  '.mpg',
  '.mpeg'
]

export function isSupportedVideoFile(fileName: string): boolean {
  const ext = fileName.toLowerCase().slice(Math.max(0, fileName.lastIndexOf('.')) || Infinity)
  return VIDEO_EXTENSIONS.includes(ext)
}

export function parseEpisodeInfo(
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

export function parseSeasonFolder(name: string): number | null {
  if (/specials/i.test(name)) return 0
  const seasonPattern = /\b(?:Season\s*|S)(\d{1,2})\b/i
  const match = name.match(seasonPattern)
  if (match) return parseInt(match[1])
  return null
}

const SPECIAL_FOLDER_NAMES_FOR_TV = ['extras', 'specials', 'deleted scenes', 'featurettes', 'nc']

export interface ParsedTvInfo {
  season?: number | null
  episode?: number | null
  mediaType?: 'season' | 'episode' | null
}

/**
 * Assigns episode numbers to a list of files based on consensus strategy.
 * Returns a map of filename -> ParsedTvInfo
 */
export function determineEpisodeNumbers(
  fileNames: string[],
  parentSeasonNumber?: number | null,
  strategy: 'smart' | 'alphabetic' = 'smart'
): Map<string, ParsedTvInfo> {
  const results = new Map<string, ParsedTvInfo>()

  // Filter for video files first to avoid diluting consensus with .srt/etc.
  const videoFiles = fileNames.filter(isSupportedVideoFile)
  if (videoFiles.length === 0) return results

  // 1. Try "Consensus" Regex Pattern (Only if strategy is Smart)
  if (strategy === 'smart') {
    const patterns: ('sxxexx' | 'episode_xx' | 'exx')[] = ['sxxexx', 'episode_xx', 'exx']
    const allParsedInfo = videoFiles.map((name) => ({ name, parsed: parseEpisodeInfo(name) }))

    for (const currentPattern of patterns) {
      const matches = allParsedInfo.filter((info) => info.parsed?.pattern === currentPattern)
      const mismatches = allParsedInfo.length - matches.length

      // Tolerance: If mismatches are low (<= 2) and matches are sufficient (>= 3), or perfect match
      if (mismatches === 0 || (mismatches <= 2 && matches.length >= 3)) {
        // Apply this pattern
        matches.forEach(({ name, parsed }) => {
          if (parsed) {
            results.set(name, {
              episode: parsed.episode,
              season: parsed.season ?? parentSeasonNumber,
              mediaType: 'episode'
            })
          }
        })
        return results
      }
    }
  }

  // 2. Alphabetic Fallback (or explicit Alphabetic strategy)
  // Sort and assign based on position among video files
  videoFiles
    .slice()
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .forEach((name, index) => {
      results.set(name, {
        episode: index + 1,
        season: parentSeasonNumber,
        mediaType: 'episode'
      })
    })

  return results
}

/**
 * Only assigns season numbers if they match the explicit Season regex (e.g. S01, Season 1).
 */
export function determineExplicitSeasonNumbers(folderNames: string[]): Map<string, ParsedTvInfo> {
  const results = new Map<string, ParsedTvInfo>()
  const foldersToProcess = folderNames.filter(
    (name) => !SPECIAL_FOLDER_NAMES_FOR_TV.includes(name.toLowerCase())
  )

  for (const name of foldersToProcess) {
    const sNum = parseSeasonFolder(name)
    if (sNum !== null) {
      results.set(name, { season: sNum, mediaType: 'season' })
    }
  }

  return results
}

/**
 * Assigns season numbers to a list of folder names alphabetically.
 */
export function determineAlphabeticSeasonNumbers(folderNames: string[]): Map<string, ParsedTvInfo> {
  const results = new Map<string, ParsedTvInfo>()
  const foldersToProcess = folderNames.filter(
    (name) => !SPECIAL_FOLDER_NAMES_FOR_TV.includes(name.toLowerCase())
  )

  foldersToProcess
    .slice()
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .forEach((name, index) => {
      results.set(name, { season: index + 1, mediaType: 'season' })
    })

  return results
}

/**
 * Legacy wrapper for old callers. Now delegates to the prioritized building blocks.
 * Note: Use the building blocks directly for better control.
 */
export function determineSeasonNumbers(
  folderNames: string[],
  strategy: 'smart' | 'alphabetic' = 'smart'
): Map<string, ParsedTvInfo> {
  if (strategy === 'smart') {
    const explicit = determineExplicitSeasonNumbers(folderNames)
    if (explicit.size > 0) return explicit
  }
  return determineAlphabeticSeasonNumbers(folderNames)
}
