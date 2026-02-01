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
  if (fileNames.length === 0) return results

  // 1. Try "Consensus" Regex Pattern (Only if strategy is Smart)
  if (strategy === 'smart') {
    const patterns: ('sxxexx' | 'episode_xx' | 'exx')[] = ['sxxexx', 'episode_xx', 'exx']
    const allParsedInfo = fileNames.map((name) => ({ name, parsed: parseEpisodeInfo(name) }))

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
  // Note: The caller is responsible for passing in a SORTED list of fileNames for this to work correctly.
  fileNames.forEach((name, index) => {
    // Only override if not already set (though logic above returns early on success)
    if (!results.has(name)) {
      results.set(name, {
        episode: index + 1,
        season: parentSeasonNumber, // Might be undefined, caller handles
        mediaType: 'episode'
      })
    }
  })

  return results
}

/**
 * Assigns season numbers to a list of folder names based on logic.
 * Returns a map of foldername -> ParsedTvInfo
 */
export function determineSeasonNumbers(
  folderNames: string[],
  strategy: 'smart' | 'alphabetic' = 'smart'
): Map<string, ParsedTvInfo> {
  const results = new Map<string, ParsedTvInfo>()
  const foldersToProcess = folderNames.filter(
    (name) => !SPECIAL_FOLDER_NAMES_FOR_TV.includes(name.toLowerCase())
  )

  if (strategy === 'smart') {
    const remainingFolders: string[] = []

    // 1. Regex Parsing
    for (const name of foldersToProcess) {
      const sNum = parseSeasonFolder(name)
      if (sNum !== null) {
        results.set(name, { season: sNum, mediaType: 'season' })
      } else {
        remainingFolders.push(name)
      }
    }

    // If we have any successful matches, we return early and ignore unnumbered folders
    if (results.size > 0) return results
  }

  // 2. Alphabetic Fallback (or explicit Alphabetic strategy)
  // Sort and assign numerically
  foldersToProcess
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .forEach((name, index) => {
      results.set(name, { season: index + 1, mediaType: 'season' })
    })

  return results
}
