/**
 * TV Parser Tests
 *
 * Tests the pure parsing logic from tv_parsing.md spec.
 * These functions have zero external dependencies and implement
 * the core consensus-based pattern matching algorithm.
 *
 * SPEC: tv_parsing.md §4
 */
import { describe, it, expect } from 'bun:test'
import {
    parseEpisodeInfo,
    parseSeasonFolder,
    isSupportedVideoFile,
    determineEpisodeNumbers,
    determineExplicitSeasonNumbers,
    determineAlphabeticSeasonNumbers,
    determineSeasonNumbers,
} from './tv-parser'

// =================================================================
// isSupportedVideoFile
// =================================================================

describe('isSupportedVideoFile', () => {
    it('recognizes standard video extensions', () => {
        expect(isSupportedVideoFile('movie.mp4')).toBe(true)
        expect(isSupportedVideoFile('movie.mkv')).toBe(true)
        expect(isSupportedVideoFile('movie.avi')).toBe(true)
        expect(isSupportedVideoFile('movie.webm')).toBe(true)
        expect(isSupportedVideoFile('movie.m4v')).toBe(true)
    })

    it('rejects non-video files', () => {
        expect(isSupportedVideoFile('subtitle.srt')).toBe(false)
        expect(isSupportedVideoFile('cover.jpg')).toBe(false)
        expect(isSupportedVideoFile('readme.txt')).toBe(false)
        expect(isSupportedVideoFile('data.nfo')).toBe(false)
    })

    it('is case-insensitive', () => {
        expect(isSupportedVideoFile('MOVIE.MKV')).toBe(true)
        expect(isSupportedVideoFile('Movie.Mp4')).toBe(true)
    })
})

// =================================================================
// parseEpisodeInfo
// SPEC: tv_parsing.md §4, Step 4 — Episode Patterns (Priority Order)
//
// Priority 1: SxxExx  /\bS(\d{1,2})\s?\.?\s?E(\d{1,3})\b/i
// Priority 2: Episode XX  /\bEpisode\s*(\d{1,2})\b/i
// Priority 3: Exx  /\bE(\d{2})\b/i
// =================================================================

describe('parseEpisodeInfo', () => {
    it('extracts SxxExx pattern (priority 1)', () => {
        const result = parseEpisodeInfo('Breaking.Bad.S01E05.mkv')
        expect(result).toEqual({ season: 1, episode: 5, pattern: 'sxxexx' })
    })

    it('handles S with space before E', () => {
        const result = parseEpisodeInfo('Show S02 E10 title.mkv')
        expect(result).toEqual({ season: 2, episode: 10, pattern: 'sxxexx' })
    })

    it('handles 3-digit episode numbers', () => {
        const result = parseEpisodeInfo('Show.S01E150.mkv')
        expect(result).toEqual({ season: 1, episode: 150, pattern: 'sxxexx' })
    })

    it('extracts Episode XX pattern (priority 2)', () => {
        const result = parseEpisodeInfo('Episode 12 - Title.mkv')
        expect(result).toEqual({ episode: 12, pattern: 'episode_xx' })
    })

    it('extracts Exx pattern (priority 3)', () => {
        const result = parseEpisodeInfo('e05.mkv')
        expect(result).toEqual({ episode: 5, pattern: 'exx' })
    })

    // SPEC: tv_parsing.md §6 - Word boundaries prevent false positives
    it('does NOT false-positive on resolution strings like 1080p', () => {
        const result = parseEpisodeInfo('video1080p.mkv')
        expect(result).toBeNull()
    })

    it('returns null for unparseable filenames', () => {
        expect(parseEpisodeInfo('[SubGroup] Show - 01 [720p].mkv')).toBeNull()
    })

    // SxxExx takes priority over Episode XX
    it('SxxExx pattern wins over Episode XX when both are present', () => {
        const result = parseEpisodeInfo('Show S01E05 Episode 5.mkv')
        expect(result?.pattern).toBe('sxxexx')
        expect(result?.episode).toBe(5)
    })
})

// =================================================================
// parseSeasonFolder
// SPEC: tv_parsing.md §4, Step 3 — Season Folder Pattern
//   /\b(?:Season\s*|S)(\d{1,2})\b/i
// =================================================================

describe('parseSeasonFolder', () => {
    it('parses "Season 1"', () => {
        expect(parseSeasonFolder('Season 1')).toBe(1)
    })

    it('parses "S01"', () => {
        expect(parseSeasonFolder('S01')).toBe(1)
    })

    it('parses "Season 02"', () => {
        expect(parseSeasonFolder('Season 02')).toBe(2)
    })

    it('recognizes "Specials" as season 0', () => {
        expect(parseSeasonFolder('Specials')).toBe(0)
    })

    it('returns null for non-season folders', () => {
        expect(parseSeasonFolder('Extras')).toBeNull()
        expect(parseSeasonFolder('First Arc')).toBeNull()
        expect(parseSeasonFolder('Behind the Scenes')).toBeNull()
    })
})

// =================================================================
// determineEpisodeNumbers — Consensus Algorithm
// SPEC: tv_parsing.md §4, Step 4
//
// A pattern achieves consensus if:
//   - It matches ALL files (perfect match), OR
//   - It matches ≥3 files with ≤2 mismatches.
//
// If duplicates exist, falls through to next pattern or alphabetic.
// =================================================================

describe('determineEpisodeNumbers', () => {
    it('achieves consensus with SxxExx pattern', () => {
        const files = [
            'Breaking.Bad.S01E01.mkv',
            'Breaking.Bad.S01E02.mkv',
            'Breaking.Bad.S01E03.mkv',
        ]
        const result = determineEpisodeNumbers(files, 1)

        expect(result.size).toBe(3)
        expect(result.get('Breaking.Bad.S01E01.mkv')?.episode).toBe(1)
        expect(result.get('Breaking.Bad.S01E02.mkv')?.episode).toBe(2)
        expect(result.get('Breaking.Bad.S01E03.mkv')?.episode).toBe(3)
    })

    it('SxxExx pattern extracts season from filename', () => {
        // SPEC: If pattern is SxxExx: also extract seasonNumber from filename (overrides parent)
        const files = ['Show.S02E01.mkv', 'Show.S02E02.mkv']
        const result = determineEpisodeNumbers(files, 1) // parent says season 1

        expect(result.get('Show.S02E01.mkv')?.season).toBe(2) // filename wins
    })

    it('SxxExx duplicate check is season-aware for flat multi-season folders', () => {
        const files = [
            'Invincible.S03E07.1080p.WEB-DL.mkv',
            'Invincible.S03E08.1080p.WEB-DL.mkv',
            'Invincible.2021.S04E05.1080p.WEB.h264.mkv',
            'Invincible.2021.S04E06.1080p.WEB.h264.mkv',
            'Invincible.2021.S04E07.1080p.WEB.h264.mkv'
        ]

        const result = determineEpisodeNumbers(files, 1)

        expect(result.get('Invincible.S03E07.1080p.WEB-DL.mkv')?.season).toBe(3)
        expect(result.get('Invincible.S03E07.1080p.WEB-DL.mkv')?.episode).toBe(7)
        expect(result.get('Invincible.2021.S04E07.1080p.WEB.h264.mkv')?.season).toBe(4)
        expect(result.get('Invincible.2021.S04E07.1080p.WEB.h264.mkv')?.episode).toBe(7)
    })

    it('inherits parent season for Episode XX pattern', () => {
        // SPEC: If pattern is Episode XX: inherit seasonNumber from parent folder
        const files = ['Episode 1.mkv', 'Episode 2.mkv', 'Episode 3.mkv']
        const result = determineEpisodeNumbers(files, 3)

        expect(result.get('Episode 1.mkv')?.season).toBe(3)
        expect(result.get('Episode 1.mkv')?.episode).toBe(1)
    })

    it('tolerates ≤2 mismatches with ≥3 matches (consensus threshold)', () => {
        const files = [
            'Show.S01E01.mkv',
            'Show.S01E02.mkv',
            'Show.S01E03.mkv',
            'bonus_feature.mkv',     // mismatch 1
            'behind_the_scenes.mkv', // mismatch 2
        ]
        const result = determineEpisodeNumbers(files, 1)

        // Should achieve consensus on SxxExx for 3 files
        expect(result.get('Show.S01E01.mkv')?.episode).toBe(1)
        expect(result.get('Show.S01E02.mkv')?.episode).toBe(2)
        expect(result.get('Show.S01E03.mkv')?.episode).toBe(3)
        // Mismatches are not assigned
        expect(result.has('bonus_feature.mkv')).toBe(false)
    })

    it('falls back to alphabetic when no pattern achieves consensus', () => {
        // SPEC: §4 Step 4 — Alphabetic fallback
        const files = [
            '[SubGroup] Show - 01 [720p].mkv',
            '[SubGroup] Show - 02 [720p].mkv',
            '[SubGroup] Show - 03 [720p].mkv',
        ]
        const result = determineEpisodeNumbers(files, 1)

        // Alphabetic sort: these should sort in order
        expect(result.size).toBe(3)
        // All get episode numbers from position
        for (const info of result.values()) {
            expect(info.mediaType).toBe('episode')
            expect(info.season).toBe(1)
        }
    })

    it('falls back to alphabetic when pattern produces duplicate episodes', () => {
        // SPEC: §4 Step 4 — If duplicates exist, strategy fails
        const files = [
            'Show.S01E01.v1.mkv',
            'Show.S01E01.v2.mkv', // duplicate episode 1!
            'Show.S01E02.mkv',
        ]
        const result = determineEpisodeNumbers(files, 1)

        // Should fall through to alphabetic (positions 1,2,3)
        const episodes = [...result.values()].map(v => v.episode).sort()
        expect(episodes).toEqual([1, 2, 3])
    })

    it('uses explicit alphabetic strategy when requested', () => {
        const files = ['Show.S01E05.mkv', 'Show.S01E01.mkv', 'Show.S01E03.mkv']
        const result = determineEpisodeNumbers(files, 1, 'alphabetic')

        // Alphabetic sort ignores regex, assigns by position
        const sorted = files.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        expect(result.get(sorted[0])?.episode).toBe(1)
        expect(result.get(sorted[1])?.episode).toBe(2)
        expect(result.get(sorted[2])?.episode).toBe(3)
    })

    it('ignores non-video files in consensus calculation', () => {
        // SPEC: §6 — Only video files are assigned episode metadata
        const files = [
            'Show.S01E01.mkv',
            'Show.S01E02.mkv',
            'Show.S01E03.mkv',
            'Show.S01E01.srt', // subtitle — should be ignored
        ]
        const result = determineEpisodeNumbers(files, 1)
        expect(result.size).toBe(3) // only video files
        expect(result.has('Show.S01E01.srt')).toBe(false)
    })

    it('returns empty map for no video files', () => {
        const result = determineEpisodeNumbers(['cover.jpg', 'readme.txt'], 1)
        expect(result.size).toBe(0)
    })
})

// =================================================================
// determineExplicitSeasonNumbers
// SPEC: tv_parsing.md §4, Step 3
//
// Only assigns seasons via the Season regex.
// Returns empty map on duplicate season numbers.
// Filters out special folder names (Extras, Specials, etc.).
// =================================================================

describe('determineExplicitSeasonNumbers', () => {
    it('assigns season numbers from regex matches', () => {
        const folders = ['Season 1', 'Season 2', 'Season 3']
        const result = determineExplicitSeasonNumbers(folders)

        expect(result.get('Season 1')?.season).toBe(1)
        expect(result.get('Season 2')?.season).toBe(2)
        expect(result.get('Season 3')?.season).toBe(3)
    })

    it('returns empty map when duplicate season numbers are detected', () => {
        // SPEC: §4 Step 3 — If duplicates exist: fail
        const folders = ['Season 1', 'S01'] // both resolve to season 1
        const result = determineExplicitSeasonNumbers(folders)
        expect(result.size).toBe(0)
    })

    it('ignores special folders', () => {
        // SPEC: §4 — Ignored folder names: Extras, Specials, etc.
        const folders = ['Season 1', 'Extras', 'Deleted Scenes', 'Featurettes', 'OVA']
        const result = determineExplicitSeasonNumbers(folders)
        expect(result.size).toBe(1)
        expect(result.has('Season 1')).toBe(true)
        expect(result.has('OVA')).toBe(false)
    })

    it('returns empty map when no folders match the season pattern', () => {
        const folders = ['First Arc', 'Second Arc', 'Third Arc']
        const result = determineExplicitSeasonNumbers(folders)
        expect(result.size).toBe(0)
    })
})

// =================================================================
// determineAlphabeticSeasonNumbers
// SPEC: tv_parsing.md §4, Step 3 — Alphabetic Assignment
//
// Sort alphabetically with natural sort.
// Assign positions: 1, 2, 3, ...
// =================================================================

describe('determineAlphabeticSeasonNumbers', () => {
    it('assigns season numbers by alphabetic position', () => {
        // SPEC example: First Arc → 1, Second Arc → 2, Third Arc → 3
        const folders = ['First Arc', 'Second Arc', 'Third Arc']
        const result = determineAlphabeticSeasonNumbers(folders)

        expect(result.get('First Arc')?.season).toBe(1)
        expect(result.get('Second Arc')?.season).toBe(2)
        expect(result.get('Third Arc')?.season).toBe(3)
    })

    it('uses natural sort (Part 2 before Part 10)', () => {
        const folders = ['Part 10', 'Part 2', 'Part 1']
        const result = determineAlphabeticSeasonNumbers(folders)

        expect(result.get('Part 1')?.season).toBe(1)
        expect(result.get('Part 2')?.season).toBe(2)
        expect(result.get('Part 10')?.season).toBe(3)
    })

    it('ignores special folders', () => {
        const folders = ['Arc 1', 'Extras', 'OVA', 'Arc 2']
        const result = determineAlphabeticSeasonNumbers(folders)

        expect(result.size).toBe(2)
        expect(result.has('Extras')).toBe(false)
        expect(result.has('OVA')).toBe(false)
    })
})

// =================================================================
// determineSeasonNumbers (legacy wrapper)
// =================================================================

describe('determineSeasonNumbers', () => {
    it('smart: uses explicit regex first, falls back to alphabetic', () => {
        // Should use explicit for these
        const explicit = determineSeasonNumbers(['Season 1', 'Season 2'])
        expect(explicit.get('Season 1')?.season).toBe(1)

        // Should fall back to alphabetic for these
        const alphabetic = determineSeasonNumbers(['First Arc', 'Second Arc'])
        expect(alphabetic.get('First Arc')?.season).toBe(1)
        expect(alphabetic.get('Second Arc')?.season).toBe(2)
    })

    it('alphabetic strategy skips regex entirely', () => {
        const result = determineSeasonNumbers(['S02', 'S01'], 'alphabetic')
        // With alphabetic sort: S01 = 1, S02 = 2 (by position, not regex)
        expect(result.get('S01')?.season).toBe(1)
        expect(result.get('S02')?.season).toBe(2)
    })
})
