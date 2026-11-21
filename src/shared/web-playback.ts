import type { MediaFile } from './types'
import type { LocalMedia } from './local-media'
import { qualityLabel, type PlaybackQuality } from './playback-quality'

export type WebPlaybackQuality = PlaybackQuality | 'audio'
export type WebQualityChoice = 'auto' | WebPlaybackQuality
export function webQualityLabel(quality: WebQualityChoice): string {
  if (quality === 'auto') return 'Automatic compatibility'
  if (quality === 'original') return 'Force direct play'
  if (quality === 'remux') return 'Original video (HLS remux)'
  if (quality === 'audio') return 'Original video (convert audio)'
  return qualityLabel(quality)
}

export type SubtitleFormat = 'text' | 'ass' | 'pgs' | 'vobsub'
export const ASS_WINDOW_SECONDS = 30
export const ASS_WINDOW_HEADER = 'X-Kinome-Subtitle-Window'

export interface WebSubtitle {
  id: string
  format: SubtitleFormat
  title?: string
  language?: string
  default?: boolean
  forced?: boolean
  hearingImpaired?: boolean
  sidecar?: boolean
}

export type WebQueueItem = Pick<MediaFile, 'id' | 'type' | 'name' | 'title' | 'seasonNumber' | 'episodeNumber'>

export interface WebPlaybackInfo {
  media: LocalMedia | null
  subtitles: WebSubtitle[]
  qualities: PlaybackQuality[]
  audioConversion: boolean
  position: number
}

export function isFontAttachment(filename?: string, mime?: string): boolean {
  return /\.(?:ttf|otf|ttc|otc)$/i.test(filename ?? '') ||
    /^(?:font\/|application\/(?:x-truetype-font|x-font-(?:ttf|otf|opentype|truetype)|vnd.ms-opentype))/i.test(mime ?? '')
}
