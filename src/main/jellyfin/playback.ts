/**
 * Playback for Jellyfin clients. A client sends its device profile, Kinome
 * decides between playing the file directly and its existing HLS conversion,
 * and the client reports progress back.
 */
import type { components } from './openapi'
import type { LocalMedia, LocalMediaTrack } from '@shared/local-media'
import { isMatroskaContainer, isMp4Container } from '@shared/local-media'
import { isVideoQuality, videoQualityHeights, type PlaybackQuality, type VideoQuality } from '@shared/playback-quality'
import type { WebPlaybackInfo, WebSubtitle } from '@shared/web-playback'
import * as authService from '../services/auth.service'
import * as playbackService from '../services/playback.service'
import * as libraryService from '../services/library.service'
import * as repositoryService from '../services/repository.service'
import { getWebPlaybackInfo, serveSubtitle, updateWebPlayback } from '../services/web-playback.service'
import { serveHls } from '../services/transcoding.service'
import { TRICKPLAY_WIDTH, trickplaySheet } from '../services/trickplay.service'
import * as events from './events'
import { reportPlayback } from './sessions'
import { resolveItemId, toJellyfinId } from './ids'
import {
  FAVORITE, findItems, itemKind, mediaSource, mediaStreams, playableFile, relate, requireItem, videoRangeType, type Item, type MediaStream
} from './items'
import { JellyfinError, field, json, notFound, route, type JellyfinRequest } from './request'

type DeviceProfile = components['schemas']['DeviceProfile']
type ProfileCondition = components['schemas']['ProfileCondition']
type MediaSourceInfo = components['schemas']['MediaSourceInfo']
type TranscodeReason = components['schemas']['TranscodeReason']

const TICKS_PER_SECOND = 10_000_000
// Nominal bitrates of Kinome's renditions, used to honour a client's bitrate limit.
const RENDITION_BITRATES: Record<VideoQuality, number> = {
  '4k': 40_000_000, '1440p': 20_000_000, '1080p': 10_000_000, '720p': 5_000_000, '480p': 2_500_000,
  '360p': 1_200_000, '240p': 600_000
}

/** Profile names for a probed container. FFmpeg can name several, as in matroska,webm. */
function containerNames(container: string | undefined): string[] {
  return (container ?? '').split(',').filter(Boolean).flatMap((name) =>
    isMatroskaContainer(name) ? ['mkv', 'webm', 'matroska']
      : isMp4Container(name) ? ['mp4', 'm4v', 'mov']
      : name === 'mpegts' ? ['ts', 'mpegts'] : [name])
}

function listed(list: string | null | undefined, values: string[]): boolean {
  if (!list) return true
  const allowed = list.toLowerCase().split(',').map((value) => value.trim())
  return values.some((value) => allowed.includes(value.toLowerCase()))
}

function codecName(track: LocalMediaTrack | undefined): string[] {
  if (!track?.codec) return []
  // Jellyfin profiles name some codecs differently from FFmpeg.
  const aliases: Record<string, string[]> = { h264: ['h264', 'avc'], hevc: ['hevc', 'h265'], mpeg2video: ['mpeg2video', 'mpeg2'], dts: ['dts', 'dca'] }
  return aliases[track.codec] ?? [track.codec]
}

function propertyValue(property: string, video?: LocalMediaTrack, audio?: LocalMediaTrack, media?: LocalMedia): string | number | boolean | undefined {
  const depth = /(?:p|gray)(10|12|16)(?:le|be)?$/.exec(video?.pixelFormat ?? '')?.[1]
  const [frames, seconds = 1] = (video?.frameRate ?? '').split('/').map(Number)
  switch (property) {
    case 'Width': return video?.width
    case 'Height': return video?.height
    case 'VideoBitDepth': return video?.pixelFormat ? Number(depth ?? 8) : undefined
    case 'VideoLevel': return video?.level
    case 'VideoProfile': return video?.profile
    case 'VideoFramerate': return frames && seconds ? frames / seconds : undefined
    case 'VideoBitrate': return video?.bitrate ?? media?.bitrate
    case 'IsInterlaced': return ['tt', 'bb', 'tb', 'bt'].includes(video?.fieldOrder ?? '')
    case 'IsAnamorphic': return false
    case 'IsAvc': return video?.codec === 'h264'
    case 'VideoRangeType': return videoRangeType(video)
    case 'AudioChannels': return audio?.channels
    case 'AudioBitrate': return audio?.bitrate
    case 'AudioProfile': return audio?.profile
    case 'AudioSampleRate': return audio?.sampleRate
    case 'NumAudioStreams': return media?.tracks.filter((track) => track.kind === 'audio').length
    case 'NumVideoStreams': return media?.tracks.filter((track) => track.kind === 'video').length
    default: return undefined
  }
}

function satisfied(condition: ProfileCondition, actual: string | number | boolean | undefined): boolean {
  if (actual === undefined || actual === null || condition.Value === undefined || condition.Value === null) return !condition.IsRequired
  const expected = condition.Value
  const text = String(actual).toLowerCase()
  switch (condition.Condition) {
    case 'Equals': return text === expected.toLowerCase()
    case 'NotEquals': return text !== expected.toLowerCase()
    case 'EqualsAny': return expected.toLowerCase().split('|').includes(text)
    case 'LessThanEqual': return Number(actual) <= Number(expected)
    case 'GreaterThanEqual': return Number(actual) >= Number(expected)
    default: return true
  }
}

const REASONS: Record<string, TranscodeReason> = {
  Width: 'VideoResolutionNotSupported', Height: 'VideoResolutionNotSupported', VideoBitDepth: 'VideoBitDepthNotSupported',
  VideoLevel: 'VideoLevelNotSupported', VideoProfile: 'VideoProfileNotSupported', VideoFramerate: 'VideoFramerateNotSupported',
  VideoBitrate: 'VideoBitrateNotSupported', IsInterlaced: 'InterlacedVideoNotSupported', VideoRangeType: 'VideoRangeTypeNotSupported',
  AudioChannels: 'AudioChannelsNotSupported', AudioBitrate: 'AudioBitrateNotSupported', AudioProfile: 'AudioProfileNotSupported',
  AudioSampleRate: 'AudioSampleRateNotSupported'
}

/** The reasons the profile's codec conditions reject the selected streams. */
function codecProblems(profile: DeviceProfile, container: string[], video?: LocalMediaTrack, audio?: LocalMediaTrack, media?: LocalMedia) {
  const video_: TranscodeReason[] = []
  const audio_: TranscodeReason[] = []
  for (const codecProfile of profile.CodecProfiles ?? []) {
    const isVideo = codecProfile.Type === 'Video'
    const track = isVideo ? video : audio
    if (!track || !listed(codecProfile.Codec, codecName(track)) || !listed(codecProfile.Container, container)) continue
    const applies = (codecProfile.ApplyConditions ?? []).every((condition) =>
      satisfied(condition, propertyValue(condition.Property!, video, audio, media)))
    if (!applies) continue
    for (const condition of codecProfile.Conditions ?? []) {
      if (!satisfied(condition, propertyValue(condition.Property!, video, audio, media))) {
        const reason = REASONS[condition.Property!] ?? (isVideo ? 'VideoCodecNotSupported' : 'AudioCodecNotSupported')
        ;(isVideo ? video_ : audio_).push(reason)
      }
    }
  }
  return { video: video_, audio: audio_ }
}

interface Decision {
  directPlay: boolean
  quality?: PlaybackQuality | 'audio'
  videoCodec?: 'hevc'
  /** A conversion copies the soundtrack only when told to. */
  sound?: 'copy' | 'stereo'
  reasons: TranscodeReason[]
}

/** Chooses how the client plays the file, from its profile and Kinome's available conversions. */
export function negotiate(
  profile: DeviceProfile, info: Pick<WebPlaybackInfo, 'qualities' | 'audioConversion'>, media: LocalMedia,
  options: { audioIndex?: number; maxBitrate?: number; directPlay?: boolean; maxAudioChannels?: number }
): Decision | undefined {
  const video = media.tracks.find((track) => track.kind === 'video')
  const audioTracks = media.tracks.filter((track) => track.kind === 'audio')
  const audio = audioTracks.find((track) => track.index === options.audioIndex) ?? audioTracks.find((track) => track.default) ?? audioTracks[0]
  const container = containerNames(media.container)
  const maxBitrate = options.maxBitrate ?? profile.MaxStreamingBitrate ?? undefined
  const problems = codecProblems(profile, container, video, audio, media)
  const reasons: TranscodeReason[] = []
  const playsVideo = (profiles: { VideoCodec?: string | null }[]) => !video || profiles.some((entry) => listed(entry.VideoCodec, codecName(video)))
  const playsAudio = (profiles: { AudioCodec?: string | null }[]) => !audio || profiles.some((entry) => listed(entry.AudioCodec, codecName(audio)))

  const direct = (profile.DirectPlayProfiles ?? []).filter((entry) => entry.Type === 'Video' && listed(entry.Container, container))
  if (!direct.length) reasons.push('ContainerNotSupported')
  else {
    if (!direct.some((entry) => listed(entry.VideoCodec, codecName(video)))) reasons.push('VideoCodecNotSupported')
    if (!direct.some((entry) => listed(entry.VideoCodec, codecName(video)) && listed(entry.AudioCodec, codecName(audio)))) reasons.push('AudioCodecNotSupported')
  }
  reasons.push(...problems.video, ...problems.audio)
  if (maxBitrate && media.bitrate && media.bitrate > maxBitrate) reasons.push('ContainerBitrateExceedsLimit')
  if (options.maxAudioChannels && audio?.channels && audio.channels > options.maxAudioChannels) reasons.push('AudioChannelsNotSupported')
  if (!reasons.length && options.directPlay !== false) return { directPlay: true, reasons }

  const hls = (profile.TranscodingProfiles ?? []).filter((entry) => entry.Type === 'Video')
  const targets = hls.length ? hls : [{ VideoCodec: 'h264', AudioCodec: 'aac', MaxAudioChannels: undefined }]
  const maxChannels = Math.min(options.maxAudioChannels ?? Infinity, ...targets.map((entry) => Number(entry.MaxAudioChannels) || Infinity))
  const sound = maxChannels <= 2 ? 'stereo' as const : undefined
  const bitrateOk = !maxBitrate || !media.bitrate || media.bitrate <= maxBitrate
  // A converted stream carries a Dolby Vision file's compatible base layer only, so it is judged without it.
  const copiedVideo = video?.dolbyVision?.compatibility ? { ...video, dolbyVision: undefined } : video
  const copiedProblems = copiedVideo === video ? problems.video : codecProblems(profile, container, copiedVideo, audio, media).video
  const copyVideo = bitrateOk && !copiedProblems.length && playsVideo(targets)
  const copyAudio = !problems.audio.length && playsAudio(targets) && !(audio?.channels && audio.channels > maxChannels)
  if (copyVideo && copyAudio && info.qualities.includes('remux')) return { directPlay: false, quality: 'remux', reasons }
  if (copyVideo && !copyAudio && info.audioConversion && audio) return { directPlay: false, quality: 'audio', sound, reasons }

  const height = video?.height ?? Infinity
  const renditions = info.qualities.filter(isVideoQuality).sort((a, b) => videoQualityHeights[b] - videoQualityHeights[a])
  // Keep the source size unless the bitrate limit asks for less.
  const quality = renditions.find((rendition) => videoQualityHeights[rendition] <= height &&
    (!maxBitrate || RENDITION_BITRATES[rendition] <= maxBitrate)) ?? renditions.at(-1)
  if (!quality) return undefined
  const hdr = video?.colorTransfer === 'smpte2084' || video?.colorTransfer === 'arib-std-b67'
  const tenBit = /(?:10|12)(?:le|be)?$/.test(video?.pixelFormat ?? '')
  const videoCodec = (hdr || tenBit) && targets.some((entry) => listed(entry.VideoCodec, ['hevc'])) ? 'hevc' as const : undefined
  return { directPlay: false, quality, videoCodec, sound: copyAudio ? 'copy' : sound, reasons }
}

// --- Subtitles ---

const SUBTITLE_CODECS: Record<WebSubtitle['format'], string> = { text: 'subrip', ass: 'ass', pgs: 'pgssub', vobsub: 'dvdsub' }

/** Embedded subtitles keep their stream index. Sidecar files follow the last stream. */
function subtitleIndexes(info: WebPlaybackInfo): Map<number, WebSubtitle> {
  const media = info.media
  let next = Math.max(-1, ...(media?.tracks ?? []).map((track) => track.index)) + 1
  return new Map(info.subtitles.map((subtitle) => [
    subtitle.id.startsWith('e-') ? Number(subtitle.id.slice(2)) : next++, subtitle
  ]))
}

function subtitleStreams(
  info: WebPlaybackInfo, profile: DeviceProfile, request: JellyfinRequest, itemId: string, sourceId: string, directPlay: boolean
): MediaStream[] {
  const formats = (method: string) => new Set((profile.SubtitleProfiles ?? []).filter((entry) => entry.Method === method)
    .map((entry) => entry.Format?.toLowerCase()))
  const external = formats('External')
  const embed = formats('Embed')
  const query = new URLSearchParams({ ApiKey: request.token ?? '' })
  return [...subtitleIndexes(info)].map(([index, subtitle]) => {
    const codec = SUBTITLE_CODECS[subtitle.format]
    const text = subtitle.format === 'text' || subtitle.format === 'ass'
    const format = subtitle.format === 'ass' ? (external.has('ass') ? 'ass' : external.has('ssa') ? 'ssa' : undefined)
      : subtitle.format === 'text' ? (external.has('vtt') ? 'vtt' : external.has('srt') || external.has('subrip') ? 'srt' : undefined)
      : undefined
    const embedded = !subtitle.sidecar && directPlay && (embed.has(codec) || embed.has(subtitle.format === 'text' ? 'srt' : subtitle.format === 'pgs' ? 'pgs' : codec))
    const method = embedded ? 'Embed' : format ? 'External' : 'Drop'
    return {
      Codec: codec, Language: subtitle.language, Title: subtitle.title, Type: 'Subtitle', Index: index, IsOriginal: false, IsInterlaced: false,
      DisplayTitle: [subtitle.title || subtitle.language, codec.toUpperCase(), subtitle.forced && 'Forced'].filter(Boolean).join(' - '),
      IsDefault: !!subtitle.default, IsForced: !!subtitle.forced, IsHearingImpaired: !!subtitle.hearingImpaired,
      IsExternal: !!subtitle.sidecar, IsTextSubtitleStream: text, SupportsExternalStream: text, DeliveryMethod: method,
      VideoRange: 'Unknown', VideoRangeType: 'Unknown', AudioSpatialFormat: 'None',
      DeliveryUrl: method === 'External' ? `/Videos/${itemId}/${sourceId}/Subtitles/${index}/0/Stream.${format}?${query}` : undefined,
      IsExternalUrl: false
    } satisfies MediaStream
  })
}

function vttToSrt(vtt: string): string {
  const cues = vtt.replace(/\r/g, '').split(/\n{2,}/).filter((block) => block.includes('-->'))
  return cues.map((block, index) => {
    const lines = block.split('\n')
    const timing = lines.findIndex((line) => line.includes('-->'))
    const [start, end] = lines[timing].split('-->').map((time) => {
      const value = time.trim().split(/\s+/)[0]
      return (value.split(':').length === 2 ? `00:${value}` : value).replace('.', ',')
    })
    return `${index + 1}\n${start} --> ${end}\n${lines.slice(timing + 1).join('\n')}`
  }).join('\n\n') + '\n'
}

// --- Handlers ---

/**
 * The file that plays for a presented ID. As in Jellyfin, a title's media
 * source has the title's ID, so a movie's ID stands for its feature file.
 */
async function fileFor(request: JellyfinRequest, id: string | undefined): Promise<Item | undefined> {
  const itemId = resolveItemId(id)
  const [item] = itemId ? findItems({ where: { id: itemId } }) : []
  if (!item) return undefined
  return item.type === 'file' ? item : playableFile(item, await relate([item], request))
}

/** The item and the file that plays for it. A client may name the file as its media source. */
async function playableItem(request: JellyfinRequest, mediaSourceId = request.query.get('mediaSourceId')): Promise<{ item: Item; file: Item }> {
  const item = requireItem(request)
  const file = await fileFor(request, mediaSourceId ?? request.params.itemId)
  if (!file || (file.id !== item.id && file.parentId !== item.id)) throw notFound()
  return { item, file }
}

/**
 * Jellyfin serves streams and subtitles without credentials, and clients such
 * as Findroid play URLs that carry none. Kinome allows that only for an item
 * whose playback info the same address asked for with a valid sign-in, for as
 * long as that sign-in stays valid and the item keeps being played.
 */
const MEDIA_GRANT_MS = 6 * 60 * 60 * 1000
const mediaGrants = new Map<string, { token: string; until: number }>()

function grantMedia(request: JellyfinRequest) {
  if (!request.token) return
  const now = Date.now()
  for (const [key, grant] of mediaGrants) if (grant.until < now) mediaGrants.delete(key)
  mediaGrants.set(`${request.params.itemId.toLowerCase()}:${request.address}`, { token: request.token, until: now + MEDIA_GRANT_MS })
}

export function grantedSession(params: Record<string, string>, address: string) {
  const itemId = params.itemId ?? params.routeItemId
  const grant = itemId ? mediaGrants.get(`${itemId.toLowerCase()}:${address}`) : undefined
  if (!grant || grant.until < Date.now()) return null
  grant.until = Date.now() + MEDIA_GRANT_MS
  return authService.validateToken(grant.token)
}

async function playbackInfo(request: JellyfinRequest) {
  const body = request.request.method === 'POST' ? await request.body() : undefined
  const value = <T>(name: string): T | undefined => field<T>(body, name) ?? request.query.get(name) as T | undefined
  const { item, file: target } = await playableItem(request, value<string>('MediaSourceId') ?? undefined)
  const info = await getWebPlaybackInfo(target.id, request.session!.accountId)
  if (!info?.media) throw notFound()
  grantMedia(request)
  const profile = field<DeviceProfile>(body, 'DeviceProfile') ?? {}
  const audioIndex = value<number | string>('AudioStreamIndex')
  const decision = negotiate(profile, info, info.media, {
    audioIndex: audioIndex === undefined ? undefined : Number(audioIndex),
    maxBitrate: Number(value('MaxStreamingBitrate')) || undefined,
    maxAudioChannels: Number(value('MaxAudioChannels')) || undefined,
    directPlay: value<boolean | string>('EnableDirectPlay') === false || value('EnableDirectPlay') === 'false' ? false : undefined
  })
  const related = await relate([item], request)
  const itemId = toJellyfinId(item.id)
  // The version Kinome picks is named by the title's ID, any other by its file's, as in the item's media sources.
  const picked = target.id === item.id || related.versions.get(item.id)?.[0]?.id === target.id
  const source: MediaSourceInfo = mediaSource(picked ? item : target, target, related, info.media)
  const directPlay = !!decision?.directPlay
  source.MediaStreams = [
    ...mediaStreams(info.media).filter((stream) => stream.Type !== 'Subtitle'),
    ...subtitleStreams(info, profile, request, itemId, source.Id!, directPlay)
  ]
  source.SupportsDirectPlay = directPlay
  source.SupportsDirectStream = directPlay
  source.SupportsTranscoding = !!decision && !directPlay
  source.DefaultAudioStreamIndex = audioIndex === undefined ? source.DefaultAudioStreamIndex : Number(audioIndex)
  const playSessionId = crypto.randomUUID().replaceAll('-', '')
  if (decision && !directPlay && decision.quality) {
    // Fragmented MP4 suits native players too, and unlike TS it can carry copied HEVC to Apple devices.
    const query = new URLSearchParams({ token: request.token ?? '', web: '1', PlaySessionId: playSessionId })
    if (audioIndex !== undefined) query.set('audio', String(audioIndex))
    if (decision.videoCodec) query.set('videoCodec', decision.videoCodec)
    if (decision.sound) query.set('sound', decision.sound)
    if (decision.reasons.length) query.set('TranscodeReasons', decision.reasons.join(','))
    source.TranscodingUrl = `/Videos/${source.Id}/hls/${decision.quality}/master.m3u8?${query}`
    source.TranscodingSubProtocol = 'hls'
    source.TranscodingContainer = 'mp4'
  }
  if (itemKind(item) === 'Movie' || itemKind(item) === 'Episode') {
    console.debug('[Jellyfin] Playback negotiated', {
      itemId: item.id, client: request.device.client, method: directPlay ? 'DirectPlay' : decision?.quality ?? 'none', reasons: decision?.reasons
    })
  }
  return json(request, {
    MediaSources: decision ? [source] : [],
    PlaySessionId: playSessionId,
    ...(decision ? {} : { ErrorCode: 'NoCompatibleStream' })
  })
}

async function stream(request: JellyfinRequest) {
  const { file } = await playableItem(request)
  const response = await playbackService.handleCachedStream(file.id, request.request, request.session!.accountId, false)
  if (!response) throw notFound()
  return response
}

async function download(request: JellyfinRequest) {
  const { file } = await playableItem(request)
  const response = await playbackService.handleCachedStream(file.id, request.request, request.session!.accountId, false)
  if (!response) throw notFound()
  response.headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`)
  return response
}

async function trickplay(request: JellyfinRequest) {
  const file = await fileFor(request, request.query.get('mediaSourceId') ?? request.params.itemId)
  if (!file || Number(request.params.width) !== TRICKPLAY_WIDTH) throw notFound()
  const [source, info] = await Promise.all([
    playbackService.resolveStreamPath(file.id, request.session!.accountId),
    getWebPlaybackInfo(file.id, request.session!.accountId)
  ])
  const duration = info?.media?.durationSeconds
  const sheet = source && duration ? await trickplaySheet(source, duration, Number(request.params.index)) : undefined
  if (!sheet) throw notFound()
  return new Response(Bun.file(sheet), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } })
}

async function hls(request: JellyfinRequest) {
  const file = await fileFor(request, request.params.itemId)
  const quality = request.params.quality
  if (!file || (quality !== 'audio' && quality !== 'remux' && !isVideoQuality(quality))) throw notFound()
  return serveHls(request.request, file.id, quality, request.params.resource, request.session!.accountId)
}

async function subtitle(request: JellyfinRequest) {
  const fileId = (await fileFor(request, request.params.routeMediaSourceId) ?? await fileFor(request, request.params.routeItemId))?.id
  if (!fileId) throw notFound()
  const info = await getWebPlaybackInfo(fileId, request.session!.accountId)
  const entry = info && subtitleIndexes(info).get(Number(request.params.routeIndex))
  if (!entry) throw notFound()
  const format = request.params.routeFormat.toLowerCase()
  const plain = new Request(new URL(request.request.url).origin, { headers: { accept: '*/*' }, signal: request.request.signal })
  const response = await serveSubtitle(plain, fileId, entry.id, 'track', request.session!.accountId)
  if (!response.ok || entry.format !== 'text' || format !== 'srt') return response
  return new Response(vttToSrt(await response.text()), { headers: { 'Content-Type': 'application/x-subrip; charset=utf-8' } })
}

/** Reported positions apply to the file that plays. A movie reports through its feature. */
function reportedFile(request: JellyfinRequest, body: Record<string, unknown> | undefined): Promise<Item | undefined> {
  return fileFor(request, field<string>(body, 'MediaSourceId') ?? field<string>(body, 'ItemId') ?? request.params.itemId)
}

async function progress(request: JellyfinRequest, stopped = false) {
  const body = await request.body()
  const file = await reportedFile(request, body)
  if (!file) return undefined
  const ticks = Number(field(body, 'PositionTicks') ?? request.query.get('positionTicks') ?? 0)
  const position = Math.max(0, ticks / TICKS_PER_SECOND)
  const duration = file.videoSummary?.durationSeconds ?? 0
  // As in Jellyfin, the last tenth completes the item and the first twentieth does not count.
  const completed = stopped && duration > 0 && position >= duration * 0.9
  const resumable = position >= duration * 0.05
  await updateWebPlayback(file.id, request.session!.accountId, completed || !resumable ? 0 : position, completed)
  // Other devices learn the resume position once playback stops, not on every report.
  if (stopped) events.userDataChanged(request.session!.accountId, [file.id])
  reportPlayback(request, body, stopped)
  return undefined
}

function userData(request: JellyfinRequest, item: Item, watched: boolean, position = 0) {
  const id = toJellyfinId(item.id)
  const favorite = repositoryService.itemsWithPersonalTag(request.session!.accountId, [item.id], FAVORITE.key, FAVORITE.value).has(item.id)
  return {
    PlaybackPositionTicks: Math.round(position * TICKS_PER_SECOND), PlayCount: watched ? 1 : 0, IsFavorite: favorite,
    Played: watched, Key: id, ItemId: id, LastPlayedDate: watched ? new Date().toISOString() : undefined
  }
}

async function setPlayed(request: JellyfinRequest, played: boolean) {
  const item = requireItem(request)
  if (played) await libraryService.markAsWatched(item.id, request.session!.accountId)
  else await libraryService.markAsUnwatched(item.id, request.session!.accountId)
  return json(request, userData(request, item, played))
}

async function currentUserData(request: JellyfinRequest, item: Item) {
  const state = playableFile(item, await relate([item], request)) ?? item
  return json(request, userData(request, item, !!state.watched, state.playbackPosition ?? 0))
}

/** A favourite is the account's personal tag favorite:true on the title. */
async function setFavorite(request: JellyfinRequest, favorite: boolean) {
  const item = requireItem(request)
  repositoryService.setPersonalTag(request.session!.accountId, item.id, FAVORITE.key, favorite ? FAVORITE.value : null)
  events.userDataChanged(request.session!.accountId, [item.id])
  return currentUserData(request, item)
}

export const playbackRoutes = [
  route('POST', '/Items/{itemId}/PlaybackInfo', playbackInfo),
  route('GET', '/Items/{itemId}/PlaybackInfo', playbackInfo),
  route('GET', '/Videos/{itemId}/stream', stream, { media: true }),
  route('HEAD', '/Videos/{itemId}/stream', stream, { media: true }),
  route('GET', '/Videos/{itemId}/stream.{container}', stream, { media: true }),
  route('HEAD', '/Videos/{itemId}/stream.{container}', stream, { media: true }),
  route('GET', '/Items/{itemId}/Download', download),
  route('GET', '/Videos/{itemId}/Trickplay/{width}/{index}.jpg', trickplay),
  route('GET', '/Videos/{itemId}/hls/{quality}/{resource}', hls),
  route('HEAD', '/Videos/{itemId}/hls/{quality}/{resource}', hls),
  route('GET', '/Videos/{routeItemId}/{routeMediaSourceId}/Subtitles/{routeIndex}/Stream.{routeFormat}', subtitle, { media: true }),
  route('GET', '/Videos/{routeItemId}/{routeMediaSourceId}/Subtitles/{routeIndex}/{routeStartPositionTicks}/Stream.{routeFormat}', subtitle, { media: true }),
  route('POST', '/Sessions/Playing', (request) => progress(request)),
  route('POST', '/Sessions/Playing/Progress', (request) => progress(request)),
  route('POST', '/Sessions/Playing/Stopped', (request) => progress(request, true)),
  route('POST', '/Sessions/Playing/Ping', () => undefined),
  route('POST', '/UserPlayedItems/{itemId}', (request) => setPlayed(request, true)),
  route('POST', '/UserPlayedItems/{itemId}', (request) => setPlayed(request, true), { alias: '/Users/{userId}/PlayedItems/{itemId}' }),
  route('DELETE', '/UserPlayedItems/{itemId}', (request) => setPlayed(request, false)),
  route('DELETE', '/UserPlayedItems/{itemId}', (request) => setPlayed(request, false), { alias: '/Users/{userId}/PlayedItems/{itemId}' }),
  route('GET', '/UserItems/{itemId}/UserData', (request) => currentUserData(request, requireItem(request))),
  route('POST', '/UserFavoriteItems/{itemId}', (request) => setFavorite(request, true)),
  route('POST', '/UserFavoriteItems/{itemId}', (request) => setFavorite(request, true), { alias: '/Users/{userId}/FavoriteItems/{itemId}' }),
  route('DELETE', '/UserFavoriteItems/{itemId}', (request) => setFavorite(request, false)),
  route('DELETE', '/UserFavoriteItems/{itemId}', (request) => setFavorite(request, false), { alias: '/Users/{userId}/FavoriteItems/{itemId}' }),
  route('DELETE', '/Items/{itemId}', () => { throw new JellyfinError(403, 'Kinome does not delete items through this API.') }),
]
