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

export const playbackDefaultScopes = ['file', 'season', 'show', 'movie'] as const
export type PlaybackDefaultScope = typeof playbackDefaultScopes[number]

export interface PlaybackLanguageDefaults {
  audioLanguage: string | null
  subtitleLanguage: string | null
}

export interface PlaybackDefaultsEditor {
  defaults: PlaybackLanguageDefaults | null
  languages: { audio: string[]; subtitles: string[] } | null
}

export interface PlaybackDefault extends PlaybackLanguageDefaults {
  scope: PlaybackDefaultScope
}

const playbackLanguageCode = '[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,4}'
export const playbackLanguagePattern = `^${playbackLanguageCode}$`
// Off is a subtitle mode. It cannot be mixed into a language list.
const preferredLanguageCode = `(?![oO][fF][fF](?=[\\s,]|$))${playbackLanguageCode}`
const playbackLanguageListPattern = new RegExp(`^\\s*${preferredLanguageCode}(?:\\s*,\\s*${preferredLanguageCode})*\\s*$`)

export function isPlaybackLanguageList(value: string): boolean {
  return playbackLanguageListPattern.test(value)
}

export function playbackLanguagePriorities(value: string | null): string[] {
  return value?.split(',').map((language) => language.trim().toLowerCase()) ?? []
}

export function normalizePlaybackLanguages(value: string): string {
  return playbackLanguagePriorities(value).join(', ')
}

export interface WebPlaybackInfo {
  media: LocalMedia | null
  fontRevision?: string
  subtitles: WebSubtitle[]
  qualities: PlaybackQuality[]
  audioConversion: boolean
  position: number
  languageDefaults: PlaybackDefault[]
}

export function isFontAttachment(filename?: string, mime?: string): boolean {
  return /\.(?:ttf|otf|ttc|otc)$/i.test(filename ?? '') ||
    /^(?:font\/|application\/(?:x-truetype-font|x-font-(?:ttf|otf|opentype|truetype)|vnd.ms-opentype))/i.test(mime ?? '')
}
