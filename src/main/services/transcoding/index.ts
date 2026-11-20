import { stat } from 'node:fs/promises'
import type { LocalMedia } from '@shared/local-media'
import type { PlaybackEncodingPreferences, VideoQuality } from '@shared/playback-quality'
import { probeMedia } from '../probe-media'
import { readMatroskaCueTimes } from './matroska-cues'
import { readMp4Keyframes } from './mp4-keyframes'
import type { SegmentSource } from './segment-job'
import { createTimeline } from './timeline'

export { PlaybackSession } from './session'
export { segmentPlaylist } from './timeline'

interface SourceMetadata {
  media: Promise<LocalMedia>
  cues?: Promise<number[]>
}

const metadata = new Map<string, SourceMetadata>()
const retainedSources = 128
const transportVideo = new Set(['h264', 'hevc', 'mpeg1video', 'mpeg2video', 'mpeg4', 'vc1'])
const transportAudio = new Set(['aac', 'ac3', 'eac3', 'dts', 'mp2', 'mp3', 'opus', 'truehd'])

export async function openPlaybackSource(
  probe: string, path: string, quality: VideoQuality | 'remux', encoding: PlaybackEncodingPreferences, audioIndex?: number
): Promise<SegmentSource> {
  const file = await stat(path)
  if (!file.isFile()) throw new Error('Playback source is not a file')
  const key = JSON.stringify([path, file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs])
  let record = metadata.get(key)
  if (!record) record = { media: probeMedia(probe, path) }
  metadata.delete(key)
  metadata.set(key, record)
  if (metadata.size > retainedSources) metadata.delete(metadata.keys().next().value!)
  let media: LocalMedia
  try {
    media = await record.media
  } catch (error) {
    if (metadata.get(key) === record) metadata.delete(key)
    throw error
  }
  const video = media.tracks.find((track) => track.kind === 'video')!
  const audios = media.tracks.filter((track) => track.kind === 'audio')
  const audio = audioIndex === undefined
    ? audios.find((track) => track.default) ?? audios[0]
    : audios.find((track) => track.index === audioIndex)
  if (audioIndex !== undefined && !audio) throw new Error('Audio track does not exist')
  const audioTracks = !audio ? [] : audioIndex === undefined ? [audio, ...audios.filter((track) => track !== audio)] : [audio]

  let keyframes: number[] | undefined
  if (quality === 'remux') {
    if (media.container === 'matroska' || media.container === 'mkv' || media.container === 'webm') {
      record.cues ??= readMatroskaCueTimes(path)
    } else if (media.container && ['mov', 'mp4', 'm4v', '3gp', '3g2', 'mj2'].includes(media.container)) {
      record.cues ??= readMp4Keyframes(path)
    }
    if (!record.cues) throw new Error('This container has no supported remux seek index')
    keyframes = await record.cues
  }
  const fragmented = quality === 'remux' &&
    (!transportVideo.has(video.codec ?? '') || audioTracks.some((track) => !transportAudio.has(track.codec ?? '')))
  return { path, video, audioTracks, quality, fragmented, encoding, timeline: createTimeline(media.durationSeconds ?? 0, keyframes) }
}
