import { isSupportedVideoFile } from '@shared/local-media'
export { isSupportedVideoFile } from '@shared/local-media'

const EPISODE_PATTERNS = [
  'sxxexx', 'episode_xx', 'exx', 'absolute'
] as const
type EpisodePattern = (typeof EPISODE_PATTERNS)[number]

// The negative lookahead keeps a year or resolution from being read as a fractional digit.
const EPISODE_NUMBER = String.raw`(\d{1,3}(?:\.\d(?!\d))?)`
const SXXEXX_PATTERNS = [
  new RegExp(String.raw`\bS(\d{1,2})\s?\.?\s?E${EPISODE_NUMBER}\b`, 'i'),
  new RegExp(String.raw`S(\d{1,2})E${EPISODE_NUMBER}\b`, 'i')
]
const EPISODE_XX_PATTERN = new RegExp(String.raw`\bEpisode\s*${EPISODE_NUMBER}\b`, 'i')
const EXX_PATTERN = new RegExp(String.raw`\bE${EPISODE_NUMBER}\b`, 'i')
const ABSOLUTE_PATTERN = new RegExp(
  String.raw`\s-\s+${EPISODE_NUMBER}(?=v\d+\b|[\s.\[(]|$)`,
  'i'
)

function getFractionalDigit(episode: number): number {
  return Math.round(episode * 10) % 10
}

function getSeasonSuffix(episodes: (number | undefined)[]): number | undefined {
  const digitCounts = new Map<number, number>()
  for (const episode of episodes) {
    const digit = episode === undefined ? 0 : getFractionalDigit(episode)
    digitCounts.set(digit, (digitCounts.get(digit) ?? 0) + 1)
  }

  for (const [digit, count] of digitCounts) {
    if (digit === 0 || count < 2 || count < episodes.length - 1) continue

    const distinctEpisodes = new Set(episodes)
    const normalized = new Set(episodes.map((episode) =>
      episode !== undefined && getFractionalDigit(episode) === digit ? Math.trunc(episode) : episode
    ))
    if (normalized.size === distinctEpisodes.size) return digit
  }
}

export function parseEpisodeInfo(
  name: string
): { season?: number; episode: number; pattern: EpisodePattern } | null {
  for (const pattern of SXXEXX_PATTERNS) {
    const match = name.match(pattern)
    if (match) return { season: Number(match[1]), episode: Number(match[2]), pattern: 'sxxexx' }
  }
  const episodeMatch = name.match(EPISODE_XX_PATTERN)
  if (episodeMatch) return { episode: Number(episodeMatch[1]), pattern: 'episode_xx' }
  const exxMatch = name.match(EXX_PATTERN)
  if (exxMatch) return { episode: Number(exxMatch[1]), pattern: 'exx' }
  const absoluteMatch = name.match(ABSOLUTE_PATTERN)
  if (absoluteMatch) return { episode: Number(absoluteMatch[1]), pattern: 'absolute' }
  return null
}

export function parseSeasonFolder(name: string): number | null {
  if (/specials/i.test(name)) return 0
  const match = name.match(/\b(?:Season\s*|S)(\d{1,2})\b/i)
    ?? name.match(/\bS(\d{1,2})E\d{1,3}\s*[-–]\s*(?:S\1E|E)?\d{1,3}\b/i)
  return match ? Number(match[1]) : null
}

export const SPECIAL_FOLDER_NAMES_FOR_TV = [
  'extras',
  'specials',
  'ova',
  'deleted scenes',
  'featurettes',
  'nc',
  'behind the scenes'
]

export function isSpecialTvFolderName(name: string): boolean {
  return SPECIAL_FOLDER_NAMES_FOR_TV.includes(name.toLowerCase())
}

export interface ParsedTvInfo {
  season?: number | null
  episode?: number | null
  mediaType?: 'season' | 'episode' | null
}

export type TvParserDiagnostic =
  | {
      event: 'determineEpisodeNumbers:start'
      strategy: 'smart' | 'alphabetic'
      parentSeasonNumber?: number | null
      inputCount: number
      videoCount: number
      ignoredCount: number
    }
  | {
      event: 'determineEpisodeNumbers:pattern'
      pattern: EpisodePattern
      matches: number
      mismatches: number
      matchedFiles: { name: string; season?: number; episode: number }[]
    }
  | {
      event: 'determineEpisodeNumbers:duplicate'
      pattern: EpisodePattern
      duplicateKey: string
      fileName: string
    }
  | {
      event: 'determineEpisodeNumbers:selectedPattern'
      pattern: EpisodePattern
      assigned: { name: string; season?: number | null; episode: number }[]
    }
  | {
      event: 'determineEpisodeNumbers:fallback'
      reason: string
      assigned: { name: string; season?: number | null; episode: number }[]
    }

export type TvParserDiagnosticSink = (diagnostic: TvParserDiagnostic) => void

/**
 * Assigns episode numbers to a list of files based on consensus strategy.
 * Returns a map of filename -> ParsedTvInfo
 */
export function determineEpisodeNumbers(
  fileNames: string[],
  parentSeasonNumber?: number | null,
  strategy: 'smart' | 'alphabetic' = 'smart',
  diagnostic?: TvParserDiagnosticSink
): Map<string, ParsedTvInfo> {
  const results = new Map<string, ParsedTvInfo>()

  // Filter for video files first to avoid diluting consensus with .srt/etc.
  const videoFiles = fileNames.filter(isSupportedVideoFile)
  diagnostic?.({
    event: 'determineEpisodeNumbers:start',
    strategy,
    parentSeasonNumber,
    inputCount: fileNames.length,
    videoCount: videoFiles.length,
    ignoredCount: fileNames.length - videoFiles.length
  })
  if (videoFiles.length === 0) return results

  // 1. Try "Consensus" Regex Pattern (Only if strategy is Smart)
  if (strategy === 'smart') {
    const allParsedInfo = videoFiles.map((name) => ({ name, parsed: parseEpisodeInfo(name) }))

    for (const currentPattern of EPISODE_PATTERNS) {
      const matches = allParsedInfo.filter((info) => info.parsed?.pattern === currentPattern)
      const mismatches = allParsedInfo.length - matches.length
      diagnostic?.({
        event: 'determineEpisodeNumbers:pattern',
        pattern: currentPattern,
        matches: matches.length,
        mismatches,
        matchedFiles: matches.flatMap(({ name, parsed }) =>
          parsed ? [{ name, season: parsed.season, episode: parsed.episode }] : []
        )
      })

      // Tolerance: If mismatches are low (<= 2) and matches are sufficient (>= 3), or perfect match
      if (mismatches === 0 || (mismatches <= 2 && matches.length >= 3)) {
        // --- Check for Uniqueness ---
        const episodesSeen = new Set<string>()
        let hasDuplicate = false
        let hasFractionalEpisodes = false
        for (const info of matches) {
          if (info.parsed) {
            hasFractionalEpisodes ||= !Number.isInteger(info.parsed.episode)
            const seasonKey = info.parsed.season ?? parentSeasonNumber ?? 'unknown'
            const episodeKey = `${seasonKey}:${info.parsed.episode}`
            if (episodesSeen.has(episodeKey)) {
              diagnostic?.({
                event: 'determineEpisodeNumbers:duplicate',
                pattern: currentPattern,
                duplicateKey: episodeKey,
                fileName: info.name
              })
              hasDuplicate = true
              break
            }
            episodesSeen.add(episodeKey)
          }
        }

        if (hasDuplicate) {
          // If duplicates exist, this pattern is ambiguous. Move to next pattern or fallback.
          continue
        }

        // A fractional digit shared by all or all but one episode looks like a suffix.
        const seasonSuffixes = hasFractionalEpisodes ? new Map<number | undefined, number>() : undefined
        if (seasonSuffixes) {
          const episodesBySeason = new Map<number | undefined, (number | undefined)[]>()
          for (const { parsed } of allParsedInfo) {
            const season = parsed?.season ?? parentSeasonNumber ?? undefined
            const episodes = episodesBySeason.get(season)
            if (episodes) episodes.push(parsed?.episode)
            else episodesBySeason.set(season, [parsed?.episode])
          }
          for (const [season, episodes] of episodesBySeason) {
            const suffix = getSeasonSuffix(episodes)
            if (suffix !== undefined) seasonSuffixes.set(season, suffix)
          }
        }

        // Apply this pattern
        matches.forEach(({ name, parsed }) => {
          if (parsed) {
            const season = parsed.season ?? parentSeasonNumber
            const suffix = seasonSuffixes?.get(season ?? undefined)
            results.set(name, {
              episode: suffix !== undefined && suffix === getFractionalDigit(parsed.episode)
                ? Math.trunc(parsed.episode)
                : parsed.episode,
              season,
              mediaType: 'episode'
            })
          }
        })
        diagnostic?.({
          event: 'determineEpisodeNumbers:selectedPattern',
          pattern: currentPattern,
          assigned: [...results.entries()].map(([name, info]) => ({
            name,
            season: info.season,
            episode: info.episode as number
          }))
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

  diagnostic?.({
    event: 'determineEpisodeNumbers:fallback',
    reason: strategy === 'alphabetic' ? 'explicit alphabetic strategy' : 'no regex pattern reached consensus',
    assigned: [...results.entries()].map(([name, info]) => ({
      name,
      season: info.season,
      episode: info.episode as number
    }))
  })

  return results
}

/**
 * Only assigns season numbers if they match the explicit Season regex (e.g. S01, Season 1).
 */
export function determineExplicitSeasonNumbers(folderNames: string[]): Map<string, ParsedTvInfo> {
  const results = new Map<string, ParsedTvInfo>()
  const foldersToProcess = folderNames.filter((name) => !isSpecialTvFolderName(name))

  const seasonsSeen = new Set<number>()
  const tempResults = new Map<string, number>()

  for (const name of foldersToProcess) {
    const sNum = parseSeasonFolder(name)
    if (sNum !== null) {
      if (seasonsSeen.has(sNum)) {
        // DUPLICATED SEASON DETECTED
        // Return empty map to trigger alphabetic fallback
        return new Map<string, ParsedTvInfo>()
      }
      seasonsSeen.add(sNum)
      tempResults.set(name, sNum)
    }
  }

  for (const [name, sNum] of tempResults) {
    results.set(name, { season: sNum, mediaType: 'season' })
  }

  return results
}

/**
 * Assigns season numbers to a list of folder names alphabetically.
 */
export function determineAlphabeticSeasonNumbers(folderNames: string[]): Map<string, ParsedTvInfo> {
  const results = new Map<string, ParsedTvInfo>()
  const foldersToProcess = folderNames.filter((name) => !isSpecialTvFolderName(name))

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
