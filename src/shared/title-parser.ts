import { isSupportedVideoFile } from './local-media'

export interface TitleQuery {
  title: string
  year?: number
}

export interface ParsedTitle extends TitleQuery {
  alternate?: TitleQuery
  ids: Partial<Record<'tmdb' | 'imdb' | 'tvdb', string>>
  conflictingIds: boolean
  seasonPack: boolean
}

const strongToken = String.raw`[1-9]\d{2,3}[pi]|blu[ ._-]?ray|bd(?:rip|remux)|web[ ._-]?(?:dl|rip)|hdtv|dvd(?:rip)?|brrip|remux|[xh][ ._-]?26[45]|hevc|av1`
const modifierToken = String.raw`imax|proper|repack\d*|internal|uhd|4k|\d{1,2}bit|hdr(?:10\+?)?|dv|dovi|nf|amzn|dsnp|atvp|dual|multi|aac|flac|truehd|atmos|dts(?:[ ._-]hd)?|ddp\d*(?:\.\d)?`
const strongReleaseToken = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${strongToken})(?![\p{L}\p{N}])`, 'giu')
const releaseModifier = new RegExp(String.raw`[ ._-]+(?:${modifierToken})[ ._]*$`, 'i')
const releaseContinuation = new RegExp(String.raw`^[ ._-]+(?:${strongToken}|${modifierToken})(?![\p{L}\p{N}])`, 'iu')
const releaseEnd = /^[ ._\])]*(?:-[\p{L}\p{N}][\p{L}\p{N}._-]*)?$/u
const releaseBracket = /[ ._]*\[(?:4k|uhd|hdr(?:10\+?)?|dovi|dv|\d{1,2}bit|aac|flac|[\da-f]{8})\]$/i
const editionLabel = /(?:director['’]?s[ ._]+cut|extended(?:[ ._]+(?:cut|edition))?|theatrical[ ._]+cut|unrated|remastered)/.source
const edition = new RegExp(
  String.raw`(?:[ ._-]*(?:\[${editionLabel}\]|\(${editionLabel}\))|(?:[ ._]+[-–—][ ._]+|(?<=\d{4}[\])])[ ._]+)${editionLabel})$`,
  'i'
)
const bracketedYear = /[ ._]*(?:\((\d{4})\)|\[(\d{4})\])$/
const bareYear = /[ ._]+(\d{4})$/
const providerTag = /\[(?:tmdbid|imdbid|tvdbid)[=-](?:tt)?\d+\]|\{(?:tmdbid|imdbid|tvdbid)[=-](?:tt)?\d+\}/gi
const episodeMarker = /(?:^|[ ._\]-])s\d{1,2}[ ._-]*e\d|\s-\s+\d{1,4}(?:\.\d)?(?:v\d+)?(?=$|[\s[(])/i
const seasonMarker = /(?<![\p{L}\p{N}])(?:((?:seasons?[ ._-]*|s))(\d{1,2})(?![\p{L}\p{N}])(?:[ ._]*[-–+][ ._]*s?(\d{1,2})(?![\p{L}\p{N}]))?|(\d{1,2})(?:st|nd|rd|th)[ ._-]+season(?![\p{L}\p{N}]))/giu
const episodePackMarker = /(?<![\p{L}\p{N}])s\d{1,2}[ ._-]*e\d{1,4}(?:[ ._]*[-–][ ._]*(?:s\d{1,2}[ ._-]*)?e|e)\d{1,4}(?![\p{L}\p{N}])/iu
const packLabel = /(?:^|[ ._])(?:complete|batch)(?=$|[ ._\])])/i
const releaseSeparators = /^[\s.\-_[\]()]+$/

export function readSeasonNotation(name: string): { start: number; season: number | null } | undefined {
  let result
  for (const match of name.matchAll(seasonMarker)) {
    const season = Number(match[2] ?? match[4])
    result ??= { start: match.index, season }
    if (result.season !== season || (match[3] && Number(match[3]) !== season)) {
      return { start: result.start, season: null }
    }
  }
  return result
}

export function videoStem(name: string): string {
  return isSupportedVideoFile(name) ? name.slice(0, name.lastIndexOf('.')) : name
}

function displayQuery(value: string): string {
  return value.replace(/[._\s]+/g, ' ').trim()
}

export function comparableTitle(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}|['’]/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function trimReleaseBoundary(value: string): string {
  return value.replace(/[\s._[(]+$/, '').replace(/[ ._]*[-–—]$/, '').trimEnd()
}

function releaseStart(stem: string): number {
  for (const token of stem.matchAll(strongReleaseToken)) {
    const prefix = trimReleaseBoundary(stem.slice(0, token.index))
    if (!/[\p{L}\p{N}]/u.test(prefix)) continue
    const tail = stem.slice(token.index + token[0].length)
    if ((stem[token.index - 1] === '[' && tail.includes(']')) ||
      releaseEnd.test(tail) || releaseContinuation.test(tail) ||
      bareYear.test(prefix) || bracketedYear.test(prefix)) return token.index
  }
  return stem.length
}

function yearInRange(value: string | undefined, maxYear: number): number | undefined {
  const number = Number(value)
  return number >= 1888 && number <= maxYear ? number : undefined
}

export function parseTitle(name: string, kind: 'file' | 'folder', maxYear = new Date().getFullYear() + 2): ParsedTitle {
  const ids: ParsedTitle['ids'] = {}
  let conflictingIds = false
  const stem = (kind === 'file' ? videoStem(name) : name).replace(providerTag, (tag) => {
    const [provider, value] = tag.slice(1, -1).toLowerCase().split(/id[=-]/) as ['tmdb' | 'imdb' | 'tvdb', string]
    if (provider === 'imdb' ? !/^tt\d+$/.test(value) : !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      return tag
    }
    if (ids[provider] && ids[provider] !== value) conflictingIds = true
    ids[provider] ??= value
    return ''
  }).replace(/[ ._]+$/, '')

  const technicalStart = releaseStart(stem)
  const seasonMark = kind === 'folder' ? readSeasonNotation(stem) : undefined
  const episodePackStart = kind === 'folder' ? episodePackMarker.exec(stem)?.index : undefined
  const packStart = Math.min(seasonMark?.start ?? stem.length, episodePackStart ?? stem.length)
  const seasonPack = packStart > 0 && packStart < technicalStart &&
    (technicalStart < stem.length || packLabel.test(stem.slice(packStart)) || episodePackStart === packStart)
  const cut = seasonPack ? packStart : technicalStart
  const hasRelease = cut < stem.length
  let main = stem.slice(0, cut).replace(/[ ._]+$/, '')
  if (hasRelease) {
    main = trimReleaseBoundary(main)
    let shortened = main.replace(releaseModifier, '').replace(releaseBracket, '')
    while (shortened !== main) {
      main = shortened
      shortened = main.replace(releaseModifier, '').replace(releaseBracket, '')
    }
  }
  main = main.replace(edition, '').trimEnd()

  const group = /^\[[^\]]+\][ ._]+(.+)$/.exec(main)
  if (group) {
    const rest = group[1]
    const markedYear = bracketedYear.exec(rest) ?? bareYear.exec(rest)
    if ((hasRelease && markedYear && /[\p{L}\p{N}]/u.test(rest.slice(0, markedYear.index))) ||
      (hasRelease && episodeMarker.test(rest)) || (seasonPack && /[\p{L}\p{N}]/u.test(rest)) ||
      (hasRelease && /^\d+\s+-\s+\p{L}/u.test(rest))) main = rest
  }

  const bracketed = bracketedYear.exec(main)
  const bare = bareYear.exec(main)
  const yearMatch = bracketed ?? (hasRelease ? bare : null)
  const year = yearMatch && yearMatch.index > 0 ? yearInRange(yearMatch[1] ?? yearMatch[2], maxYear) : undefined
  const alternateYear = !hasRelease && !bracketed && bare ? yearInRange(bare[1], maxYear) : undefined
  const title = displayQuery(year ? main.slice(0, yearMatch!.index) : main)
  const alternate = alternateYear && bare && displayQuery(main.slice(0, bare.index))
    ? { title: displayQuery(main.slice(0, bare.index)), year: alternateYear } : undefined
  return { title: releaseSeparators.test(title) ? '' : title, year, alternate, ids, conflictingIds, seasonPack }
}

// Shared by movie folder lookup and TV structure. Restrict this to conventional
// extra names and delimited suffixes so that e.g. "The Specials" remains a title.
export function isExtraVideoName(name: string): boolean {
  if (!/sample|trailer|teaser|featurette|bonus|behind|deleted|nc(?:op|ed)/i.test(name)) return false
  const stem = videoStem(name)
  return /^(?:sample|trailer|teaser|bonus[ ._-]feature|featurette|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scene)(?:$|[ ._-]+\d{3,4}[pi](?!\w)|[ ._-]+\d+$)/i.test(stem) ||
    /[ ._]+-[ ._]+(?:sample|trailer|teaser|featurette)(?:$|[ ._-]+\d{3,4}[pi](?!\w))|-(?:sample|trailer|teaser|featurette)$|[ ._]\[(?:sample|trailer|teaser|featurette)\]$|^(?:sample|trailer)\s+-\s+|^nc(?:op|ed)\d*(?:$|[ ._\[])/i.test(stem)
}
