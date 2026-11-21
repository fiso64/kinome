import { describe, it, expect } from 'bun:test'
import {
    parseEpisodeForReconciliation as parseEpisodeInfo,
    parseEpisodeName,
    parseSeasonForFilesystem as parseSeasonFolder,
    parseSeasonName,
    isSupportedVideoFile,
    determineEpisodeNumbers,
    determineExplicitSeasonNumbers,
    determineAlphabeticSeasonNumbers,
} from './tv-parser'

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

describe('episode moves retain their existing parser', () => {
    it.each(['Show.S01E20.5.mkv', 'Episode 20.5 - Recap.mkv', 'Show.E20.5.mkv', '[Group] Show - 20.5 [720p].mkv'])(
        'preserves decimal episodes in %s',
        (name) => expect(parseEpisodeInfo(name)?.episode).toBe(20.5)
    )

    it.each([
        'Show.S01E02.2022.mkv',
        'ShowS01E02.1080p.mkv',
        'Episode 02.25 - Title.mkv',
        'Show.E02.2022.mkv',
        '[Group] Show - 02.25v2 [720p].mkv'
    ])('uses the whole episode number from %s', (name) => {
        expect(parseEpisodeInfo(name)?.episode).toBe(2)
    })

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
        expect(parseEpisodeInfo('[SubGroup] Show [720p].mkv')).toBeNull()
    })

    // SxxExx takes priority over Episode XX
    it('SxxExx pattern wins over Episode XX when both are present', () => {
        const result = parseEpisodeInfo('Show S01E05 Episode 5.mkv')
        expect(result?.pattern).toBe('sxxexx')
        expect(result?.episode).toBe(5)
    })
})

describe('filesystem season detection retains its existing parser', () => {
    it('parses "Season 1"', () => {
        expect(parseSeasonFolder('Season 1')).toBe(1)
    })

    it('parses "S01"', () => {
        expect(parseSeasonFolder('S01')).toBe(1)
    })

    it('parses "Season 02"', () => {
        expect(parseSeasonFolder('Season 02')).toBe(2)
    })

    it('parses a season pack named with an episode range', () => {
        expect(parseSeasonFolder('Anime.Name.2021.S03E01-E14.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-Releaser')).toBe(3)
        expect(parseSeasonFolder('Show.S03E01-S03E14')).toBe(3)
    })

    it('does not treat an individual episode or a cross-season range as one season pack', () => {
        expect(parseSeasonFolder('Show.S03E01.1080p')).toBeNull()
        expect(parseSeasonFolder('Show.S03E01-S04E14')).toBeNull()
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

describe('determineEpisodeNumbers', () => {
    it('drops a fractional digit shared by all episodes in a season folder', () => {
        const files = ['Episode 2.3.mkv', 'Episode 5.3.mkv', 'Episode 10.3.mkv']
        const result = determineEpisodeNumbers(files, 1)

        expect(files.map((name) => result.get(name)?.episode)).toEqual([2, 5, 10])
    })

    it('checks for shared fractional digits separately in each season of a flat show', () => {
        const files = [
            'Show.S01E02.5.mkv', 'Show.S01E03.5.mkv',
            'Show.S02E20.mkv', 'Show.S02E20.5.mkv', 'Show.S02E21.mkv',
            'Show.S03E01.5.mkv'
        ]
        const result = determineEpisodeNumbers(files)

        expect(files.map((name) => result.get(name)?.episode)).toEqual([2, 3, 20, 20.5, 21, 1.5])
    })

    it('preserves different fractional digits within one season', () => {
        const files = ['Show.S01E02.4.mkv', 'Show.S01E02.5.mkv']
        const result = determineEpisodeNumbers(files)

        expect(files.map((name) => result.get(name)?.episode)).toEqual([2.4, 2.5])
    })

    it.each([
        [[20.5, 21, 21.5, 22], [20.5, 21, 21.5, 22]],
        [[1, 2.5, 3, 4, 5, 6.5, 7, 8, 9, 10], [1, 2.5, 3, 4, 5, 6.5, 7, 8, 9, 10]],
        [[2.5, 3.5, 4, 5.5], [2, 3, 4, 5]],
        [[2.5, 3.5, 4.7, 5.5], [2, 3, 4.7, 5]],
        [[2.5, 3.5, 3, 5.5], [2.5, 3.5, 3, 5.5]]
    ])('assigns season episodes %j as %j', (episodeNumbers, expected) => {
        const files = episodeNumbers.map((episode) => `Show.S01E${episode}.mkv`)
        const result = determineEpisodeNumbers(files)

        expect(files.map((name) => result.get(name)?.episode)).toEqual(expected)
    })

    it('assigns explicit episode coordinates', () => {
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

    it('leaves extras outside the episode assignments', () => {
        const files = [
            'Show.S01E01.mkv',
            'Show.S01E02.mkv',
            'Show.S01E03.mkv',
            'bonus_feature.mkv',     // mismatch 1
            'behind_the_scenes.mkv', // mismatch 2
        ]
        const result = determineEpisodeNumbers(files, 1)

        expect(result.get('Show.S01E01.mkv')?.episode).toBe(1)
        expect(result.get('Show.S01E02.mkv')?.episode).toBe(2)
        expect(result.get('Show.S01E03.mkv')?.episode).toBe(3)
        // Mismatches are not assigned
        expect(result.has('bonus_feature.mkv')).toBe(false)
    })

    it('falls back to numeric alphabetic order for unnumbered names in a known season', () => {
        const result = determineEpisodeNumbers(['Vignette 10 - Red.mkv', 'Vignette 2 - Blue.mkv'], 1)
        expect([...result.entries()].map(([name, info]) => [name, info.episode]))
            .toEqual([['Vignette 2 - Blue.mkv', 1], ['Vignette 10 - Red.mkv', 2]])
    })

    it('preserves duplicate claims without renumbering unrelated episodes', () => {
        // SPEC: §4 Step 4 — If duplicates exist, strategy fails
        const files = [
            'Show.S01E01.v1.mkv',
            'Show.S01E01.v2.mkv', // duplicate episode 1!
            'Show.S01E02.mkv',
        ]
        const result = determineEpisodeNumbers(files, 1)

        const episodes = [...result.values()].map(v => v.episode).sort()
        expect(episodes).toEqual([1, 1, 2])
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

    it('ignores non-video files', () => {
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

describe('determineExplicitSeasonNumbers', () => {
    it('assigns season numbers from regex matches', () => {
        const folders = ['Season 1', 'Season 2', 'Season 3']
        const result = determineExplicitSeasonNumbers(folders)

        expect(result.get('Season 1')?.season).toBe(1)
        expect(result.get('Season 2')?.season).toBe(2)
        expect(result.get('Season 3')?.season).toBe(3)
    })

    it('preserves duplicate season claims', () => {
        const folders = ['Season 1', 'S01'] // both resolve to season 1
        const result = determineExplicitSeasonNumbers(folders)
        expect([...result.values()].map(({ season }) => season)).toEqual([1, 1])
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

describe('episode evidence from release filenames', () => {
    const cases: [string, number | null, string | null][] = [
        ["Breaking.Bad.S01E05.1080p.BluRay.mkv", 1, "1:5"],
        ["Dark.2017.S02.E05.1080p.mkv", 2, "2:5"],
        ["The Wire Season 3 Episode 9 - Slapstick.mkv", 3, "3:9"],
        ["The.X-Files.4x07.mkv", 4, "4:7"],
        ["Dark (2017) - S02E05 - Lost and Found (1080p NF WEB-DL x265 Ghost).mkv", 2, "2:5"],
        ["01 - Pilot.mkv", 3, "3:1"],
        ["Episode 12 - Title.mkv", 3, "3:12"],
        ["e05.mkv", 3, "3:5"],
        ["Show.S01E02.2022.1080p.mkv", 1, "1:2"],
        ["Show.S01E20.5.mkv", 1, "1:20.5"],
        ["Show.S01E02-E04.1080p.mkv", 1, "1:2-4"],
        ["Show.S01E02E03.mkv", 1, "1:2-3"],
        ["Show.S01E02-1080p.mkv", 1, "1:2"],
        ["Show.S01E09 - 3.2.1.mkv", 1, "1:9"],
        ["Show.S01E02 - S02E03.mkv", 1, "conflict"],
        ["Show.S03E04.mkv", 2, "3:4"],
        ["Sample.1080p.mkv", 1, "extra"],
        ["Special (1920x1080).mkv", 1, null],
        ["Part 2.mkv", 1, null],
        ["2024.mkv", 1, null],
        ["Show S01E04 [720p].ass", 1, null],
        ["Show.S00E01.mkv", 0, "0:1"],
        ["[SubsPlease] 86 - Eighty Six - 05 (1080p).mkv", null, "?:5"],
        ["[Fansub] One Piece - 1089v2 [1080p][A1B2C3D4].mkv", null, "?:1089"],
        ["One Piece (1999) 152.mkv", null, "?:152"],
        ["[SubGroup] Show [720p].mkv", null, null],
        ["Asobi Asobase 6.mkv", null, "?:6"],
        ["News.2024.02.29.720p.HDTV.mkv", null, "date:2024-02-29"],
        ["News.2023.02.29.720p.HDTV.mkv", null, null],
        ["Show_02x03_1080p.mkv", 2, "2:3"],
        ["ShowS02E09v2.mkv", 2, "2:9"],
        ["Ep_09.mkv", 2, "2:9"],
        ["002.mkv", 2, "2:2"],
        ["Show.S02E05-S02E07.mkv", 2, "2:5-7"],
        ["The Story of S02E05X.mkv", 2, null],
        ["Show.2x03-2x04 [1080p].mkv", 2, "2:3-4"],
        ["Show.2x03.02.mkv", 2, "2:3"],
        ["[Team] Show - 02.5v2 [720p].mkv", null, "?:2.5"],
    ]
    it.each(cases)('%s', (name, parentSeason, expected) => {
        const result = parseEpisodeName(name)
        let actual: string | null = null
        if (result?.kind === 'episode' || result?.kind === 'number' || result?.kind === 'range') {
            const season = ('season' in result ? result.season : undefined) ?? parentSeason ?? '?'
            actual = `${season}:${result.episode}` + (result.kind === 'range' ? `-${result.endEpisode}` : '')
        } else if (result?.kind === 'date') {
            actual = `date:${result.date}`
        } else if (result?.kind === 'extra' || result?.kind === 'conflict') {
            actual = result.kind
        }
        expect(actual).toBe(expected)
    })
})

describe('structural season folder evidence', () => {
    const cases: [string, number | null][] = [
        ["Season 02", 2],
        ["Dark.S03E01-E14.1080p", 3],
        ["Dark.S01-S03.COMPLETE.1080p", null],
        ["Dark.S01E01-S03E10.1080p", null],
        ["Dark.S02.COMPLETE.1080p", 2],
        ["2024", null],
        ["Specials", 0],
        ["The Specials Anthology", null],
        ["Season_03 [1080p]", 3],
        ["Dark.S02-S02.COMPLETE", 2],
        ["Dark S01 + S02 pack", null],
        ["Specials of the World", null],
    ]
    it.each(cases)('%s', (name, expected) => {
        const result = parseSeasonName(name)
        expect(typeof result === 'number' ? result : null).toBe(expected)
    })

    it('keeps cross-season packs out of smart alphabetic fallback', () => {
        const result = determineAlphabeticSeasonNumbers(['Show.S01-S03.COMPLETE', 'First Arc'], false)
        expect([...result.keys()]).toEqual(['First Arc'])
    })
})

describe('contextual Smart episode assignment', () => {
    it('mixes clear formats, uses the first episode of a range, and leaves extras unnumbered', () => {
        const files = ['Show.S03E07.mkv', 'Episode 8 - Title.mkv', 'Show.3x09.mkv',
            'Sample.1080p.mkv', 'Show.S03E10-E12.mkv', 'Mystery.mkv']
        const result = determineEpisodeNumbers(files, 3)
        expect(files.map((name) => result.get(name)?.episode)).toEqual([7, 8, 9, undefined, 10, undefined])
    })

    it('does not number unknowns around dates, conflicts, or unverifiable absolute numbers', () => {
        const ambiguous = ['News.2024.02.29.mkv', 'News.2023.02.29.mkv',
            'Show.S01E05 - S02E01.mkv', '[Group] Show - 1089v2.mkv']
        for (const file of ambiguous) {
            expect(determineEpisodeNumbers([file, 'Unknown.mkv'], 1).size).toBe(0)
        }
    })

    it('corroborates bare numbers in an established season without renumbering them', () => {
        const files = ['002.mkv', '08 - Pilot.mkv', 'Mystery.mkv']
        const result = determineEpisodeNumbers(files, 3, 'smart', undefined, { physicalSeason: true })
        expect(files.map((name) => result.get(name)?.episode)).toEqual([2, 8, undefined])
    })

    it('accepts show-prefixed numbering when provider data verifies a single season', () => {
        const files = ['86 - Eighty Six - 05.mkv', '86 6.mkv', '86 - Eighty Six - 1089v2.mkv']
        const result = determineEpisodeNumbers(files, 1, 'smart', undefined, {
            showTitles: ['86'], seasonCounts: new Map([[0, 1], [1, 12]])
        })
        expect(files.map((name) => result.get(name)?.episode)).toEqual([5, 6, undefined])
    })

    it('assigns matching flat anime releases within season one and leaves later absolute numbers unresolved', () => {
        const files = ['Mob Psycho 100 - 01.mkv', 'Mob Psycho 100 - 02.mkv',
            'Mob Psycho 100 - 12.mkv', 'Mob Psycho 100 - 13.mkv', 'Other Show - 01.mkv']
        const result = determineEpisodeNumbers(files, 1, 'smart', undefined, {
            showTitles: ['Mob Psycho 100'], seasonCounts: new Map([[1, 12], [2, 13], [3, 12]])
        })
        expect(files.map((name) => result.get(name)?.episode)).toEqual([1, 2, 12, undefined, undefined])
        expect(result.get(files[0])?.season).toBe(1)
        expect(determineEpisodeNumbers(files, 1, 'smart', undefined, { showTitles: ['Mob Psycho 100'] }).size).toBe(0)
    })

    it('uses locked parent coordinates when grouping fractional suffixes', () => {
        const files = ['Show.S01E07.5.mkv', 'Show.S02E08.5.mkv']
        const result = determineEpisodeNumbers(files, 3, 'smart', undefined, { forcedSeason: 3 })
        expect(files.map((name) => result.get(name))).toEqual([
            { mediaType: 'episode', season: 3, episode: 7 }, { mediaType: 'episode', season: 3, episode: 8 }
        ])
    })
})

it('keeps conflicting conventions visible even when a compact coordinate would be fast to parse', () => {
    expect(parseEpisodeName('Show.2x06.S02E05.1080p.mkv')).toEqual({ kind: 'conflict' })
    expect(parseEpisodeName('Show.S02E05.Season 2 Episode 6.mkv')).toEqual({ kind: 'conflict' })
    expect(parseEpisodeName('Show.S02E08-E05.1080p.mkv')).toEqual({ kind: 'conflict' })
})

it('ignores bracketed aspect ratios and preserves genuine NxM episode names', () => {
    expect(parseEpisodeName('Show.S01E02.[4x3].480p.mkv')).toMatchObject({ kind: 'episode', season: 1, episode: 2 })
    expect(parseEpisodeName('Show - 01 (4x3) [480p].mkv')).toMatchObject({ kind: 'number', episode: 1 })
    expect(parseEpisodeName('Show.S01E02.[16x9].480p.mkv')).toMatchObject({ kind: 'episode', season: 1, episode: 2 })
    expect(parseEpisodeName('Show.[4x03].mkv')).toMatchObject({ kind: 'episode', season: 4, episode: 3 })
    expect(parseEpisodeName('Show.4x3.mkv')).toMatchObject({ kind: 'episode', season: 4, episode: 3 })
})

it('retains the coordinates span after peeling a fansub label', () => {
    const name = '[Subs] Show - 1089v2 [1080p].mkv'
    const evidence = parseEpisodeName(name)
    expect(evidence?.kind).toBe('number')
    if (evidence?.kind !== 'number') return
    expect(name.slice(evidence.span.start, evidence.span.end).trim()).toBe('- 1089v2')
})

it('does not use technical dimensions or malformed tokens as positional episodes', () => {
    const files = ['Show.S02E05X.mkv', 'Special (1920x1080).mkv']
    expect(determineEpisodeNumbers(files, 2).size).toBe(0)
})

it('needs independent episodes to reinterpret a shared fractional digit', () => {
    const files = ['Show.S02E07.5.1080p.mkv', 'Show.S02E07.5.2160p.mkv']
    expect([...determineEpisodeNumbers(files, 2).values()].map(({ episode }) => episode)).toEqual([7.5, 7.5])
})
