import { describe, expect, it } from 'bun:test'
import { isExtraVideoName, parseTitle } from './title-parser'

describe('metadata title and year from release names', () => {
  const cases: [string, 'file' | 'folder', string, number | null][] = [
    ["The.Matrix.1999.2160p.UHD.BluRay.REMUX.HEVC.DTS-HD.MA.5.1-GRP.mkv", "file", "the matrix", 1999],
    ["Spirited.Away.(2001).1080p.BluRay.x264.DUAL-GRP.mkv", "file", "spirited away", 2001],
    ["2001.A.Space.Odyssey.1968.2160p.HDR10+.HEVC-GRP.mkv", "file", "2001 a space odyssey", 1968],
    ["1917.2019.1080p.BluRay.x264-GRP.mkv", "file", "1917", 2019],
    ["2012.2009.1080p.BluRay.x264-GRP.mkv", "file", "2012", 2009],
    ["Blade.Runner.2049.2017.2160p.REMUX-Group.mkv", "file", "blade runner 2049", 2017],
    ["Blade Runner 2049.mkv", "file", "blade runner 2049", null],
    ["2001 A Space Odyssey.mkv", "file", "2001 a space odyssey", null],
    ["1917.mkv", "file", "1917", null],
    ["9.mkv", "file", "9", null],
    ["8½ (1963).mkv", "file", "8½", 1963],
    ["Once.Upon.a.Time...in.Hollywood.2019.1080p.WEB-DL.mkv", "file", "once upon a time in hollywood", 2019],
    ["WEB.DL.The.Movie (2021).mkv", "file", "web dl the movie", 2021],
    ["4K Adventure.mkv", "file", "4k adventure", null],
    ["Dune.Part.Two.2024.IMAX.2160p.10bit.DV.HDR.WEB-DL.DDP5.1.Atmos.H.265-GRP.mkv", "file", "dune part two", 2024],
    ["A Quiet Place Part II (2020) [2160p] [HDR] [GRP].mkv", "file", "a quiet place part ii", 2020],
    ["[YIFY] The Thing (1982) [1080p] [BluRay] [YTS.MX].mp4", "file", "the thing", 1982],
    ["The Thing (1982) - 1080p.mkv", "file", "the thing", 1982],
    ["The Thing (1982) – 1080p Multi.mkv", "file", "the thing", 1982],
    ["Alien (1979) - Director’s Cut", "folder", "alien", 1979],
    ["Alien (1979) Director's Cut - 1080p.mkv", "file", "alien", 1979],
    ["The Director's Cut.mkv", "file", "the director's cut", null],
    ["It.(2017).[tmdbid-346364].1080p.mkv", "file", "it", 2017],
    ["千と千尋の神隠し (2001) [1080p].mkv", "file", "千と千尋の神隠し", 2001],
    ["Se7en [Director's Cut].mkv", "file", "se7en", null],
    ["Heat 1995.mkv", "file", "heat 1995", null],
    ["Heat.1995.1080i.HDTV.m2ts", "file", "heat", 1995],
    ["The.Matrix.1999.2160p.UHD.BluRay.REMUX-GRP", "folder", "the matrix", 1999],
    ["The Godfather Part. 2", "folder", "the godfather part 2", null],
    ["It (1990) [tmdbid-19614]", "folder", "it", 1990],
    ["The Thing (1982).mkv", "folder", "the thing (1982) mkv", null],
    ["Dark.2017.S01-S03.COMPLETE.1080p.NF.WEB-DL-GRP", "folder", "dark", 2017],
    ["[Fansub] 86 - Eighty Six [1080p Batch]", "folder", "86 - eighty six", null],
    ["District.9.2009.1080p.BDRip.x265-GRP.mkv", "file", "district 9", 2009],
    ["10.Bit.2020.1080p.WEBRip.mkv", "file", "10 bit", 2020],
    ["HDR Is the Future (2020).mkv", "file", "hdr is the future", 2020],
    ["[REC] (2007) [1080p].mkv", "file", "[rec]", 2007],
    ["Mission.Impossible.III.2006.PROPER.1080p.BluRay-GRP.mkv", "file", "mission impossible iii", 2006],
    ["The Thing 1982 (1982).mkv", "file", "the thing 1982", 1982],
    ["Movie (2020) (Extended Cut) [1080p].mkv", "file", "movie", 2020],
    ["24 (2001) [tmdbid-1973]", "folder", "24", 2001],
    ["Show.Name.2020.1st.Season.1080p.WEB-DL-GRP", "folder", "show name", 2020],
    ["How BluRay Changed Movies (2020) [720p].mkv", "file", "how bluray changed movies", 2020],
    ["Some.Video.2023.1080p.NF.WEB-DL.mkv", "file", "some video", 2023],
    ["The HDR Story (2021).mkv", "file", "the hdr story", 2021],
    ["The X-Files (1993) Seasons 1-3 COMPLETE", "folder", "the x-files", 1993],
    ["Dark.2017.S03E01-E14.1080p.WEB-DL", "folder", "dark", 2017],
  ]

  it.each(cases)('%s', (name, kind, title, year) => {
    const parsed = parseTitle(name, kind, 2028)
    expect(parsed.title.toLowerCase()).toBe(title)
    expect(parsed.year ?? null).toBe(year)
  })

  it('keeps the intact bare year as the primary query', () => {
    expect(parseTitle('Heat 1995.mkv', 'file')).toMatchObject({
      title: 'Heat 1995', year: undefined, alternate: { title: 'Heat', year: 1995 }
    })
    expect(parseTitle('Blade Runner 2049.mkv', 'file', 2028).alternate).toBeUndefined()
  })

  it('retains title accents, case, and meaningful punctuation', () => {
    expect(parseTitle("L'Avventura (1960).mkv", 'file').title).toBe("L'Avventura")
    expect(parseTitle('TÁR (2022).mkv', 'file').title).toBe('TÁR')
  })

  it('keeps provider IDs separate from the query and preserves their namespaces', () => {
    expect(parseTitle('It.(2017).[tmdbid-346364].{imdbid=tt1396484}.[tvdbid-593].mkv', 'file')).toMatchObject({
      title: 'It', year: 2017, ids: { tmdb: '346364', imdb: 'tt1396484', tvdb: '593' }, conflictingIds: false
    })
    expect(parseTitle('It.[tmdbid-12].[tmdbid-12].mkv', 'file').conflictingIds).toBe(false)
    expect(parseTitle('It.[tmdbid-12].[tmdbid-17].mkv', 'file').conflictingIds).toBe(true)
    expect(parseTitle('It.[tmdbid-0].[imdbid-42].mkv', 'file').ids).toEqual({})
  })

  it('distinguishes a TV pack from a title that contains a season phrase', () => {
    expect(parseTitle('Dark.2017.S01-S03.COMPLETE.1080p', 'folder').seasonPack).toBe(true)
    expect(parseTitle('The First Season', 'folder').seasonPack).toBe(false)
  })

  it.each(['Sample.1080p.mkv', 'Movie-trailer.mkv', 'Movie - Teaser.mkv', 'behind_the_scenes.mkv'])(
    'recognizes an extra %s', (name) => expect(isExtraVideoName(name)).toBe(true)
  )

  it.each(['The Specials.mkv', 'Trailer Park Boys.mkv', 'A Sample of Life.mkv'])(
    'preserves a feature title %s', (name) => expect(isExtraVideoName(name)).toBe(false)
  )
})
