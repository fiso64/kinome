import { getStreamUrl } from '@lib/api'
import { authStore } from '@lib/auth-store.svelte'
import type { LocalMediaTrack } from '@shared/local-media'
import { isVideoQuality } from '@shared/playback-quality'
import type { WebPlaybackInfo, WebPlaybackQuality, WebSubtitle } from '@shared/web-playback'

export const hlsMime = 'application/vnd.apple.mpegurl'

const directTypes: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  mkv: 'video/x-matroska', matroska: 'video/x-matroska', webm: 'video/webm'
}
const videoCodecs: Record<string, string> = {
  h264: 'avc1.640028', hevc: 'hvc1.1.6.L120.B0', av1: 'av01.0.08M.08', vp9: 'vp09.00.41.08', vp8: 'vp8'
}
const audioCodecs: Record<string, string> = {
  aac: 'mp4a.40.2', mp3: 'mp3', opus: 'opus', vorbis: 'vorbis', ac3: 'ac-3', eac3: 'ec-3',
  flac: 'flac', alac: 'alac'
}
const heights = { '4k': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360, '240p': 240 }

const displayNames = new Intl.DisplayNames(undefined, { type: 'language' })

export function languageName(code?: string): string {
  if (!code || code === 'und') return 'Unknown language'
  try {
    return displayNames.of(code) ?? code
  } catch {
    return code
  }
}

export function matchesLanguage(code: string | undefined, preferred: string): boolean {
  if (!code || !preferred) return false
  const language = (value: string) => languageName(value.toLowerCase().split('-')[0])
  return language(code) === language(preferred)
}

export function preferredSubtitle(
  subtitles: WebSubtitle[], preferred: string, mode: 'default' | 'forced' | 'off'
): string {
  if (mode === 'off') return ''
  const matching = subtitles.filter((track) => matchesLanguage(track.language, preferred))
  const forced = matching.find((track) => track.forced) ??
    subtitles.find((track) => track.forced && (!preferred || !track.language || track.language === 'und'))
  if (mode === 'forced') return forced?.id ?? ''
  return (matching.find((track) => track.default && !track.forced) ??
    matching.find((track) => !track.forced && !track.hearingImpaired) ??
    matching.find((track) => !track.forced) ?? forced ??
    subtitles.find((track) => track.default && !track.forced))?.id ?? ''
}

function codecsFor(track: LocalMediaTrack): string | undefined {
  if (!track.codec) return
  if (track.kind === 'audio') return audioCodecs[track.codec]
  if (track.codec === 'h264' && track.profile?.includes('10')) return 'avc1.6e0028'
  if (track.codec === 'hevc' && track.profile?.includes('10')) return 'hvc1.2.4.L120.B0'
  return videoCodecs[track.codec]
}

export async function automaticQualities(
  player: HTMLVideoElement, info: WebPlaybackInfo, audio: LocalMediaTrack | undefined,
  defaultAudio: LocalMediaTrack | undefined
): Promise<WebPlaybackQuality[]> {
  const source = info.media
  const video = source?.tracks.find((track) => track.kind === 'video')
  const initial: WebPlaybackQuality[] = []
  if (video && source) {
    const videoCodec = codecsFor(video)
    const audioCodec = audio && codecsFor(audio)
    const container = source.container ? directTypes[source.container] : undefined
    const videoType = (mime: string) => `${mime}; codecs="${videoCodec}"`
    const supports = (mime: string) => Boolean(player.canPlayType(mime))
    const directType = container && `${container}; codecs="${[videoCodec, audioCodec].filter(Boolean).join(',')}"`
    if (directType && videoCodec && (!audio || audioCodec) && audio?.index === defaultAudio?.index && supports(directType)) {
      const frameRate = video.frameRate?.split('/').map(Number)
      const fps = frameRate?.length === 2 ? frameRate[0] / frameRate[1] : 0
      const capability = video.width && video.height && fps > 0 && video.bitrate && typeof navigator.mediaCapabilities?.decodingInfo === 'function'
        ? await navigator.mediaCapabilities.decodingInfo({ type: 'file', video: {
          contentType: videoType(container), width: video.width, height: video.height,
          bitrate: video.bitrate, framerate: fps
        } }).catch(() => undefined)
        : undefined
      if (capability?.supported !== false && capability?.smooth !== false) initial.push('original')
    }
    const mediaSource = window.MediaSource ?? (window as Window & { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource
    const mp4Support = (codec: string) =>
      Boolean(mediaSource?.isTypeSupported(codec) || (supports(hlsMime) && supports(codec)))
    const indexed = source.container && Object.hasOwn(directTypes, source.container)
    if (info.qualities.includes('remux') && indexed && videoCodec && mp4Support(videoType('video/mp4'))) {
      if (!audio || (audioCodec && mp4Support(`audio/mp4; codecs="${audioCodec}"`))) initial.push('remux')
      if (audio && info.audioConversion) initial.push('audio')
    }
  } else {
    initial.push('original')
  }

  const encode = info.qualities.filter(isVideoQuality).sort((a, b) => heights[b] - heights[a])
  const sourceHeight = video?.height
  const convert = sourceHeight
    ? encode.slice(Math.max(0, encode.findLastIndex((quality) => heights[quality] >= sourceHeight)))
    : encode
  // Only the first viable source is loaded. Lower qualities remain available if decoding fails.
  const directFallback = audio?.index === defaultAudio?.index ? ['original' as const] : []
  return [...new Set<WebPlaybackQuality>([...initial, ...convert, ...directFallback])]
}

function playbackPath(itemId: string): string {
  return `/api/playback/${encodeURIComponent(itemId)}`
}

export async function getWebPlaybackInfo(itemId: string, signal: AbortSignal): Promise<WebPlaybackInfo> {
  const response = await fetch(`${playbackPath(itemId)}/info`, {
    signal, headers: { Authorization: `Bearer ${authStore.token}` }
  })
  if (!response.ok) throw new Error(response.status === 404
    ? 'This file is no longer available.' : 'Could not load playback information.')
  return response.json()
}

export async function storePlaybackPosition(itemId: string, token: string, position: number, completed: boolean): Promise<void> {
  const response = await fetch(`${playbackPath(itemId)}/progress`, {
    method: 'POST', keepalive: true,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ position, completed })
  })
  if (!response.ok) throw new Error('Could not save playback position.')
}

export function browserPlaybackUrl(itemId: string, filename: string, quality: WebPlaybackQuality, audio?: number): string {
  if (quality === 'original') return getStreamUrl(itemId, filename)
  const url = new URL(`/api/hls/${encodeURIComponent(itemId)}/${quality}/master.m3u8`, window.location.origin)
  url.searchParams.set('web', '1')
  if (authStore.token) url.searchParams.set('token', authStore.token)
  if (audio !== undefined) url.searchParams.set('audio', String(audio))
  return url.href
}

export function subtitleUrl(itemId: string, subtitleId: string, part = 'track'): string {
  const query = new URLSearchParams()
  if (authStore.token) query.set('token', authStore.token)
  return `${playbackPath(itemId)}/subtitle/${encodeURIComponent(subtitleId)}/${part}?${query}`
}
