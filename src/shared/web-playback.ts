import type { MediaFile } from './types'
import type { LocalMedia } from './local-media'
import type { PlaybackQuality } from './playback-quality'

export type WebPlaybackQuality = PlaybackQuality | 'audio'
export const webQualityChoices = ['source', 'auto'] as const
export type WebQualityChoice = typeof webQualityChoices[number]

export function webQualityLabel(quality: WebQualityChoice): string {
  return quality === 'auto' ? 'Automatic quality' : 'Prefer original'
}

export type SubtitleFormat = 'text' | 'ass' | 'pgs' | 'vobsub'
export const embeddedSubtitleFormats: Readonly<Record<string, SubtitleFormat>> = {
  ass: 'ass', ssa: 'ass', subrip: 'text', webvtt: 'text', mov_text: 'text', text: 'text',
  hdmv_pgs_subtitle: 'pgs', dvd_subtitle: 'vobsub'
}

export const SUBTITLE_WINDOW_SECONDS = 30
export const SUBTITLE_WINDOW_HEADER = 'X-Kinome-Subtitle-Window'

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
  fontRevision?: string
  subtitles: WebSubtitle[]
  qualities: PlaybackQuality[]
  audioConversion: boolean
  position: number
}

export function isFontAttachment(filename?: string, mime?: string): boolean {
  return /\.(?:ttf|otf|ttc|otc)$/i.test(filename ?? '') ||
    /^(?:font\/|application\/(?:x-truetype-font|x-font-(?:ttf|otf|opentype|truetype)|vnd.ms-opentype))/i.test(mime ?? '')
}
