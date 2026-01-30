
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
    season?: number
    episode?: number
    mediaType?: 'season' | 'episode'
}

/**
 * Assigns episode numbers to a list of files based on consensus strategy.
 * Returns a map of filename -> ParsedTvInfo
 */
export function determineEpisodeNumbers(
    fileNames: string[],
    parentSeasonNumber?: number
): Map<string, ParsedTvInfo> {
    const results = new Map<string, ParsedTvInfo>()
    if (fileNames.length === 0) return results

    // 1. Try "Consensus" Regex Pattern
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

    // 2. Alphabetic Fallback (if no high-confidence consensus)
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
    folderNames: string[]
): Map<string, ParsedTvInfo> {
    const results = new Map<string, ParsedTvInfo>()
    const remainingFolders: string[] = []

    // 1. Regex Parsing
    for (const name of folderNames) {
        if (SPECIAL_FOLDER_NAMES_FOR_TV.includes(name.toLowerCase())) continue

        const sNum = parseSeasonFolder(name)
        if (sNum !== null) {
            results.set(name, { season: sNum, mediaType: 'season' })
        } else {
            remainingFolders.push(name)
        }
    }

    // 2. Fallback for unnumbered folders
    // Whether this is desirable is a user choice, but it was requested to be restored.
    // If we have some unnumbered season folders, we assign them sequentially
    // starting after the highest existing season number.
    if (remainingFolders.length > 0) {
        let maxExisting = 0
        for (const info of results.values()) {
            if (typeof info.season === 'number') maxExisting = Math.max(maxExisting, info.season)
        }

        // Caller must ensure folderNames was sorted input, so remainingFolders preserves that order
        remainingFolders.forEach((name, index) => {
            results.set(name, {
                season: maxExisting + index + 1,
                mediaType: 'season'
            })
        })
    }

    return results
}
