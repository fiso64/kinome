import { isSupportedVideoFile } from '@shared/local-media'
export { isSupportedVideoFile } from '@shared/local-media'

import { comparableTitle, isExtraVideoName, readSeasonNotation, videoStem } from './title-parser'

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

function getSeasonSuffix(episodes: number[], unknownCount: number): number | undefined {
  const distinct = new Set(episodes)
  const digitCounts = new Map<number, number>()
  for (const episode of distinct) {
    const digit = getFractionalDigit(episode)
    digitCounts.set(digit, (digitCounts.get(digit) ?? 0) + 1)
  }

  for (const [digit, count] of digitCounts) {
    if (digit === 0 || count < 2 || count < distinct.size + unknownCount - 1) continue
    const normalized = new Set([...distinct].map((episode) =>
      getFractionalDigit(episode) === digit ? Math.trunc(episode) : episode
    ))
    if (normalized.size === distinct.size) return digit
  }
}

// Keep filesystem move and shadow rules stable until their callers can adopt
// the structural parser with their own acceptance policies.
export function parseEpisodeForReconciliation(
  name: string
): { season?: number; episode: number; pattern: string } | null {
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

export function parseSeasonForFilesystem(name: string): number | null {
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
  return SPECIAL_FOLDER_NAMES_FOR_TV.includes(comparableTitle(name))
}

export interface ParsedTvInfo {
  season?: number | null
  episode?: number | null
  mediaType?: 'season' | 'episode' | null
}

type Span = { start: number; end: number }
type Coordinates = { season?: number; episode: number; span: Span }
type EpisodeCandidate =
  | ({ kind: 'episode' } & Coordinates)
  | ({ kind: 'range'; endEpisode: number } & Coordinates)
  | { kind: 'number'; episode: number; prefix: string; notation: 'bare' | 'named' | 'absolute'; span: Span }
  | { kind: 'date'; date: string; span: Span }
  | { kind: 'extra' | 'conflict' | 'ambiguous' }

const number = String.raw`(\d{1,4}(?:\.\d(?!\d))?)`
// The revision suffix belongs to the release. It is part of the boundary
// check rather than part of the captured episode number.
const end = String.raw`(?:v\d+)?(?![\p{L}\p{N}])`
const seasonEpisode = String.raw`(?:s(\d{1,2})[ ._-]*e|(?<![a-z0-9])season[ ._-]*(\d{1,2})[ ._-]+episode[ ._-]*|(?<![a-z0-9])(\d{1,2})x)${number}`
const fullEpisode = new RegExp(seasonEpisode + String.raw`(?=e\d|${end})`, 'giu')
const episodeOnly = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:episode|ep|e)[ ._-]*${number}${end}`, 'giu')
const nextEpisode = new RegExp(String.raw`^(?:[ ._]*[-–][ ._]*e|e)${number}`, 'iu')
const looseNumber = new RegExp(String.raw`(?:^|[ ._]+)${number}${end}(?=$|[ ._]*[[(]|[ ._]+(?:\d{3,4}[pi]|web[ ._-]?dl|bluray)(?!\w))`, 'giu')
const bareNumber = new RegExp(String.raw`^${number}${end}(?=$|\s+[-–]\s+|[ ._]*[[(])`, 'iu')
const dashedNumber = new RegExp(String.raw`[ ._]+[-–][ ._]+${number}${end}(?=$|[ ._[(])`, 'giu')
const datePattern = /(?<!\d)((?:19|20)\d{2})[. _-](\d{2})[. _-](\d{2})(?!\d)/
const validRevision = /^v\d+(?![\p{L}\p{N}])/iu
const terminalBoundary = /^[^\p{L}\p{N}]/u
const nonAscii = /[^\x00-\x7f]/
const letterOrNumber = /[\p{L}\p{N}]/u
const aspectRatio = /^(?:4x3|16x9|21x9)$/i

function matchSpan(match: RegExpExecArray | RegExpMatchArray, offset = 0): Span {
  const start = (match.index ?? 0) + offset
  return { start, end: start + match[0].length }
}

function coordinates(match: RegExpMatchArray): Coordinates {
  return { season: Number(match[1] ?? match[2] ?? match[3]), episode: Number(match[4]), span: matchSpan(match) }
}

function* episodeCoordinates(stem: string) {
  const unicode = nonAscii.test(stem)
  for (const match of stem.matchAll(fullEpisode)) {
    if (match[3] !== undefined && aspectRatio.test(match[0])) {
      const open = stem[match.index - 1]
      const close = stem[match.index + match[0].length]
      // Bracketed aspect-ratio tags can look like NxM episode coordinates.
      if ((open === '[' && close === ']') || (open === '(' && close === ')')) continue
    }
    if (unicode && match[1] === undefined && match.index > 0 &&
      letterOrNumber.test(String.fromCodePoint(stem.codePointAt(match.index - 1)!))) continue
    yield match
  }
}

const compactEpisode = /s(\d{1,2})e(\d{1,4})(?![a-z0-9]|\.\d(?!\d))/i
const otherCoordinate = /s\d{1,2}[ ._-]*e\d|season[ ._-]*\d|(?:^|[^a-z0-9])\d{1,2}x\d/i

function explicitEpisode(stem: string): EpisodeCandidate | null {
  const compact = compactEpisode.exec(stem)
  if (compact) {
    const span = matchSpan(compact)
    const tail = stem.slice(span.end)
    if ((!tail || terminalBoundary.test(tail)) && !nextEpisode.test(tail) &&
      !otherCoordinate.test(tail) && !otherCoordinate.test(stem.slice(0, span.start))) {
      return { kind: 'episode', season: Number(compact[1]), episode: Number(compact[2]), span }
    }
  }
  const full = episodeCoordinates(stem)
  const first = full.next().value
  if (!first) return null

  const start = coordinates(first)
  let offset = first.index! + first[0].length
  let last = start.episode
  let range = false
  let next = nextEpisode.exec(stem.slice(offset))
  while (next) {
    const episode = Number(next[1])
    if (episode <= last || (!next[0].includes('-') && !next[0].includes('–') && episode !== last + 1)) {
      return { kind: 'conflict' }
    }
    range = true
    last = episode
    offset += next[0].length
    next = nextEpisode.exec(stem.slice(offset))
  }
  const suffix = stem.slice(offset)
  if (suffix && !terminalBoundary.test(suffix) && !validRevision.test(suffix)) return { kind: 'ambiguous' }

  const second = full.next().value
  if (second) {
    const target = coordinates(second)
    const between = stem.slice(offset, second.index!)
    if (range || target.season !== start.season || target.episode <= last ||
      !/^[ ._]*[-–][ ._]*$/.test(between) || !full.next().done) return { kind: 'conflict' }
    return { kind: 'range', ...start, endEpisode: target.episode, span: { start: start.span.start, end: target.span.end } }
  }
  return range ? { kind: 'range', ...start, endEpisode: last, span: { start: start.span.start, end: offset } } : { kind: 'episode', ...start }
}

export function parseEpisodeName(name: string): EpisodeCandidate | null {
  if (!isSupportedVideoFile(name)) return null
  return parseVideoEpisodeName(name)
}

function parseVideoEpisodeName(name: string): EpisodeCandidate | null {
  if (isExtraVideoName(name)) return { kind: 'extra' }
  const stem = videoStem(name)
  const explicit = explicitEpisode(stem)
  if (explicit) return explicit

  const partial = stem.matchAll(episodeOnly)
  const first = partial.next().value
  if (first) {
    for (const other of partial) {
      if (Number(other[1]) !== Number(first[1])) return { kind: 'conflict' }
    }
    return { kind: 'episode', episode: Number(first[1]), span: matchSpan(first) }
  }

  const date = datePattern.exec(stem)
  if (date) {
    const iso = `${date[1]}-${date[2]}-${date[3]}`
    const value = new Date(iso)
    return Number.isFinite(value.valueOf()) && value.toISOString().slice(0, 10) === iso
      ? { kind: 'date', date: iso, span: matchSpan(date) } : { kind: 'ambiguous' }
  }

  if (/[sS]\d{1,2}[ ._-]*[eE]\d|(?<!\d)\d{3,4}x\d{3,4}(?!\d)/i.test(stem)) return { kind: 'ambiguous' }
  const plain = stem.replace(/^\[[^\]]+\][ ._]+/, '')
  const groupLength = stem.length - plain.length
  let delimited: RegExpMatchArray | undefined
  for (const match of plain.matchAll(dashedNumber)) delimited = match
  if (delimited) {
    const prefix = comparableTitle(plain.slice(0, delimited.index)).replace(/ (?:18|19|20)\d{2}$/, '')
    return { kind: 'number', notation: 'absolute', prefix, episode: Number(delimited[1]), span: matchSpan(delimited, groupLength) }
  }
  const bare = bareNumber.exec(plain)
  if (bare) {
    if (/^(?:18|19|20)\d{2}$/.test(bare[1])) return { kind: 'ambiguous' }
    return { kind: 'number', notation: 'bare', prefix: '', episode: Number(bare[1]), span: matchSpan(bare, groupLength) }
  }

  let named: RegExpMatchArray | undefined
  for (const match of plain.matchAll(looseNumber)) named = match
  if (!named) return null
  const prefix = comparableTitle(plain.slice(0, named.index)).replace(/ (?:18|19|20)\d{2}$/, '')
  return prefix && !/^(?:part|volume|disc|chapter|season|special|trailer|sample)$/i.test(prefix) &&
    !/^(?:18|19|20)\d{2}$/.test(named[1]) ? { kind: 'number', notation: 'named', prefix, episode: Number(named[1]), span: matchSpan(named, groupLength) } : null
}

// "pack" marks an episode or a multi-season bundle that should be skipped
// even when Smart season assignment needs to fall back to alphabetic order.
export function parseSeasonName(name: string): number | 'pack' | null {
  if (comparableTitle(name) === 'specials') return 0
  const episode = explicitEpisode(name)
  if (episode?.kind === 'range') return episode.season ?? 'pack'
  if (episode) return 'pack'
  const notation = readSeasonNotation(name)
  if (notation) return notation.season ?? 'pack'
  return /^\d+$/.test(name.trim()) ? 'pack' : null
}

export type TvParserDiagnosticSink = (diagnostic: {
  event: 'episode-assignment' | 'episode-fallback'
  assigned: number
}) => void

export interface EpisodeContext {
  showTitles?: string[]
  seasonCounts?: ReadonlyMap<number, number>
  physicalSeason?: boolean
  forcedSeason?: number | null
}

const naturalOrder = new Intl.Collator(undefined, { numeric: true })
const episodeInfo = (season: number | null | undefined, episode: number): ParsedTvInfo =>
  ({ season, episode, mediaType: 'episode' })

export function determineEpisodeNumbers(
  fileNames: string[],
  parentSeason?: number | null,
  strategy: 'smart' | 'alphabetic' = 'smart',
  diagnostic?: TvParserDiagnosticSink,
  context: EpisodeContext = {}
): Map<string, ParsedTvInfo> {
  const videos = fileNames.filter(isSupportedVideoFile)
  const result = new Map<string, ParsedTvInfo>()
  if (strategy === 'alphabetic') {
    videos.sort(naturalOrder.compare).forEach((name, index) => result.set(name, episodeInfo(parentSeason, index + 1)))
    return result
  }

  const numbered: Array<{ name: string; candidate: Extract<EpisodeCandidate, { kind: 'number' }> }> = []
  const siblings = new Map<string, Set<number>>()
  const unknown: string[] = []
  const inheritedSeason = context.forcedSeason === undefined ? parentSeason : context.forcedSeason
  let hasNumberingEvidence = false
  let hasFractionalEpisode = false

  for (const name of videos) {
    const candidate = parseVideoEpisodeName(name)
    if (!candidate) {
      unknown.push(name)
      continue
    }
    if (candidate.kind === 'extra') continue
    hasNumberingEvidence = true
    if (candidate.kind === 'episode' || candidate.kind === 'range') {
      const season = context.forcedSeason === undefined ? candidate.season ?? parentSeason : inheritedSeason
      if (season == null) continue
      // Kinome currently has one episode slot per file. A valid combined
      // release stays playable from its first episode until ranges have their
      // own navigation and watched-state handling.
      result.set(name, episodeInfo(season, candidate.episode))
      hasFractionalEpisode ||= !Number.isInteger(candidate.episode)
    } else if (candidate.kind === 'number' && inheritedSeason != null) {
      numbered.push({ name, candidate })
      const key = `${candidate.notation}:${candidate.prefix}`
      let values = siblings.get(key)
      if (!values) siblings.set(key, values = new Set())
      values.add(candidate.episode)
    }
  }

  if (numbered.length && inheritedSeason != null) {
    const knownTitles = context.showTitles?.map(comparableTitle).filter(Boolean) ?? []
    const count = context.seasonCounts?.get(inheritedSeason)
    const regularSeasonCount = context.seasonCounts
      ? context.seasonCounts.size - Number(context.seasonCounts.has(0)) : 0
    const verifiedSingleSeason = count != null && regularSeasonCount === 1 && inheritedSeason !== 0
    const boundedPhysicalSeason = count != null && context.physicalSeason
    const startsInSeasonOne = count != null && inheritedSeason === 1

    for (const { name, candidate: { episode, notation, prefix } } of numbered) {
      if (count != null && episode > count) continue
      const corroborated = (siblings.get(`${notation}:${prefix}`)?.size ?? 0) >= 2
      if (notation === 'bare') {
        if (!context.physicalSeason || (!corroborated && count == null)) continue
      } else {
        const knownPrefix = knownTitles.some((title) => prefix === title || (/^\d+$/.test(title) && prefix.startsWith(title + ' ')))
        if (!knownPrefix && !corroborated) continue
        // Absolute and season-relative numbers agree within the first season.
        const withinFirstSeason = startsInSeasonOne && knownPrefix && episode >= 1
        if (notation === 'absolute' && !verifiedSingleSeason && !boundedPhysicalSeason && !withinFirstSeason) continue
        if (notation === 'named' && !context.physicalSeason && (!verifiedSingleSeason || !knownPrefix)) continue
      }
      result.set(name, episodeInfo(inheritedSeason, episode))
      hasFractionalEpisode ||= !Number.isInteger(episode)
    }
  }

  if (!hasNumberingEvidence && parentSeason != null) {
    unknown.sort(naturalOrder.compare).forEach((name, index) => result.set(name, episodeInfo(parentSeason, index + 1)))
    diagnostic?.({ event: 'episode-fallback', assigned: result.size })
    return result
  }

  if (hasFractionalEpisode) normalizeFractionalSuffixes(result, inheritedSeason, unknown.length)
  diagnostic?.({ event: 'episode-assignment', assigned: result.size })
  return result
}

function normalizeFractionalSuffixes(
  assignments: Map<string, ParsedTvInfo>, fallbackSeason: number | null | undefined, unknownCount: number
): void {
  const episodesBySeason = new Map<number | null | undefined, ParsedTvInfo[]>()
  for (const info of assignments.values()) {
    let episodes = episodesBySeason.get(info.season)
    if (!episodes) episodesBySeason.set(info.season, episodes = [])
    episodes.push(info)
  }
  for (const [season, episodes] of episodesBySeason) {
    const suffix = getSeasonSuffix(episodes.map((info) => info.episode!), season === fallbackSeason ? unknownCount : 0)
    if (suffix === undefined) continue
    for (const info of episodes) {
      if (getFractionalDigit(info.episode!) === suffix) info.episode = Math.trunc(info.episode!)
    }
  }
}

export function determineExplicitSeasonNumbers(folderNames: string[]): Map<string, ParsedTvInfo> {
  const result = new Map<string, ParsedTvInfo>()
  for (const name of folderNames) {
    if (isSpecialTvFolderName(name)) continue
    const season = parseSeasonName(name)
    if (typeof season === 'number') result.set(name, { season, mediaType: 'season' })
  }
  return result
}

export function determineAlphabeticSeasonNumbers(
  folderNames: string[], includePacks = true
): Map<string, ParsedTvInfo> {
  return new Map(folderNames
    .filter((name) => !isSpecialTvFolderName(name) && (includePacks || parseSeasonName(name) !== 'pack'))
    .sort(naturalOrder.compare)
    .map((name, index) => [name, { season: index + 1, mediaType: 'season' }]))
}
