/**
 * Library items as Jellyfin sees them. Movies and series form two libraries.
 * Seasons and episodes belong to their series. Every read goes through
 * repositoryService.find, which applies the signed-in account's visibility.
 */
import type { components } from './openapi'
import type { LibraryFilter, LibraryItem } from '@shared/types'
import type { LocalMedia, LocalMediaTrack, VideoSummary } from '@shared/local-media'
import type { CompiledSql, TypedWhereClause, FindOptions, OrderByClause } from '../database/query-builder'
import { isMovieFileCandidate, selectMovieFile } from '@shared/item-capabilities'
import * as repositoryService from '../services/repository.service'
import * as libraryService from '../services/library.service'
import * as playbackService from '../services/playback.service'
import { playbackMetadata } from '../services/transcoding'
import { ffprobe } from '../services/transcoding/runtime'
import * as settingsService from '../services/settings.service'
import { securePathJoin } from '../services/paths.service'
import * as virtualFoldersService from '../services/virtualFolders.service'
import { getAutocompleteValues } from '../services/autocomplete.service'
import { performSearch } from '../services/search.service'
import { TRICKPLAY_WIDTH, trickplayInfo } from '../services/trickplay.service'
import {
  COLLECTIONS_ID, LIBRARIES, PLAYLISTS_ID, ROOT_ID, genreToJellyfinId, personFromJellyfinId, personToJellyfinId, resolveItemId,
  toJellyfinId, type LibraryKey
} from './ids'
import { json, notFound, route, type JellyfinRequest, type Query } from './request'

export type BaseItemDto = components['schemas']['BaseItemDto']
export type MediaStream = components['schemas']['MediaStream']
type ItemKind = 'Movie' | 'Series' | 'Season' | 'Episode'
type ExtraType = NonNullable<BaseItemDto['ExtraType']>

export type Item = LibraryItem & {
  originalTitle?: string | null
  playbackPosition?: number
  videoSummary?: VideoSummary | null
  localMedia?: LocalMedia | null
  addedAt?: number
  sourceId?: string
  size?: number | null
  entityId?: string | null
}

const TICKS_PER_SECOND = 10_000_000
/** A favourite is the personal tag favorite:true and nothing else. */
export const FAVORITE = { key: 'favorite', value: 'true' }
const KINDS: Record<string, ItemKind> = { movie: 'Movie', tv: 'Series', season: 'Season', episode: 'Episode' }
const MEDIA_TYPES: Record<ItemKind, string> = { Movie: 'movie', Series: 'tv', Season: 'season', Episode: 'episode' }

// Every listing selects the same columns, so one statement serves each page.
export const ITEM_FIELDS = [
  'id', 'parentId', 'name', 'type', 'isMissing', 'isVirtual', 'virtualType', 'addedAt', 'mediaType', 'title',
  'originalTitle', 'releaseDate', 'year', 'seasonNumber', 'episodeNumber', 'tmdbId', 'tmdbRuntime', 'posterPath',
  'backdropPath', 'logoPath', '_v', 'genres', 'watched', 'lastWatched', 'playbackPosition', 'tmdbMetadata',
  'videoSummary', 'size', 'sourceId', 'path'
]

export function itemKind(item: Pick<LibraryItem, 'mediaType'>): ItemKind | undefined {
  return item.mediaType ? KINDS[item.mediaType] : undefined
}

/** A video without a kind of its own, such as a movie's second version or extra. */
const isVideo = (item: Item) => !item.mediaType && item.type === 'file'

/** What a client may open by ID: a title, or a video file it was shown as a version or extra. */
export function isPresentable(item: Item): boolean {
  return !!itemKind(item) || isVideo(item)
}

// Jellyfin names extras by folder or suffix, as in Extras/Making of.mkv or Film-trailer.mkv.
const EXTRA_NAMES: [RegExp, ExtraType][] = [
  [/trailer/, 'Trailer'], [/deleted/, 'DeletedScene'], [/behind.?the.?scenes|making.?of/, 'BehindTheScenes'],
  [/interview/, 'Interview'], [/sample/, 'Sample'], [/scene/, 'Scene'], [/short/, 'Short'], [/clip/, 'Clip']
]

export function extraType(file: Item): ExtraType {
  const path = (file.path ?? file.name).toLowerCase()
  return EXTRA_NAMES.find(([pattern]) => pattern.test(path))?.[1] ?? 'Featurette'
}

// A file at least this share of the longest file's length is a version of the film, a shorter one an extra.
const VERSION_SHARE = 0.7

export function findItems(options: FindOptions, extraFields: string[] = []): Item[] {
  return repositoryService.find({ ...options, fields: [...ITEM_FIELDS, ...extraFields] }) as Item[]
}

/** The visible item behind a presented ID, if Jellyfin clients may see it. */
export function getItem(id: string | undefined, extraFields: string[] = []): Item | undefined {
  const itemId = resolveItemId(id)
  return itemId ? findItems({ where: { id: itemId } }, extraFields)[0] : undefined
}

export function requireItem(request: JellyfinRequest, name = 'itemId', extraFields: string[] = []): Item {
  const item = getItem(request.params[name], extraFields)
  if (!item || !isPresentable(item)) throw notFound()
  return item
}

function iso(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const date = new Date(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * A tag names one version of an image. It is signed, so a client that was
 * shown the item can load the image without a token, as browsers do.
 */
export function imageTag(path: string, version?: number | null): string {
  return settingsService.signServerValue(`image:${path}:${version ?? 0}`)
}

function sortName(item: Item): string {
  return (item.title || item.name).toLowerCase().replace(/^(the|a|an)\s+/, '')
}

const textCodecs = new Set(['subrip', 'srt', 'webvtt', 'mov_text', 'text', 'ass', 'ssa'])

function bitDepth(pixelFormat?: string): number | undefined {
  if (!pixelFormat) return undefined
  return Number(/(?:p|gray)(10|12|16)(?:le|be)?$/.exec(pixelFormat)?.[1] ?? 8)
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' })
function languageName(code?: string): string | undefined {
  if (!code || code === 'und') return undefined
  try { return languageNames.of(code) } catch { return code }
}

function frameRate(rate?: string): number | undefined {
  const [frames, seconds = 1] = (rate ?? '').split('/').map(Number)
  return frames && seconds ? Math.round(frames / seconds * 1000) / 1000 : undefined
}

type VideoRangeType = NonNullable<MediaStream['VideoRangeType']>
const DOLBY_VISION_BASE: Record<number, VideoRangeType> = { 1: 'DOVIWithHDR10', 2: 'DOVIWithSDR', 4: 'DOVIWithHLG', 6: 'DOVIWithHDR10' }

/** The picture's dynamic range as Jellyfin names it, which clients compare against what they can show. */
export function videoRangeType(track: LocalMediaTrack | undefined): VideoRangeType {
  const dolbyVision = track?.dolbyVision
  if (dolbyVision) return dolbyVision.profile === 7 ? 'DOVIWithEL' : DOLBY_VISION_BASE[dolbyVision.compatibility] ?? 'DOVI'
  return track?.colorTransfer === 'smpte2084' ? 'HDR10' : track?.colorTransfer === 'arib-std-b67' ? 'HLG' : 'SDR'
}

/** Probed tracks in the order and numbering FFmpeg gives them. */
export function mediaStreams(media: LocalMedia | null | undefined): MediaStream[] {
  return (media?.tracks ?? []).map((track: LocalMediaTrack): MediaStream => {
    const type = track.kind === 'video' ? 'Video' : track.kind === 'audio' ? 'Audio' : 'Subtitle'
    const codec = track.codec ?? undefined
    const language = languageName(track.language)
    const flags = [track.default && 'Default', track.forced && 'Forced', track.hearingImpaired && 'Hearing Impaired'].filter(Boolean)
    const displayTitle = type === 'Video'
      ? [track.height && `${track.height}p`, codec?.toUpperCase()].filter(Boolean).join(' ')
      : [track.title || language, codec?.toUpperCase(), type === 'Audio' ? track.channelLayout : undefined, ...flags]
        .filter(Boolean).join(' - ')
    const isText = type === 'Subtitle' && textCodecs.has(codec ?? '')
    return {
      Codec: codec, Language: track.language, Title: track.title, DisplayTitle: displayTitle || undefined,
      Type: type, Index: track.index, IsDefault: track.default, IsForced: track.forced, IsOriginal: false,
      IsHearingImpaired: track.hearingImpaired, IsExternal: false, IsInterlaced: ['tt', 'bb', 'tb', 'bt'].includes(track.fieldOrder ?? ''),
      IsTextSubtitleStream: isText, SupportsExternalStream: isText,
      VideoRange: 'Unknown', VideoRangeType: 'Unknown', AudioSpatialFormat: 'None',
      ...(type === 'Video' ? {
        Width: track.width, Height: track.height, Profile: track.profile, Level: track.level, PixelFormat: track.pixelFormat,
        BitDepth: bitDepth(track.pixelFormat), AverageFrameRate: frameRate(track.frameRate), RealFrameRate: frameRate(track.frameRate),
        VideoRange: videoRangeType(track) === 'SDR' ? 'SDR' : 'HDR',
        VideoRangeType: videoRangeType(track),
        IsAVC: codec === 'h264', BitRate: track.bitrate
      } : {}),
      ...(type === 'Audio' ? {
        Channels: track.channels, ChannelLayout: track.channelLayout, SampleRate: track.sampleRate, BitRate: track.bitrate,
        Profile: track.profile
      } : {})
    }
  })
}

// --- Batched context for a page of items ---

export interface Related {
  series: Map<string, Item>
  /** An episode's or season's series ID. */
  seriesOf: Map<string, string>
  /** A season item by series ID and season number. */
  seasons: Map<string, Item>
  /** The feature file of a movie folder: the one that plays unless a client picks another version. */
  features: Map<string, Item>
  /** Every version of a movie folder's film, starting with the file selectMovieFile picks. */
  versions: Map<string, Item[]>
  /** A movie folder's other videos, loaded only for details. */
  extras: Map<string, Item[]>
  /** Episode counts by series ID. */
  progress: Map<string, { total: number; watched: number }>
  /** Items the account marked as favourites with the personal tag favorite:true. */
  favorites: Set<string>
  sourcePaths: Map<string, string>
  canSeePaths: boolean
  /** The library a movie or series reports as its parent: the first of its type. */
  libraryIds: Partial<Record<LibraryKey, string>>
}

const seasonKey = (seriesId: string, seasonNumber: number | null | undefined) => `${seriesId}:${seasonNumber ?? ''}`

/**
 * Loads what a page of items refers to with a fixed number of statements,
 * however many items the page holds.
 */
export async function relate(items: Item[], request: JellyfinRequest, options: { progress?: boolean; extras?: boolean } = {}): Promise<Related> {
  const related: Related = {
    series: new Map(), seriesOf: new Map(), seasons: new Map(), features: new Map(), versions: new Map(), extras: new Map(), progress: new Map(),
    favorites: request.session ? repositoryService.itemsWithPersonalTag(request.session.accountId, items.map((item) => item.id), FAVORITE.key, FAVORITE.value) : new Set(),
    sourcePaths: await settingsService.getAbsoluteSourcePaths(),
    canSeePaths: !!request.session?.capabilities.has('editSettings'),
    libraryIds: {}
  }
  for (const view of views(request)) if ((view.type === 'movies' || view.type === 'tvshows')) related.libraryIds[view.type] ??= view.id
  const children = items.filter((item) => item.mediaType === 'episode' || item.mediaType === 'season')
  if (children.length) {
    const ancestors = repositoryService.getAncestorIdsForItems(children.map((item) => item.id))
    const candidates = [...new Set(Object.values(ancestors).flat())]
    const shows = findItems({ where: { id: candidates, mediaKind: 'tv' } })
    for (const show of shows) related.series.set(show.id, show)
    for (const item of children) {
      const seriesId = ancestors[item.id]?.find((id) => related.series.has(id))
      if (seriesId) related.seriesOf.set(item.id, seriesId)
    }
    if (shows.length) {
      for (const season of findItems({ where: { parentId: shows.map((show) => show.id), mediaKind: 'season' } })) {
        if (!related.seasons.has(seasonKey(season.parentId!, season.seasonNumber))) {
          related.seasons.set(seasonKey(season.parentId!, season.seasonNumber), season)
        }
      }
    }
  }
  const movieFolders = items.filter((item) => item.mediaType === 'movie' && item.type === 'folder')
  if (movieFolders.length) {
    const ids = movieFolders.map((item) => item.id)
    // Listings need the files directly in each folder. Details also need extras in subfolders.
    const files = findItems(options.extras
      ? { where: { type: 'file' }, compiledConditions: repositoryService.descendantsCondition(ids) }
      : { where: { parentId: ids, type: 'file' } })
    const byParent = Map.groupBy(files, (file) => file.parentId!)
    const folders = new Set(ids)
    const nested = options.extras ? files.filter((file) => !folders.has(file.parentId!)) : []
    const ancestors = nested.length ? repositoryService.getAncestorIdsForItems([...new Set(nested.map((file) => file.parentId!))]) : {}
    for (const movie of movieFolders) {
      const children = (byParent.get(movie.id) ?? []).filter(isMovieFileCandidate)
      // Lengths are measured against the longest file, so a large trailer cannot make the film look like an extra.
      const longest = Math.max(0, ...children.map((file) => file.videoSummary?.durationSeconds ?? 0))
      const long = longest ? children.filter((file) => (file.videoSummary?.durationSeconds ?? 0) >= longest * VERSION_SHARE) : []
      const feature = selectMovieFile(long.length ? long : children)
      if (!feature) continue
      related.features.set(movie.id, feature)
      const versions = [feature, ...long.filter((file) => file !== feature)]
      related.versions.set(movie.id, versions)
      if (options.extras) {
        const inside = nested.filter((file) => isMovieFileCandidate(file) && ancestors[file.parentId!]?.includes(movie.id))
        related.extras.set(movie.id, [...children.filter((file) => !versions.includes(file)), ...inside])
      }
    }
  }
  const series = items.filter((item) => item.mediaType === 'tv')
  if (options.progress && series.length) {
    const episodes = repositoryService.find({
      fields: ['id', 'parentId', 'watched'],
      where: { mediaKind: 'episode', type: 'file', isMissing: 0 },
      compiledConditions: repositoryService.descendantsCondition(series.map((item) => item.id))
    })
    // Most episodes sit in their series or one of its season folders. Walk up from the distinct folders only.
    const ids = new Set(series.map((item) => item.id))
    const folders = [...new Set(episodes.flatMap((episode) => episode.parentId && !ids.has(episode.parentId) ? [episode.parentId] : []))]
    const ancestors = repositoryService.getAncestorIdsForItems(folders)
    for (const episode of episodes) {
      const parent = episode.parentId
      const seriesId = parent && ids.has(parent) ? parent : parent ? ancestors[parent]?.find((id) => ids.has(id)) : undefined
      if (!seriesId) continue
      const counts = related.progress.get(seriesId) ?? { total: 0, watched: 0 }
      counts.total++
      if (episode.watched) counts.watched++
      related.progress.set(seriesId, counts)
    }
  }
  return related
}

/** The file that plays for an item: the item itself, or a movie folder's feature. */
export function playableFile(item: Item, related: Related): Item | undefined {
  if (item.type === 'file') return item
  return related.features.get(item.id)
}

export function absolutePath(item: Item, related: Related): string | undefined {
  const base = item.sourceId ? related.sourcePaths.get(item.sourceId) : undefined
  return base && item.path ? securePathJoin(base, item.path) ?? undefined : undefined
}

// --- Item DTOs ---

export interface DtoOptions {
  fields: Set<string>
  userData: boolean
  /** Single-item responses carry overview, people and streams without asking. */
  detail?: boolean
}

export function dtoOptions(query: Query, detail = false): DtoOptions {
  return {
    fields: new Set(query.list('fields').map((field) => field.toLowerCase())),
    userData: query.bool('enableUserData') ?? true,
    detail
  }
}

function seriesImages(series: Item | undefined): Partial<BaseItemDto> {
  if (!series) return {}
  return {
    SeriesName: series.title || series.name, SeriesId: toJellyfinId(series.id),
    SeriesPrimaryImageTag: series.posterPath ? imageTag(series.posterPath, series._v) : undefined,
    ParentBackdropItemId: series.backdropPath ? toJellyfinId(series.id) : undefined,
    ParentBackdropImageTags: series.backdropPath ? [imageTag(series.backdropPath, series._v)] : undefined,
    ParentLogoItemId: series.logoPath ? toJellyfinId(series.id) : undefined,
    ParentLogoImageTag: series.logoPath ? imageTag(series.logoPath, series._v) : undefined
  }
}

export function toDto(item: Item, related: Related, options: DtoOptions): BaseItemDto {
  const kind = itemKind(item) ?? 'Video'
  const id = toJellyfinId(item.id)
  const file = playableFile(item, related)
  const summary = file?.videoSummary
  const metadata = item.tmdbMetadata
  const wants = (field: string) => options.detail || options.fields.has(field.toLowerCase())
  const seriesId = related.seriesOf.get(item.id)
  const series = seriesId ? related.series.get(seriesId) : undefined
  const durationSeconds = summary?.durationSeconds ?? (item.tmdbRuntime ? item.tmdbRuntime * 60 : undefined)
  const playable = kind === 'Movie' || kind === 'Episode' || kind === 'Video'
  const progress = related.progress.get(item.id)
  const state = file ?? item
  const played = kind === 'Series' && progress ? progress.total > 0 && progress.watched === progress.total : !!state.watched
  const genres = item.genres ?? []

  const extras = related.extras.get(item.id) ?? []
  const trailers = extras.filter((extra) => extraType(extra) === 'Trailer').length
  const parentId = kind === 'Video' ? (item.parentId ? toJellyfinId(item.parentId) : undefined)
    : kind === 'Movie' ? related.libraryIds.movies
    : kind === 'Series' ? related.libraryIds.tvshows
    : kind === 'Season' ? (seriesId ? toJellyfinId(seriesId) : undefined)
    : (seriesId ? toJellyfinId(related.seasons.get(seasonKey(seriesId, item.seasonNumber))?.id ?? seriesId) : undefined)
  const season = kind === 'Episode' && seriesId ? related.seasons.get(seasonKey(seriesId, item.seasonNumber)) : undefined

  const dto: BaseItemDto = {
    Name: kind === 'Season' && !item.title ? `Season ${item.seasonNumber ?? ''}`.trim() : item.title || item.name,
    OriginalTitle: item.originalTitle ?? undefined,
    ServerId: settingsService.getServerId(),
    Id: id,
    DateCreated: iso(item.addedAt),
    CanDelete: false,
    CanDownload: playable && !!file,
    SortName: sortName(item),
    PremiereDate: iso(item.releaseDate),
    ProductionYear: item.year ?? undefined,
    CommunityRating: metadata?.tmdbRating ?? undefined,
    OfficialRating: metadata?.contentRating ?? undefined,
    Genres: genres,
    GenreItems: genres.map((name) => ({ Name: name, Id: genreToJellyfinId(name) })),
    ProviderIds: {
      ...(item.tmdbId ? { Tmdb: String(item.tmdbId) } : {}),
      ...(metadata?.imdbId ? { Imdb: metadata.imdbId } : {})
    },
    RunTimeTicks: playable && durationSeconds ? Math.round(durationSeconds * TICKS_PER_SECOND) : undefined,
    IsFolder: !playable,
    ParentId: parentId,
    Type: kind === 'Video' && extraType(item) === 'Trailer' ? 'Trailer' : kind,
    ...(kind === 'Video' ? { ExtraType: extraType(item) } : {}),
    MediaType: playable ? 'Video' : 'Unknown',
    LocationType: 'FileSystem',
    PlayAccess: 'Full',
    ChannelId: null,
    DisplayPreferencesId: id,
    LockData: false,
    LockedFields: [],
    Studios: [],
    Tags: [],
    RemoteTrailers: [],
    LocalTrailerCount: trailers,
    SpecialFeatureCount: extras.length - trailers,
    MediaSourceCount: related.versions.get(item.id)?.length,
    EnableMediaSourceDisplay: true,
    OriginalLanguage: metadata?.originalLanguage ?? undefined,
    ExternalUrls: [
      ...(metadata?.imdbId ? [{ Name: 'IMDb', Url: `https://www.imdb.com/title/${metadata.imdbId}` }] : []),
      ...(item.tmdbId && kind !== 'Season' && kind !== 'Episode'
        ? [{ Name: 'TheMovieDb', Url: `https://www.themoviedb.org/${kind === 'Movie' ? 'movie' : 'tv'}/${item.tmdbId}` }] : [])
    ],
    Taglines: metadata?.tagline ? [metadata.tagline] : [],
    ImageTags: {
      ...(item.posterPath ? { Primary: imageTag(item.posterPath, item._v) } : {}),
      ...(item.logoPath ? { Logo: imageTag(item.logoPath, item._v) } : {})
    },
    BackdropImageTags: item.backdropPath ? [imageTag(item.backdropPath, item._v)] : [],
    PrimaryImageAspectRatio: item.posterPath ? (kind === 'Episode' ? 16 / 9 : 2 / 3) : undefined,
    ...(kind === 'Episode' || kind === 'Season' ? seriesImages(series) : {}),
    ...(kind === 'Episode' ? {
      IndexNumber: item.episodeNumber !== null && item.episodeNumber !== undefined ? Math.floor(item.episodeNumber) : undefined,
      ParentIndexNumber: item.seasonNumber ?? undefined,
      SeasonId: season ? toJellyfinId(season.id) : undefined,
      SeasonName: season ? season.title || `Season ${season.seasonNumber}` : undefined,
      ParentPrimaryImageItemId: season?.posterPath ? toJellyfinId(season.id) : undefined,
      ParentPrimaryImageTag: season?.posterPath ? imageTag(season.posterPath, season._v) : undefined
    } : {}),
    ...(kind === 'Season' ? { IndexNumber: item.seasonNumber ?? undefined } : {}),
    ...(kind === 'Series' ? {
      Status: metadata?.status === 'Ended' || metadata?.status === 'Canceled' ? 'Ended' : metadata?.status ? 'Continuing' : undefined,
      RecursiveItemCount: progress?.total
    } : {}),
    ...(playable && summary ? {
      VideoType: 'VideoFile',
      Width: summary.width ?? undefined,
      Height: summary.height ?? undefined,
      IsHD: (summary.height ?? 0) >= 720
    } : {})
  }
  // Sonarr and Radarr match items by path and report the same path back after a change.
  if (wants('Path') && related.canSeePaths) dto.Path = absolutePath(file ?? item, related)
  if (wants('Overview')) dto.Overview = item.overview ?? undefined
  if (options.userData) {
    const position = state.playbackPosition ?? 0
    dto.UserData = {
      PlaybackPositionTicks: Math.round(position * TICKS_PER_SECOND),
      PlayedPercentage: position && durationSeconds ? Math.min(100, position / durationSeconds * 100) : undefined,
      PlayCount: played ? 1 : 0,
      IsFavorite: related.favorites.has(item.id),
      Played: played,
      LastPlayedDate: iso(state.lastWatched),
      UnplayedItemCount: progress ? progress.total - progress.watched : undefined,
      Key: id,
      ItemId: id
    }
  }
  if (playable && file && (wants('MediaSources') || wants('MediaStreams'))) {
    const sources = mediaSources(item, file, related)
    if (wants('MediaSources')) dto.MediaSources = sources
    dto.MediaStreams = sources[0].MediaStreams
    dto.Container = sources[0].Container
    dto.HasSubtitles = sources[0].MediaStreams?.some((stream) => stream.Type === 'Subtitle')
  }
  if (wants('People')) dto.People = people(item)
  if (playable && (options.detail || wants('Chapters'))) {
    dto.Chapters = (file?.localMedia?.chapters ?? []).map((chapter, index) => ({
      StartPositionTicks: Math.round(chapter.startSeconds * TICKS_PER_SECOND), Name: chapter.title || `Chapter ${index + 1}`,
      ImageDateModified: '0001-01-01T00:00:00.0000000Z'
    }))
  }
  // Scrubbing thumbnails are made on demand for files whose size and length are known.
  if (options.detail && playable && summary?.width && summary.height && summary.durationSeconds) {
    dto.Trickplay = { [id]: { [TRICKPLAY_WIDTH]: trickplayInfo(summary.durationSeconds, summary.width, summary.height) } }
  }
  return dto
}

type MediaSourceInfo = components['schemas']['MediaSourceInfo']

/**
 * A title's versions, starting with the one that plays. The version Kinome
 * picks carries the title's ID, as Jellyfin gives a single-version item, and
 * the others their file's ID, which playback accepts as a media source.
 */
export function mediaSources(item: Item, file: Item, related: Related): MediaSourceInfo[] {
  const versions = related.versions.get(item.id) ?? [file]
  return [file, ...versions.filter((version) => version.id !== file.id)].map((version) =>
    mediaSource(version.id === versions[0].id ? item : version, version, related))
}

export function mediaSource(item: Item, file: Item, related: Related, media = file.localMedia): MediaSourceInfo {
  const container = media?.container?.split(',')[0]
  return {
    Protocol: 'File',
    Id: toJellyfinId(item.id),
    Path: related.canSeePaths ? absolutePath(file, related) : undefined,
    Type: 'Default',
    Container: container === 'matroska' ? 'mkv' : container === 'mov' ? 'mp4' : container,
    Size: file.size ?? undefined,
    Name: file.name.replace(/\.[^.]+$/, ''),
    IsRemote: false,
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    TranscodingSubProtocol: 'http',
    RunTimeTicks: media?.durationSeconds ? Math.round(media.durationSeconds * TICKS_PER_SECOND) : undefined,
    Bitrate: media?.bitrate,
    SupportsDirectPlay: true,
    SupportsDirectStream: true,
    SupportsTranscoding: true,
    IsInfiniteStream: false,
    UseMostCompatibleTranscodingProfile: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: true,
    VideoType: 'VideoFile',
    HasSegments: false,
    MediaStreams: mediaStreams(media),
    MediaAttachments: [],
    Formats: [],
    RequiredHttpHeaders: {},
    DefaultAudioStreamIndex: media?.tracks.find((track) => track.kind === 'audio' && track.default)?.index ??
      media?.tracks.find((track) => track.kind === 'audio')?.index
  }
}

function people(item: Item): BaseItemDto['People'] {
  const credits = item.tmdbCredits
  if (!credits) return []
  const crewTypes: Record<string, 'Director' | 'Writer' | 'Producer'> = { Director: 'Director', Screenplay: 'Writer', Writer: 'Writer', Producer: 'Producer' }
  return [
    ...credits.cast.slice(0, 40).map((person) => ({
      Name: person.name, Id: personToJellyfinId(person.id), Role: person.character ?? undefined, Type: 'Actor' as const,
      PrimaryImageTag: person.profile_path ? imageTag(person.profile_path) : undefined
    })),
    ...credits.crew.filter((person) => person.job && crewTypes[person.job]).map((person) => ({
      Name: person.name, Id: personToJellyfinId(person.id), Role: person.job, Type: crewTypes[person.job!],
      PrimaryImageTag: person.profile_path ? imageTag(person.profile_path) : undefined
    }))
  ]
}

// --- Libraries, collections and playlists ---

/**
 * A virtual folder's role for Jellyfin clients, chosen with its tag jellyfin:<role>.
 * A personal tag decides for its account. Without any library folder, movies
 * and series form the two default libraries.
 */
export type FolderRole = LibraryKey | 'collection' | 'playlist'
const ROLES = new Set<string>(['movies', 'tvshows', 'collection', 'playlist'])
const TAG = 'jellyfin'

export interface Folder {
  item: Item & { filter?: LibraryFilter | null }
  role: FolderRole
}

export interface View {
  id: string
  name: string
  type: LibraryKey | 'boxsets' | 'playlists'
  /** The virtual folder behind a library. The default libraries have none. */
  folder?: Folder
}

const foldersByRequest = new WeakMap<JellyfinRequest, Folder[]>()

/** The tagged virtual folders the account can see, read once per request. */
export function taggedFolders(request: JellyfinRequest): Folder[] {
  let folders = foldersByRequest.get(request)
  if (!folders) {
    const roles = repositoryService.itemsWithTagKey(request.session!.accountId, TAG)
    const ids = [...roles].flatMap(([id, role]) => ROLES.has(role) ? [id] : [])
    folders = ids.length
      ? findItems({ where: { id: ids, isVirtual: 1 }, orderBy: [{ field: 'displayName', direction: 'ASC' }] }, ['filter'])
        .map((item) => ({ item, role: roles.get(item.id) as FolderRole }))
      : []
    foldersByRequest.set(request, folders)
  }
  return folders
}

export function views(request: JellyfinRequest): View[] {
  const folders = taggedFolders(request)
  const libraries = folders.filter((folder) => folder.role === 'movies' || folder.role === 'tvshows')
  const result: View[] = libraries.length
    ? libraries.map((folder) => ({ id: toJellyfinId(folder.item.id), name: folder.item.title || folder.item.name, type: folder.role as LibraryKey, folder }))
    : (Object.keys(LIBRARIES) as LibraryKey[]).map((key) => ({ id: LIBRARIES[key].id, name: LIBRARIES[key].name, type: key }))
  if (folders.some((folder) => folder.role === 'collection')) result.push({ id: COLLECTIONS_ID, name: 'Collections', type: 'boxsets' })
  if (folders.some((folder) => folder.role === 'playlist')) result.push({ id: PLAYLISTS_ID, name: 'Playlists', type: 'playlists' })
  return result
}

export function findView(request: JellyfinRequest, id: string | undefined): View | undefined {
  const normalized = id?.toLowerCase().replaceAll('-', '')
  return normalized ? views(request).find((view) => view.id === normalized) : undefined
}

/** The collection or playlist folder behind a presented ID. */
export function findFolder(request: JellyfinRequest, id: string | undefined, role: 'collection' | 'playlist'): Folder | undefined {
  const normalized = id?.toLowerCase().replaceAll('-', '')
  return normalized ? taggedFolders(request).find((folder) => folder.role === role && toJellyfinId(folder.item.id) === normalized) : undefined
}

function folderImages(item: Item): Partial<BaseItemDto> {
  return {
    ImageTags: item.posterPath ? { Primary: imageTag(item.posterPath, item._v) } : {},
    BackdropImageTags: item.backdropPath ? [imageTag(item.backdropPath, item._v)] : []
  }
}

export function viewDto(view: View): BaseItemDto {
  return {
    Name: view.name, ServerId: settingsService.getServerId(), Id: view.id, Etag: view.id, CanDelete: false,
    CanDownload: false, SortName: view.name.toLowerCase(), IsFolder: true, ParentId: ROOT_ID, Type: 'CollectionFolder',
    CollectionType: view.type, LocationType: 'FileSystem', MediaType: 'Unknown', DisplayPreferencesId: view.id,
    ImageTags: {}, BackdropImageTags: [], PlayAccess: 'Full', LockData: false, LockedFields: [], ProviderIds: {},
    ...(view.folder ? folderImages(view.folder.item) : {}),
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: view.id, ItemId: view.id }
  }
}

/** A collection is a BoxSet and a playlist a Playlist, listed in their views. */
export function folderDto(folder: Folder): BaseItemDto {
  const id = toJellyfinId(folder.item.id)
  const name = folder.item.title || folder.item.name
  const playlist = folder.role === 'playlist'
  return {
    Name: name, ServerId: settingsService.getServerId(), Id: id, CanDelete: false, CanDownload: false,
    SortName: name.toLowerCase(), IsFolder: true, ParentId: playlist ? PLAYLISTS_ID : COLLECTIONS_ID,
    Type: playlist ? 'Playlist' : 'BoxSet', MediaType: playlist ? 'Video' : 'Unknown', LocationType: 'FileSystem',
    DisplayPreferencesId: id, PlayAccess: 'Full', LockData: false, LockedFields: [], ProviderIds: {}, DateCreated: iso(folder.item.addedAt),
    ...folderImages(folder.item),
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: id, ItemId: id }
  }
}

function anyOf(conditions: CompiledSql[]): CompiledSql {
  return {
    sql: conditions.map((condition) => `(${condition.sql})`).join(' OR '),
    params: conditions.flatMap((condition) => condition.params),
    tables: new Set(conditions.flatMap((condition) => [...condition.tables ?? []]))
  }
}

/**
 * Items a folder holds. Seasons and episodes belong to it through their
 * series, found first by ID so the condition stays a plain index lookup.
 */
function folderCondition(folder: Folder, kinds: ItemKind[]): CompiledSql {
  const matched = virtualFoldersService.filterCondition(folder.item.filter ?? { scope: { manual: true } })
  if (!kinds.some((kind) => kind === 'Season' || kind === 'Episode')) return matched
  const series = repositoryService.find({ fields: ['id'], where: { mediaKind: 'tv' }, compiledConditions: matched }).map((item) => item.id)
  return series.length ? anyOf([matched, repositoryService.descendantsCondition(series)]) : matched
}

// --- /Items queries ---

const SORT_FIELDS: Record<string, string[] | 'random'> = {
  sortname: ['displayName'], name: ['displayName'], seriessortname: ['displayName'], premieredate: ['releaseDate'],
  productionyear: ['year'], datecreated: ['addedAt'], datelastcontentadded: ['addedAt'], dateplayed: ['lastWatched'],
  communityrating: ['tmdbScore'], criticrating: ['tmdbScore'], runtime: ['tmdbRuntime'], indexnumber: ['episodeNumber'],
  parentindexnumber: ['seasonNumber'], airedepisodeorder: ['seasonNumber', 'episodeNumber'], playcount: ['watched'],
  random: 'random'
}

export function sortOrder(query: Query, defaults: string[]): OrderByClause[] {
  const fields = query.list('sortBy')
  const orders = query.list('sortOrder')
  const clauses = (fields.length ? fields : defaults).flatMap((field, index): OrderByClause[] => {
    const sort = SORT_FIELDS[field.toLowerCase()]
    const direction = (orders[index] ?? orders[0])?.toLowerCase() === 'descending' ? 'DESC' : 'ASC'
    if (sort === 'random') return [{ raw: 'RANDOM()', direction }]
    return (sort ?? []).map((name) => ({ field: name, direction, nullsLast: true }))
  })
  return clauses.length ? clauses : [{ field: 'displayName', direction: 'ASC' }]
}

function genreNames(query: Query): Promise<string[]> | string[] {
  const names = query.list('genres', '|')
  const ids = new Set(query.list('genreIds').map((id) => id.toLowerCase().replaceAll('-', '')))
  if (!ids.size) return names
  return getAutocompleteValues('genre', '', 10_000)
    .then((all) => [...names, ...all.filter((name) => ids.has(genreToJellyfinId(name)))])
}

function either(groups: TypedWhereClause[][]) {
  return repositoryService.compileConditionGroups(groups)
}

export interface ItemPlan {
  options: FindOptions
  /** Search results keep their ranking unless the client sorts them. */
  rankedIds?: string[]
}

/**
 * Translates Jellyfin's item query into one find. Returns undefined when the
 * query can only match objects Kinome does not have, such as music or playlists.
 */
export async function planItems(request: JellyfinRequest, scope: { parentId?: string; types?: ItemKind[] } = {}): Promise<ItemPlan | undefined> {
  const { query } = request
  const known = new Set(Object.values(KINDS))
  const requestedNames = scope.types ?? query.list('includeItemTypes')
  let requested = new Set(requestedNames.filter((name): name is ItemKind => known.has(name as ItemKind)))
  if (requestedNames.length && !requested.size) return undefined
  const excluded = new Set(query.list('excludeItemTypes'))
  const recursive = query.bool('recursive') ?? false
  const where: Record<string, unknown> = { isMissing: 0 }
  const conditions: TypedWhereClause[] = []
  const groups: FindOptions['compiledConditions'][] = []
  let defaults: ItemKind[] = ['Movie', 'Series']
  let defaultSort = ['SortName']

  const ids = query.list('ids')
  const parent = scope.parentId ?? query.get('parentId')
  const view = findView(request, parent)
  // A collection or playlist folder lists what its filter matches.
  let folder = view?.folder ?? findFolder(request, parent, 'collection') ?? findFolder(request, parent, 'playlist')
  if (ids.length) {
    where.id = ids.map(resolveItemId).filter(Boolean)
    defaults = [...known]
    folder = undefined
  } else if (view?.type === 'movies' || view?.type === 'tvshows') {
    const library = view.type
    defaults = library === 'movies' ? ['Movie'] : recursive && requested.size ? ['Series', 'Season', 'Episode'] : ['Series']
    if (requested.size) requested = new Set([...requested].filter((kind) => library === 'movies' ? kind === 'Movie' : kind !== 'Movie'))
    if (!requested.size && requestedNames.length) return undefined
  } else if (view) {
    // Collections and playlists themselves are listed by folderList.
    return undefined
  } else if (folder) {
    defaults = folder.role === 'playlist' ? ['Movie', 'Series', 'Episode'] : ['Movie', 'Series']
  } else if (parent && parent.toLowerCase().replaceAll('-', '') !== ROOT_ID) {
    const container = getItem(parent)
    if (container?.mediaType === 'tv') {
      defaults = recursive ? ['Season', 'Episode'] : ['Season']
      groups.push(repositoryService.descendantsCondition([container.id]))
      defaultSort = ['ParentIndexNumber', 'IndexNumber']
    } else if (container?.mediaType === 'season') {
      defaults = ['Episode']
      const ancestors = repositoryService.getAncestorIdsForItems([container.id])[container.id] ?? []
      const seriesId = repositoryService.find({ fields: ['id'], where: { id: ancestors, mediaKind: 'tv' } })[0]?.id
      groups.push(repositoryService.descendantsCondition([seriesId ?? container.id]))
      where.seasonNumber = container.seasonNumber
      defaultSort = ['IndexNumber']
    } else {
      return undefined
    }
  }
  const kinds = (requested.size ? [...requested] : defaults).filter((kind) => !excluded.has(kind))
  if (!kinds.length) return undefined
  where.mediaKind = kinds.map((kind) => MEDIA_TYPES[kind])
  if (folder) groups.push(folderCondition(folder, kinds))
  if (kinds.every((kind) => kind === 'Episode' || kind === 'Season')) defaultSort = ['ParentIndexNumber', 'IndexNumber']

  const filters = new Set(query.list('filters').map((filter) => filter.toLowerCase()))
  if (filters.has('likes') || filters.has('dislikes')) return undefined
  const favorite = query.bool('isFavorite') ?? (filters.has('isfavorite') ? true : undefined)
  if (favorite !== undefined) {
    const tagged = repositoryService.personalTagCondition(request.session!.accountId, FAVORITE.key, FAVORITE.value)
    groups.push(favorite ? tagged : { ...tagged, sql: `NOT ${tagged.sql}` })
  }
  const played = query.bool('isPlayed') ?? (filters.has('isplayed') ? true : filters.has('isunplayed') ? false : undefined)
  if (played !== undefined) {
    const watched = repositoryService.watchedCondition(request.session!.accountId)
    groups.push(played ? watched : { ...watched, sql: `NOT ${watched.sql}` })
  }
  if (filters.has('isresumable')) conditions.push({ field: 'playbackPosition', op: 'gt', value: 0 })

  const genres = await genreNames(query)
  if (query.list('genres', '|').length || query.list('genreIds').length) {
    if (!genres.length) return undefined
    groups.push(either(genres.map((name) => [{ field: 'genre', op: 'eq', value: name }])))
  }
  const years = query.list('years').map(Number).filter(Number.isSafeInteger)
  if (years.length) where.year = years
  const persons = query.list('personIds').map(personFromJellyfinId).filter((id): id is number => id !== undefined)
  if (query.list('personIds').length) {
    if (!persons.length) return undefined
    groups.push(either(persons.map((id) => [{ field: 'personId', op: 'eq', value: id }])))
  }
  if (query.bool('hasTmdbId')) conditions.push({ field: 'tmdbId', op: 'isNotNull' })
  if (query.int('parentIndexNumber') !== undefined) where.seasonNumber = query.int('parentIndexNumber')
  if (query.int('indexNumber') !== undefined) where.episodeNumber = query.int('indexNumber')
  const minDate = query.get('minPremiereDate')
  const maxDate = query.get('maxPremiereDate')
  if (minDate) conditions.push({ field: 'releaseDate', op: 'gte', value: minDate.slice(0, 10) })
  if (maxDate) conditions.push({ field: 'releaseDate', op: 'lte', value: maxDate.slice(0, 10) })
  const startsWith = query.get('nameStartsWith')
  if (startsWith) {
    groups.push(either([startsWith.toUpperCase(), startsWith.toLowerCase()].map((prefix) => [
      { field: 'displayName', op: 'gte', value: prefix }, { field: 'displayName', op: 'lt', value: prefix + '￿' }
    ])))
  }
  const orGreater = query.get('nameStartsWithOrGreater')
  if (orGreater) conditions.push({ field: 'displayName', op: 'gte', value: orGreater })
  const lessThan = query.get('nameLessThan')
  if (lessThan) conditions.push({ field: 'displayName', op: 'lt', value: lessThan })

  // Search narrows to Kinome's ranked matches, at most a few hundred.
  let rankedIds: string[] | undefined
  const term = query.get('searchTerm')?.trim()
  if (term) {
    rankedIds = performSearch({ text: term, tags: [], limit: 200 }).items.map((entry) => entry.id)
    const scope = where.id as string[] | undefined
    where.id = scope ? rankedIds.filter((id) => scope.includes(id)) : rankedIds
  }

  const compiled = groups.filter((group): group is NonNullable<typeof group> => !!group)
  return {
    rankedIds: query.list('sortBy').length ? undefined : rankedIds,
    options: {
      where,
      typedWhere: conditions.length ? conditions : undefined,
      compiledConditions: compiled.length ? {
        sql: compiled.map((group) => `(${group.sql})`).join(' AND '),
        params: compiled.flatMap((group) => group.params),
        tables: new Set(compiled.flatMap((group) => [...group.tables]))
      } : undefined,
      orderBy: sortOrder(query, defaultSort),
      offset: query.int('startIndex'),
      // SQLite applies an offset only with a limit. -1 means none.
      limit: query.int('limit') ?? (query.int('startIndex') ? -1 : undefined)
    }
  }
}

export interface ItemsResult {
  Items: BaseItemDto[]
  TotalRecordCount: number
  StartIndex: number
}

export async function queryItems(request: JellyfinRequest, scope: Parameters<typeof planItems>[1] = {}): Promise<ItemsResult> {
  const startIndex = request.query.int('startIndex') ?? 0
  const plan = await planItems(request, scope)
  if (!plan) return { Items: [], TotalRecordCount: 0, StartIndex: startIndex }
  const options = dtoOptions(request.query)
  const extra = ['MediaSources', 'MediaStreams'].some((name) => options.fields.has(name.toLowerCase())) ? ['localMedia'] : []
  let items: Item[]
  let total: number
  if (plan.rankedIds) {
    // Rank first, then page. The matches are few, so this happens in memory.
    const rank = new Map(plan.rankedIds.map((id, index) => [id, index]))
    const matches = findItems({ ...plan.options, offset: undefined, limit: undefined }, extra)
      .toSorted((a, b) => rank.get(a.id)! - rank.get(b.id)!)
    total = matches.length
    items = matches.slice(startIndex, request.query.int('limit') === undefined ? undefined : startIndex + request.query.int('limit')!)
  } else {
    items = findItems(plan.options, extra)
    total = request.query.bool('enableTotalRecordCount') === false ? items.length
      : plan.options.limit === undefined || (items.length < plan.options.limit && !startIndex) ? startIndex + items.length
      : repositoryService.count(plan.options)
  }
  const related = await relate(items, request, { progress: true })
  if (extra.length) loadVersionMedia(related)
  return { Items: items.map((item) => toDto(item, related, options)), TotalRecordCount: total, StartIndex: startIndex }
}

/** Probed streams of every version of the movie folders, in one statement. */
export function loadVersionMedia(related: Related): void {
  const files = [...new Set([...related.features.values(), ...[...related.versions.values()].flat()])].filter((file) => !file.localMedia)
  if (!files.length) return
  const media = new Map(findItems({ where: { id: files.map((file) => file.id) } }, ['localMedia']).map((file) => [file.id, file.localMedia]))
  for (const file of files) file.localMedia = media.get(file.id) ?? null
}

export async function itemDto(request: JellyfinRequest, item: Item): Promise<BaseItemDto> {
  const related = await relate([item], request, { progress: true, extras: true })
  loadVersionMedia(related)
  const file = playableFile(item, related)
  if (file) file.localMedia = await liveMedia(file, request) ?? file.localMedia
  return toDto(item, related, dtoOptions(request.query, true))
}

/**
 * The playing file as the player's cached probe sees it. The library stores
 * neither chapters nor Dolby Vision, which clients need to choose how to play.
 */
async function liveMedia(file: Item, request: JellyfinRequest): Promise<LocalMedia | undefined> {
  const path = ffprobe ? await playbackService.resolveStreamPath(file.id, request.session?.accountId) : null
  if (!path) return undefined
  try {
    return await (await playbackMetadata(ffprobe!, path)).media
  } catch {
    // The file may be unreadable right now. Details answer from the library instead.
    return undefined
  }
}

/** A movie's extras: trailers, or everything else. */
async function extrasHandler(request: JellyfinRequest, trailers: boolean) {
  const item = requireItem(request)
  const extras = (await relate([item], request, { extras: true })).extras.get(item.id) ?? []
  const shown = extras.filter((extra) => (extraType(extra) === 'Trailer') === trailers)
  const related = await relate(shown, request)
  // Extras in a subfolder still belong to the movie.
  return json(request, shown.map((extra) => ({ ...toDto(extra, related, dtoOptions(request.query)), ParentId: toJellyfinId(item.id) })))
}

function personDto(id: number): BaseItemDto | undefined {
  const person = repositoryService.getPerson(id)
  if (!person) return undefined
  const jellyfinId = personToJellyfinId(id)
  return {
    Name: person.name, ServerId: settingsService.getServerId(), Id: jellyfinId, Type: 'Person', IsFolder: false,
    MediaType: 'Unknown', LocationType: 'Remote', ProviderIds: { Tmdb: String(id) }, BackdropImageTags: [],
    ImageTags: person.profilePath ? { Primary: imageTag(person.profilePath) } : {}, PrimaryImageAspectRatio: 2 / 3,
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: jellyfinId, ItemId: jellyfinId }
  }
}

async function getItemHandler(request: JellyfinRequest) {
  const id = request.params.itemId.toLowerCase().replaceAll('-', '')
  const view = findView(request, id)
  if (view) return json(request, viewDto(view))
  const folder = findFolder(request, id, 'collection') ?? findFolder(request, id, 'playlist')
  if (folder) return json(request, folderDto(folder))
  if (id === ROOT_ID) {
    return json(request, { ...viewDto({ id: ROOT_ID, name: 'Media Folders', type: 'movies' }), Type: 'UserRootFolder', CollectionType: undefined, ParentId: undefined })
  }
  const person = personFromJellyfinId(id)
  if (person !== undefined) {
    const dto = personDto(person)
    if (!dto) throw notFound()
    return json(request, dto)
  }
  const item = requireItem(request, 'itemId', ['overview', 'tmdbCredits', 'localMedia'])
  return json(request, await itemDto(request, item))
}

async function itemsHandler(request: JellyfinRequest) {
  const parent = request.query.get('parentId')?.toLowerCase().replaceAll('-', '')
  const recursive = request.query.bool('recursive') ?? false
  const filtered = ['ids', 'searchTerm', 'includeItemTypes', 'personIds', 'genres', 'genreIds', 'years']
    .some((name) => request.query.list(name).length)
  if ((!parent || parent === ROOT_ID) && !recursive && !filtered) {
    const shown = views(request).map(viewDto)
    return json(request, { Items: shown, TotalRecordCount: shown.length, StartIndex: 0 })
  }
  const folders = folderList(request)
  if (folders) return json(request, folders)
  return json(request, await queryItems(request))
}

/** Collections and playlists, when a client lists their view or asks for those types alone. */
function folderList(request: JellyfinRequest): ItemsResult | undefined {
  const view = findView(request, request.query.get('parentId'))
  const types = request.query.list('includeItemTypes')
  const asked = types.length > 0 && types.every((type) => type === 'BoxSet' || type === 'Playlist')
  if (!asked && view?.type !== 'boxsets' && view?.type !== 'playlists') return undefined
  const roles = new Set(asked ? types.map((type) => type === 'BoxSet' ? 'collection' : 'playlist') : [view!.type === 'boxsets' ? 'collection' : 'playlist'])
  const term = request.query.get('searchTerm')?.toLowerCase()
  const all = taggedFolders(request).filter((folder) => roles.has(folder.role) && (!term || (folder.item.title || folder.item.name).toLowerCase().includes(term)))
  const start = request.query.int('startIndex') ?? 0
  const limit = request.query.int('limit')
  const page = all.slice(start, limit === undefined ? undefined : start + limit)
  return { Items: page.map(folderDto), TotalRecordCount: all.length, StartIndex: start }
}

async function latestHandler(request: JellyfinRequest) {
  const library = findView(request, request.query.get('parentId'))?.type
  const types: ItemKind[] = library === 'movies' ? ['Movie'] : library === 'tvshows' ? ['Series'] : ['Movie', 'Series']
  const plan = await planItems(request, { types })
  if (!plan) return json(request, [])
  const items = findItems({ ...plan.options, orderBy: { field: 'addedAt', direction: 'DESC' }, offset: undefined, limit: request.query.int('limit') ?? 16 })
  const related = await relate(items, request, { progress: true })
  return json(request, items.map((item) => toDto(item, related, dtoOptions(request.query))))
}

async function resumeHandler(request: JellyfinRequest) {
  const limit = request.query.int('limit') ?? 12
  const files = findItems({
    where: { type: 'file', isMissing: 0 },
    typedWhere: [{ field: 'playbackPosition', op: 'gt', value: 0 }],
    orderBy: [{ field: 'lastWatched', direction: 'DESC', nullsLast: true }],
    limit: limit * 2
  })
  const parents = findItems({ where: { id: [...new Set(files.flatMap((file) => file.parentId ? [file.parentId] : []))], mediaKind: 'movie' } })
  const movieByFile = new Map<string, Item>()
  for (const file of files) {
    const movie = parents.find((parent) => parent.id === file.parentId)
    if (movie) movieByFile.set(file.id, movie)
  }
  const items = files.flatMap((file) => {
    if (file.watched) return []
    const movie = movieByFile.get(file.id)
    return movie ? [movie] : itemKind(file) ? [file] : []
  }).slice(0, limit)
  const related = await relate(items, request)
  // A resumed movie reports the position of the file that was played.
  for (const [fileId, movie] of movieByFile) {
    const file = files.find((entry) => entry.id === fileId)!
    if (related.features.get(movie.id)?.id !== fileId) related.features.set(movie.id, file)
  }
  const dtos = items.map((item) => toDto(item, related, dtoOptions(request.query)))
  return json(request, { Items: dtos, TotalRecordCount: dtos.length, StartIndex: 0 })
}

async function nextUpHandler(request: JellyfinRequest) {
  const accountId = request.session!.accountId
  const seriesId = resolveItemId(request.query.get('seriesId'))
  let episodes: Item[]
  if (seriesId) {
    const next = await libraryService.getContinueWatchingForShow(seriesId, accountId)
    episodes = next ? findItems({ where: { id: next.nextEpisode.id } }) : findItems({
      where: { mediaKind: 'episode', type: 'file', isMissing: 0 },
      compiledConditions: either([[{ field: 'watched', op: 'isNull' }], [{ field: 'watched', op: 'eq', value: 0 }]]),
      typedWhere: [{ field: 'ancestorId', op: 'eq', value: seriesId }, { field: 'seasonNumber', op: 'gt', value: 0 }],
      orderBy: [{ field: 'seasonNumber', direction: 'ASC' }, { field: 'episodeNumber', direction: 'ASC' }],
      limit: 1
    })
  } else {
    const shows = await libraryService.getContinueWatchingItems(accountId)
    const ids = shows.map(({ nextEpisode }) => nextEpisode.id)
    const byId = new Map(findItems({ where: { id: ids } }).map((episode) => [episode.id, episode]))
    episodes = ids.flatMap((id) => byId.get(id) ?? [])
  }
  const start = request.query.int('startIndex') ?? 0
  const page = episodes.slice(start, start + (request.query.int('limit') ?? episodes.length))
  const related = await relate(page, request)
  const dtos = page.map((episode) => toDto(episode, related, dtoOptions(request.query)))
  return json(request, { Items: dtos, TotalRecordCount: episodes.length, StartIndex: start })
}

async function seasonsHandler(request: JellyfinRequest) {
  const series = requireItem(request, 'seriesId')
  if (series.mediaType !== 'tv') throw notFound()
  const seasons = findItems({ where: { parentId: series.id, mediaKind: 'season' }, orderBy: [{ field: 'seasonNumber', direction: 'ASC', nullsLast: true }] })
  const related = await relate(seasons, request)
  const dtos = seasons.map((season) => toDto(season, related, dtoOptions(request.query)))
  return json(request, { Items: dtos, TotalRecordCount: dtos.length, StartIndex: 0 })
}

async function episodesHandler(request: JellyfinRequest) {
  const series = requireItem(request, 'seriesId')
  if (series.mediaType !== 'tv') throw notFound()
  const season = request.query.get('seasonId') ? getItem(request.query.get('seasonId')) : undefined
  const seasonNumber = season?.seasonNumber ?? request.query.int('season')
  const where: Record<string, unknown> = { mediaKind: 'episode', type: 'file', isMissing: 0 }
  if (seasonNumber !== undefined && seasonNumber !== null) where.seasonNumber = seasonNumber
  const scope: FindOptions = {
    where,
    compiledConditions: repositoryService.descendantsCondition([series.id]),
    orderBy: [{ field: 'seasonNumber', direction: 'ASC', nullsLast: true }, { field: 'episodeNumber', direction: 'ASC', nullsLast: true }, { field: 'displayName', direction: 'ASC' }]
  }
  // A start item becomes an offset, found among the episode IDs alone.
  const startItem = resolveItemId(request.query.get('startItemId'))
  const skipped = startItem ? Math.max(0, repositoryService.find({ ...scope, fields: ['id'] }).findIndex((episode) => episode.id === startItem)) : 0
  const start = request.query.int('startIndex') ?? 0
  const limit = request.query.int('limit')
  const options = dtoOptions(request.query)
  const media = options.fields.has('mediasources') || options.fields.has('mediastreams') ? ['localMedia'] : []
  const episodes = findItems({ ...scope, offset: skipped + start, limit: limit ?? (skipped + start ? -1 : undefined) }, ['overview', ...media])
  const total = limit === undefined && !skipped && !start ? episodes.length : repositoryService.count(scope) - skipped
  const related = await relate(episodes, request)
  const dtos = episodes.map((episode) => toDto(episode, related, options))
  return json(request, { Items: dtos, TotalRecordCount: total, StartIndex: start })
}

/**
 * Titles of the same kind that share people, genres or tags with the item,
 * best match first, as Jellyfin ranks them. Like Jellyfin, it leaves out what
 * the account has watched and anything sharing nothing.
 */
async function similarHandler(request: JellyfinRequest) {
  const item = requireItem(request, 'itemId', ['entityId'])
  const none = { Items: [], TotalRecordCount: 0, StartIndex: 0 }
  if (item.mediaType !== 'movie' && item.mediaType !== 'tv') return json(request, none)
  const limit = request.query.int('limit') ?? 50
  // Watched and hidden titles drop out after scoring, so more are scored than shown.
  const scores = repositoryService.relatedItemScores(item.id, item.entityId ?? null, item.genres ?? [], limit * 2)
  if (!scores.length) return json(request, none)
  const score = new Map(scores.map((entry) => [entry.id, entry.score]))
  const rating = (entry: Item) => entry.tmdbMetadata?.tmdbRating ?? 0
  const movies = item.mediaType === 'movie'
  // A movie is watched through its file. A series only once every episode is.
  const watched = repositoryService.watchedCondition(request.session!.accountId)
  const candidates = findItems({
    where: { id: [...score.keys()], mediaKind: item.mediaType, isMissing: 0 },
    ...(movies ? { compiledConditions: { ...watched, sql: `NOT ${watched.sql}` } } : {})
  }).sort((a, b) => score.get(b.id)! - score.get(a.id)! || rating(b) - rating(a))
  const related = await relate(candidates, request, { progress: !movies })
  const items = candidates.filter((entry) => {
    const progress = related.progress.get(entry.id)
    return movies || !progress || progress.watched < progress.total
  }).slice(0, limit)
  const dtos = items.map((entry) => toDto(entry, related, dtoOptions(request.query)))
  return json(request, { Items: dtos, TotalRecordCount: dtos.length, StartIndex: 0 })
}

async function ancestorsHandler(request: JellyfinRequest) {
  const item = requireItem(request)
  const related = await relate([item], request)
  const seriesId = related.seriesOf.get(item.id)
  const chain: BaseItemDto[] = []
  if (item.mediaType === 'episode' && seriesId) {
    const season = related.seasons.get(seasonKey(seriesId, item.seasonNumber))
    if (season) chain.push(toDto(season, await relate([season], request), dtoOptions(request.query)))
  }
  if (seriesId) chain.push(toDto(related.series.get(seriesId)!, await relate([related.series.get(seriesId)!], request), dtoOptions(request.query)))
  const library = views(request).find((view) => view.type === (item.mediaType === 'movie' ? 'movies' : 'tvshows'))
  if (library) chain.push(viewDto(library))
  return json(request, chain)
}

async function genresHandler(request: JellyfinRequest) {
  const names = await getAutocompleteValues('genre', request.query.get('searchTerm') ?? '', 10_000)
  const start = request.query.int('startIndex') ?? 0
  const page = names.slice(start, start + (request.query.int('limit') ?? names.length))
  const server = settingsService.getServerId()
  return json(request, {
    Items: page.map((name) => ({
      Name: name, ServerId: server, Id: genreToJellyfinId(name), Type: 'Genre', IsFolder: true, SortName: name.toLowerCase(),
      ImageTags: {}, BackdropImageTags: [], LocationType: 'FileSystem', MediaType: 'Unknown'
    } satisfies BaseItemDto)),
    TotalRecordCount: names.length, StartIndex: start
  })
}

async function filtersHandler(request: JellyfinRequest) {
  const [genres, years] = await Promise.all([getAutocompleteValues('genre', '', 10_000), getAutocompleteValues('year', '', 10_000)])
  return json(request, { Genres: genres, Tags: [], OfficialRatings: [], Years: years.map(Number).filter(Number.isSafeInteger).sort((a, b) => b - a) })
}

async function filters2Handler(request: JellyfinRequest) {
  const genres = await getAutocompleteValues('genre', '', 10_000)
  return json(request, { Genres: genres.map((name) => ({ Name: name, Id: genreToJellyfinId(name) })), Tags: [] })
}

function countsHandler(request: JellyfinRequest) {
  const count = (mediaType: string) => repositoryService.count({ where: { mediaKind: mediaType, isMissing: 0 } })
  return json(request, {
    MovieCount: count('movie'), SeriesCount: count('tv'), EpisodeCount: count('episode'), ArtistCount: 0, ProgramCount: 0,
    TrailerCount: 0, SongCount: 0, AlbumCount: 0, MusicVideoCount: 0, BoxSetCount: 0, BookCount: 0, ItemCount: 0
  })
}

export function userViews(request: JellyfinRequest) {
  const shown = views(request).map(viewDto)
  return json(request, { Items: shown, TotalRecordCount: shown.length, StartIndex: 0 })
}

const empty = (request: JellyfinRequest) => json(request, { Items: [], TotalRecordCount: 0, StartIndex: 0 })

export const itemRoutes = [
  route('GET', '/Items', itemsHandler),
  route('GET', '/Items', itemsHandler, { alias: '/Users/{userId}/Items' }),
  route('GET', '/Items/{itemId}', getItemHandler),
  route('GET', '/Items/{itemId}', getItemHandler, { alias: '/Users/{userId}/Items/{itemId}' }),
  route('GET', '/Items/Latest', latestHandler),
  route('GET', '/Items/Latest', latestHandler, { alias: '/Users/{userId}/Items/Latest' }),
  route('GET', '/UserItems/Resume', resumeHandler),
  route('GET', '/UserItems/Resume', resumeHandler, { alias: '/Users/{userId}/Items/Resume' }),
  route('GET', '/UserViews', userViews),
  route('GET', '/UserViews', userViews, { alias: '/Users/{userId}/Views' }),
  route('GET', '/Shows/NextUp', nextUpHandler),
  route('GET', '/Shows/{seriesId}/Seasons', seasonsHandler),
  route('GET', '/Shows/{seriesId}/Episodes', episodesHandler),
  route('GET', '/Items/{itemId}/Similar', similarHandler),
  route('GET', '/Shows/{itemId}/Similar', similarHandler),
  route('GET', '/Movies/{itemId}/Similar', similarHandler),
  route('GET', '/Items/{itemId}/Ancestors', ancestorsHandler),
  route('GET', '/Genres', genresHandler),
  route('GET', '/Items/Filters', filtersHandler),
  route('GET', '/Items/Filters2', filters2Handler),
  route('GET', '/Items/Counts', countsHandler),
  route('GET', '/Items/{itemId}/SpecialFeatures', (request) => extrasHandler(request, false)),
  route('GET', '/Items/{itemId}/SpecialFeatures', (request) => extrasHandler(request, false), { alias: '/Users/{userId}/Items/{itemId}/SpecialFeatures' }),
  route('GET', '/Items/{itemId}/LocalTrailers', (request) => extrasHandler(request, true)),
  route('GET', '/Items/{itemId}/LocalTrailers', (request) => extrasHandler(request, true), { alias: '/Users/{userId}/Items/{itemId}/LocalTrailers' }),
  // Kinome has no studios or upcoming episodes for Jellyfin clients.
  route('GET', '/Items/{itemId}/Intros', empty),
  route('GET', '/Items/{itemId}/Intros', empty, { alias: '/Users/{userId}/Items/{itemId}/Intros' }),
  route('GET', '/Items/{itemId}/ThemeMedia', (request) => {
    const none = { Items: [], TotalRecordCount: 0, StartIndex: 0, OwnerId: request.params.itemId }
    return json(request, { ThemeVideosResult: none, ThemeSongsResult: none, SoundtrackSongsResult: none })
  }),
  route('GET', '/Items/{itemId}/ThemeSongs', empty),
  route('GET', '/Items/{itemId}/ThemeVideos', empty),
  route('GET', '/Videos/{itemId}/AdditionalParts', empty),
  route('GET', '/Items/Suggestions', empty),
  route('GET', '/Shows/Upcoming', empty),
  route('GET', '/Studios', empty),
  route('GET', '/Persons', empty),
  route('GET', '/Years', empty),
  route('GET', '/Playlists', empty),
  route('GET', '/MediaSegments/{itemId}', empty),
  route('GET', '/Search/Hints', async (request) => {
    const result = await queryItems(request, { types: ['Movie', 'Series', 'Episode'] })
    return json(request, {
      SearchHints: result.Items.map((item) => ({
        ItemId: item.Id, Id: item.Id, Name: item.Name, Type: item.Type, MediaType: item.MediaType, ProductionYear: item.ProductionYear,
        PrimaryImageTag: item.ImageTags?.Primary, IndexNumber: item.IndexNumber, ParentIndexNumber: item.ParentIndexNumber,
        Series: item.SeriesName, RunTimeTicks: item.RunTimeTicks, IsFolder: item.IsFolder, Artists: []
      })),
      TotalRecordCount: result.TotalRecordCount
    })
  }),
]

