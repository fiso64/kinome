import { stat } from 'node:fs/promises'
import { defaultAudioTrack, isMatroskaContainer, isMp4Container } from '@shared/local-media'
import { avcFormat, isHdrTransfer, type PlaybackEncodingPreferences, type PlaybackOutput } from '@shared/playback-quality'
import { probeMedia } from '../probe-media'
import { readMatroskaCueTimes, type MatroskaSubtitleIndex } from './matroska-cues'
import { readMp4Keyframes } from './mp4-keyframes'
import { copiesVideo, type SegmentQuality, type SegmentSource } from './segment-job'
import { createTimeline } from './timeline'
import { ffmpeg } from './runtime'

export { PlaybackSession } from './session'
export { segmentPlaylist } from './timeline'

interface SourceMetadata {
  key: string
  revision: string
  media: ReturnType<typeof probeMedia>
  firstPicture?: Promise<number>
  x264Build?: Promise<number | undefined>
  cues?: Promise<number[]>
  subtitleIndexes?: Promise<Map<number, MatroskaSubtitleIndex>>
}

const metadata = new Map<string, SourceMetadata>()
const retainedSources = 128
const transportVideo = new Set(['h264', 'hevc', 'mpeg1video', 'mpeg2video', 'mpeg4', 'vc1'])
const browserTransportAudio = new Set(['aac', 'mp3', 'ac3', 'eac3'])
const transportAudio = new Set(['aac', 'ac3', 'eac3', 'dts', 'mp2', 'mp3', 'opus', 'truehd'])

export async function playbackMetadata(probe: string, path: string): Promise<SourceMetadata> {
  const file = await stat(path)
  if (!file.isFile()) throw new Error('Playback source is not a file')
  const key = JSON.stringify([path, file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs])
  let record = metadata.get(key)
  if (!record) record = { key, revision: Bun.hash(key).toString(36), media: probeMedia(probe, path) }
  metadata.delete(key)
  metadata.set(key, record)
  if (metadata.size > retainedSources) metadata.delete(metadata.keys().next().value!)
  try {
    await record.media
  } catch (error) {
    if (metadata.get(key) === record) metadata.delete(key)
    throw error
  }
  return record
}

// Program and transport streams have no container keyframe table. Inspect
// the first decodable keyframe at a demuxer seek point without scanning the
// rest of a recording or building a second on-disk index.
async function firstMpegPicture(probe: string, path: string, videoIndex: number, origin: number, seek: number, signal?: AbortSignal) {
  const process = Bun.spawn([
    probe, '-v', 'quiet', '-protocol_whitelist', 'file', '-select_streams', String(videoIndex), '-skip_frame', 'nokey',
    ...(seek > 0 ? ['-read_intervals', `${origin + seek}%`] : []),
    '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', '-i', path
  ], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', signal })
  try {
    let pending = ''
    for await (const chunk of process.stdout.pipeThrough(new TextDecoderStream())) {
      const lines = (pending + chunk).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const time = parseFloat(line)
        if (Number.isFinite(time)) return Math.max(0, time - origin)
      }
    }
    signal?.throwIfAborted()
    return Infinity
  } finally {
    process.kill()
    await process.exited
  }
}

async function readX264Build(path: string, videoIndex: number) {
  const process = Bun.spawn([
    ffmpeg!, '-v', 'error', '-nostdin', '-protocol_whitelist', 'file', '-i', path,
    '-map', `0:${videoIndex}`, '-c:v', 'copy', '-frames:v', '1',
    '-bsf:v', 'h264_mp4toannexb,filter_units=pass_types=6', '-f', 'h264', 'pipe:1'
  ], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const [code, sei] = await Promise.all([process.exited, new Response(process.stdout).text()])
  const build = code === 0 && /x264 - core (\d{1,5})\b/.exec(sei)
  return build ? Number(build[1]) : undefined
}

export function keyframeReaderFor(container?: string) {
  if (isMatroskaContainer(container)) return readMatroskaCueTimes
  if (isMp4Container(container)) return readMp4Keyframes
}

export async function openPlaybackSource(
  probe: string, path: string, quality: SegmentQuality, encoding: PlaybackEncodingPreferences,
  audioIndex?: number, browser = false, output: PlaybackOutput = {}
): Promise<SegmentSource> {
  const record = await playbackMetadata(probe, path)
  const media = await record.media
  const video = media.tracks.find((track) => track.kind === 'video')!
  const audios = media.tracks.filter((track) => track.kind === 'audio')
  const audio = audioIndex === undefined
    ? defaultAudioTrack(audios)
    : audios.find((track) => track.index === audioIndex)
  if (audioIndex !== undefined && !audio) throw new Error('Audio track does not exist')
  const audioTracks = !audio ? [] : audioIndex === undefined ? [audio, ...audios.filter((track) => track !== audio)] : [audio]

  let keyframes: number[] | undefined
  if (copiesVideo(quality)) {
    const readIndex = keyframeReaderFor(media.container)
    if (!readIndex) throw new Error('This container has no supported remux seek index')
    record.cues ??= readIndex(path)
    const start = media.startSeconds ?? 0
    keyframes = await record.cues
    if (start) keyframes = keyframes.map((time) => time - start)
  }
  const mpeg = media.container === 'mpegts' || media.container === 'mpeg'
  const origin = media.startSeconds ?? 0
  let firstPicture = video.startSeconds ?? 0
  if (mpeg) {
    record.firstPicture ??= firstMpegPicture(probe, path, video.index, origin, 0)
    const time = await record.firstPicture
    if (Number.isFinite(time)) firstPicture = time
  }
  const seekMpegInput = mpeg ? async (start: number, signal: AbortSignal) => {
    // FFmpeg's MPEG demuxers can seek into the middle of a GOP. Look back
    // farther for long GOPs until the decoder can reach the requested frame.
    for (let preroll = 2; preroll < start; preroll *= 2) {
      const seek = start - preroll
      if (await firstMpegPicture(probe, path, video.index, origin, seek, signal) < start) return seek
    }
    return 0
  } : undefined
  // Older x264 4:4:4 streams need their encoder's CABAC interpretation.
  // The encoder identifies itself in the opening SEI, absent after a seek.
  if (video.codec === 'h264' && /^(?:yuvj?444|gbrp)/.test(video.pixelFormat ?? '')) {
    record.x264Build ??= readX264Build(path, video.index)
  }
  const x264Build = await record.x264Build
  const { wideChroma, tenBit } = avcFormat(video.pixelFormat)
  const wideColor = wideChroma || tenBit || isHdrTransfer(video.colorTransfer)
  const videoCodec = !copiesVideo(quality) && wideColor
    ? output.videoCodec ?? (browser ? undefined : wideChroma ? 'avc' : 'hevc') : undefined
  const channelLimit = output.sound === 'stereo' || encoding.audioChannels === 'stereo' ? 2 :
    encoding.audioChannels === 'surround' ? 6 : 8
  const copyAudio = new Set(audioTracks.filter(track => {
    if (quality === 'remux') return true
    if (quality === 'audio' || output.sound === 'stereo') return false
    const channels = track.channels ?? 2
    if (encoding.audioChannels !== 'auto' && channels > channelLimit) return false
    return output.sound === 'copy' || (!browser && browserTransportAudio.has(track.codec ?? ''))
  }).map(track => track.index))
  // HLS.js accepts fewer elementary audio formats in TS than in fMP4.
  const tsAudio = browser ? browserTransportAudio : transportAudio
  const audioNeedsMp4 = audioTracks.some(track => {
    const copy = copyAudio.has(track.index)
    // Keep MP3 packet timestamps. Progressive TS is appended as raw
    // audio/mpeg in Chromium and can leave a hole at every segment.
    if (browser && copy && track.codec === 'mp3') return true
    if (copy && !tsAudio.has(track.codec ?? '')) return true
    // ADTS cannot represent all AAC channel configurations above 5.1.
    const channels = track.channels ?? 2
    return copy ? track.codec === 'aac' && channels > 6 : Math.min(channels, channelLimit) > 6
  })
  // A transport stream loses the container's rotation and reflection matrix.
  const copiedVideoNeedsMp4 = copiesVideo(quality) && (!!video.displayMatrix || (x264Build !== undefined && x264Build < 151) ||
    (browser && video.codec === 'hevc') || !transportVideo.has(video.codec ?? ''))
  // The HLS.js TS parser measures AVC crop offsets in 4:2:0 samples.
  // MP4 carries the display dimensions for 4:2:2 and 4:4:4 without that conversion.
  const wideAvc = browser && wideChroma && (copiesVideo(quality) ? video.codec === 'h264' : videoCodec === 'avc')
  const fragmented = videoCodec === 'hevc' || videoCodec === 'vp9' || wideAvc || audioNeedsMp4 || copiedVideoNeedsMp4
  const firstSound = browser && !fragmented
    ? audioTracks.reduce((start, track) => copyAudio.has(track.index) ? Math.max(start, track.startSeconds ?? 0) : start, 0) : 0
  return { path, video, audioTracks, quality, browser, fragmented, encoding, copyAudio, videoCodec, channelLimit, seekMpegInput, x264Build,
    timeline: createTimeline(media.durationSeconds ?? 0, keyframes, video.endSeconds, firstPicture, firstSound) }
}
