import { getStreamUrl } from '@lib/api'
import { authStore } from '@lib/auth-store.svelte'
import { isMatroskaContainer, type LocalMediaTrack } from '@shared/local-media'
import { avcFormat, hlsMime, isHdrTransfer, isVideoQuality, videoQualityHeights, type PlaybackOutput, type VideoQuality } from '@shared/playback-quality'
import { playbackLanguagePattern, playbackLanguagePriorities } from '@shared/web-playback'
import type { PlaybackDefault, PlaybackDefaultScope, PlaybackDefaultsEditor, PlaybackLanguageDefaults, PlaybackPreferences, SubtitleMode, WebPlaybackInfo, WebPlaybackQuality, WebQualityChoice, WebQueueItem, WebSubtitle } from '@shared/web-playback'

const videoCodecs: Record<string, string> = {
  h264: 'avc1.640028', hevc: 'hvc1.1.6.L120.B0', av1: 'av01', vp9: 'vp9', vp8: 'vp8'
}
const audioCodecs: Record<string, string> = {
  aac: 'mp4a.40.2', mp3: 'mp3', opus: 'opus', vorbis: 'vorbis', ac3: 'ac-3', eac3: 'ec-3',
  flac: 'flac', alac: 'alac'
}
const avcProfiles: Record<string, string> = {
  Baseline: '4200', 'Constrained Baseline': '42e0', Main: '4d00', High: '6400',
  'High 10': '6e00', 'High 4:2:2': '7a00', 'High 4:4:4 Predictive': 'f400'
}

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

const languageCode = new RegExp(playbackLanguagePattern)

export function knownTrackLanguage(code?: string): string | undefined {
  const normalized = code?.trim().toLowerCase()
  return normalized && !['und', 'zxx', 'off'].includes(normalized) && languageCode.test(normalized)
    ? normalized : undefined
}

export function selectPlaybackAudio(
  tracks: LocalMediaTrack[], defaults: PlaybackDefault[], preferences: PlaybackPreferences
): LocalMediaTrack | undefined {
  for (const { audioLanguage } of [...defaults, preferences]) {
    for (const language of playbackLanguagePriorities(audioLanguage)) {
      const track = tracks.find((audio) => matchesLanguage(audio.language, language))
      if (track) return track
    }
  }
  return undefined
}

function matchingSubtitleTrack(tracks: WebSubtitle[]): WebSubtitle | undefined {
  return tracks.find((track) => track.default && !track.forced) ??
    tracks.find((track) => !track.forced && !track.hearingImpaired) ??
    tracks.find((track) => !track.forced)
}

export function selectPlaybackSubtitle(
  tracks: WebSubtitle[], defaults: PlaybackDefault[], preferences: PlaybackPreferences
): string {
  for (const { subtitleLanguage } of defaults) {
    if (subtitleLanguage === 'off') return ''
    for (const language of playbackLanguagePriorities(subtitleLanguage)) {
      const matches = tracks.filter((track) => matchesLanguage(track.language, language))
      const track = matchingSubtitleTrack(matches) ?? matches[0]
      if (track) return track.id
    }
  }
  const preferred = playbackLanguagePriorities(preferences.subtitleLanguage)
  if (preferences.subtitles === 'default') {
    for (const language of preferred) {
      const track = matchingSubtitleTrack(tracks.filter((track) => matchesLanguage(track.language, language)))
      if (track) return track.id
    }
  }
  return preferredSubtitle(tracks, preferred[0] ?? '', preferences.subtitles)
}

function preferredSubtitle(subtitles: WebSubtitle[], preferred: string, mode: SubtitleMode): string {
  if (mode === 'off') return ''
  const matching = subtitles.filter((track) => matchesLanguage(track.language, preferred))
  const forced = matching.find((track) => track.forced) ??
    subtitles.find((track) => track.forced && (!preferred || !track.language || track.language === 'und'))
  if (mode === 'forced') return forced?.id ?? ''
  return (matchingSubtitleTrack(matching) ?? forced ??
    subtitles.find((track) => track.default && !track.forced))?.id ?? ''
}

function codecsFor(track: LocalMediaTrack): string | undefined {
  if (!track.codec) return
  if (track.kind === 'audio') {
    if (track.codec === 'aac' && track.profile === 'HE-AAC') return 'mp4a.40.5'
    if (track.codec === 'aac' && track.profile === 'HE-AACv2') return 'mp4a.40.29'
    return audioCodecs[track.codec]
  }
  const depth = /(?:p|gray)(10|12)(?:le|be)?$/.exec(track.pixelFormat ?? '')?.[1] ?? '08'
  if (track.codec === 'vp9' && track.level && track.profile) {
    const profile = /Profile ([0-3])/.exec(track.profile)?.[1]
    if (profile) return `vp09.0${profile}.${String(track.level).padStart(2, '0')}.${depth}`
  }
  if (track.codec === 'av1' && track.level !== undefined && track.profile) {
    const profile = ['Main', 'High', 'Professional'].indexOf(track.profile)
    if (profile >= 0) return `av01.${profile}.${String(track.level).padStart(2, '0')}M.${depth}`
  }
  if (track.codec === 'h264') {
    const profile = avcProfiles[track.profile?.replace(/ Intra$/, '') ?? 'High'] ?? avcProfiles.High
    return `avc1.${profile}${(track.level ?? 40).toString(16).padStart(2, '0')}`
  }
  if (track.codec === 'hevc') {
    return `hvc1.${track.profile?.includes('10') ? '2.4' : '1.6'}.L${track.level ?? 120}.B0`
  }
  return videoCodecs[track.codec]
}

function supportsHlsCodec(player: HTMLVideoElement, mime: string) {
  const mse = window.MediaSource ?? (window as Window & { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource
  return !!(mse?.isTypeSupported(mime) || (player.canPlayType(hlsMime) && player.canPlayType(mime)))
}

interface PlaybackAttempt extends PlaybackOutput {
  mode: WebPlaybackQuality
  checkAudio?: boolean
}

export function playbackAttempts(
  player: HTMLVideoElement, info: WebPlaybackInfo, audio: LocalMediaTrack | undefined,
  defaultAudio: LocalMediaTrack | undefined, quality: WebQualityChoice
): PlaybackAttempt[] {
  const explicit = isVideoQuality(quality)
  const source = info.media
  const video = source?.tracks.find(track => track.kind === 'video')
  const audioCodec = audio && codecsFor(audio)
  const copyAudio = audioCodec && supportsHlsCodec(player, `audio/mp4; codecs="${audioCodec}"`)
  const attempts: PlaybackAttempt[] = []
  function withEncodedAudio(mode: WebPlaybackQuality, videoCodec?: PlaybackOutput['videoCodec']) {
    attempts.push({ mode, videoCodec })
    if ((audio?.channels ?? 0) > 2) attempts.push({ mode, videoCodec, sound: 'stereo' })
  }
  if (!explicit) {
    const audioTracks = source?.tracks.filter(track => track.kind === 'audio') ?? []
    // FFprobe groups WebM with Matroska. Native WebM playback can decode
    // Vorbis even when the browser's fragmented MP4 demuxer cannot.
    const audioMime = isMatroskaContainer(source?.container) && (audioCodec === 'vorbis' || audioCodec === 'opus')
      ? 'audio/webm' : 'audio/mp4'
    const nativeAudio = audioCodec && player.canPlayType(`${audioMime}; codecs="${audioCodec}"`)
    const mixedCodecs = audioTracks.some(track => codecsFor(track) !== audioCodec)
    const couldSubstituteAudio = audioTracks.length > 1 &&
      (audio?.index !== audioTracks[0].index || (mixedCodecs && !nativeAudio))
    if ('audioTracks' in player || (audio?.index === defaultAudio?.index && !couldSubstituteAudio)) {
      attempts.push({ mode: 'original', checkAudio: !!audio && !nativeAudio })
    }
    if (info.qualities.includes('remux')) {
      attempts.push({ mode: 'remux', checkAudio: !!audio && !copyAudio })
      const videoCodec = video && codecsFor(video)
      if (info.audioConversion && audio && videoCodec && supportsHlsCodec(player, `video/mp4; codecs="${videoCodec}"`)) {
        withEncodedAudio('audio')
      }
    }
  }
  let renditions: readonly VideoQuality[]
  if (explicit) {
    renditions = info.qualities.includes(quality) ? [quality] : []
  } else {
    const encode = info.qualities.filter(isVideoQuality).sort((a, b) => videoQualityHeights[b] - videoQualityHeights[a])
    const first = encode.findLastIndex(mode => videoQualityHeights[mode] >= (video?.height ?? Infinity))
    renditions = encode.slice(Math.max(0, first))
  }
  const hdrSource = isHdrTransfer(video?.colorTransfer)
  const format = avcFormat(video?.pixelFormat)
  const preserveRange = !hdrSource || window.matchMedia('(dynamic-range: high)').matches
  for (const mode of renditions) {
    const formats: PlaybackOutput['videoCodec'][] = []
    if (preserveRange && (hdrSource || format.tenBit || format.wideChroma)) {
      const uhd = Math.min(videoQualityHeights[mode], video?.height ?? Infinity) > 1080
      const avc = supportsHlsCodec(player, `video/mp4; codecs="avc1.${format.profile}${uhd ? '33' : '2a'}"`)
      if (format.wideChroma && avc) formats.push('avc')
      if (supportsHlsCodec(player, `video/mp4; codecs="hvc1.2.4.L${uhd ? 153 : 123}.B0"`)) formats.push('hevc')
      if (supportsHlsCodec(player, `video/mp4; codecs="vp09.02.${uhd ? 51 : 41}.10"`)) formats.push('vp9')
      if (!format.wideChroma && format.tenBit && avc) formats.push('avc')
    }
    formats.push(undefined)
    for (const videoCodec of formats) {
      if (copyAudio) attempts.push({ mode, videoCodec, sound: 'copy' })
      withEncodedAudio(mode, videoCodec)
    }
  }
  return attempts
}

let reflectionSupport: Promise<boolean> | undefined

/** Probe once, only for mirrored media. Some browsers honor rotation but discard reflection. */
export function supportsVideoReflection(sample: string): Promise<boolean> {
  return reflectionSupport ??= new Promise(resolve => {
    const video = document.createElement('video')
    const finish = (supported: boolean) => {
      clearTimeout(timer)
      video.onloadeddata = video.onerror = null
      video.removeAttribute('src')
      video.load()
      resolve(supported)
    }
    // An inconclusive probe leaves the viewer's original playback order intact.
    const timer = setTimeout(() => finish(true), 1200)
    video.onerror = () => finish(true)
    video.onloadeddata = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 2
      canvas.height = 1
      try {
        const context = canvas.getContext('2d')!
        context.drawImage(video, 0, 0, 2, 1)
        const pixels = context.getImageData(0, 0, 2, 1).data
        // The stored image is black on the left and white on the right.
        finish(!(pixels[0] < 32 && pixels[4] > 224))
      } catch { finish(true) }
    }
    video.muted = true
    video.preload = 'auto'
    video.src = sample
  })
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

export async function getPlaybackPreferences(): Promise<PlaybackPreferences> {
  const response = await fetch('/api/playback/preferences', { headers: { Authorization: `Bearer ${authStore.token}` } })
  if (!response.ok) throw new Error('Could not load playback preferences.')
  return response.json()
}

export async function savePlaybackPreferences(preferences: PlaybackPreferences): Promise<void> {
  const response = await fetch('/api/playback/preferences', {
    method: 'PUT', headers: { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(preferences)
  })
  if (!response.ok) throw new Error(response.status === 422
    ? 'Use language codes such as en or ja, separated by commas.' : 'Could not save playback preferences.')
}

export async function getItemPlaybackDefault(itemId: string, signal: AbortSignal): Promise<PlaybackDefaultsEditor> {
  const response = await fetch(`${playbackPath(itemId)}/defaults`, {
    signal, headers: { Authorization: `Bearer ${authStore.token}` }
  })
  if (!response.ok) throw new Error('Could not load playback defaults.')
  return response.json()
}

export async function saveItemPlaybackDefault(
  itemId: string, changes: Partial<PlaybackLanguageDefaults>, scope?: PlaybackDefaultScope
): Promise<void> {
  const response = await fetch(`${playbackPath(itemId)}/defaults`, {
    method: 'PUT', headers: { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...changes, scope })
  })
  if (!response.ok) throw new Error('Could not save playback defaults.')
}

export async function getWebPlaybackQueue(itemId: string, signal: AbortSignal): Promise<WebQueueItem[]> {
  const response = await fetch(`${playbackPath(itemId)}/queue`, {
    signal, headers: { Authorization: `Bearer ${authStore.token}` }
  })
  if (!response.ok) throw new Error('Could not load the playback queue.')
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

export function browserPlaybackUrl(itemId: string, filename: string, quality: WebPlaybackQuality, audio?: number, output?: PlaybackOutput): string {
  if (quality === 'original') return getStreamUrl(itemId, filename)
  const url = new URL(`/api/hls/${encodeURIComponent(itemId)}/${quality}/master.m3u8`, window.location.origin)
  url.searchParams.set('web', '1')
  if (authStore.token) url.searchParams.set('token', authStore.token)
  if (audio !== undefined) url.searchParams.set('audio', String(audio))
  if (output?.videoCodec) url.searchParams.set('videoCodec', output.videoCodec)
  if (output?.sound) url.searchParams.set('sound', output.sound)
  return url.href
}

export function subtitleUrl(itemId: string, subtitleId: string, part = 'track', revision?: string): string {
  const query = new URLSearchParams()
  if (revision) query.set('v', revision)
  if (authStore.token) query.set('token', authStore.token)
  return `${playbackPath(itemId)}/subtitle/${encodeURIComponent(subtitleId)}/${part}?${query}`
}
