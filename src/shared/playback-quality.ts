export const VIDEO_QUALITIES = ['4k', '1440p', '1080p', '720p', '480p', '360p', '240p'] as const

export type VideoQuality = (typeof VIDEO_QUALITIES)[number]
export const videoQualityHeights: Readonly<Record<VideoQuality, number>> = {
  '4k': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360, '240p': 240
}
export const hlsMime = 'application/vnd.apple.mpegurl'

export type PlaybackQuality = 'original' | 'remux' | VideoQuality
export type PlaybackConversion = 'full' | 'remux' | 'off'
export type PlaybackWorkerStatus = 'unconfigured' | 'ready' | 'unreachable' | 'unready'
export type PlaybackVideoBackend = 'software' | 'vaapi' | 'vaapi-upload'

export const VIDEO_BITRATE_TARGETS = [0, 1, 2, 4, 8, 12, 20, 40, 80] as const

export interface PlaybackEncodingPreferences {
  hardwareAcceleration: 'auto' | 'software'
  videoQuality: 'balanced' | 'high'
  videoBitrateMbps: (typeof VIDEO_BITRATE_TARGETS)[number]
  audioChannels: 'auto' | 'stereo' | 'surround'
}

export function normalizePlaybackEncoding(value?: Partial<PlaybackEncodingPreferences>): PlaybackEncodingPreferences {
  return {
    hardwareAcceleration: value?.hardwareAcceleration === 'software' ? 'software' : 'auto',
    videoQuality: value?.videoQuality === 'high' ? 'high' : 'balanced',
    videoBitrateMbps: VIDEO_BITRATE_TARGETS.find((target) => target === value?.videoBitrateMbps) ?? 0,
    audioChannels: value?.audioChannels === 'stereo' || value?.audioChannels === 'surround' ? value.audioChannels : 'auto'
  }
}

export interface PlaybackWorkerHealth {
  status: PlaybackWorkerStatus
  detail: string
  videoBackend?: 'software' | 'vaapi'
  vaapiDevice?: string
  lastVideoBackend?: PlaybackVideoBackend
}

export const DEFAULT_VIDEO_QUALITIES: readonly VideoQuality[] = VIDEO_QUALITIES

export function isVideoQuality(value: unknown): value is VideoQuality {
  return typeof value === 'string' && VIDEO_QUALITIES.some((quality) => quality === value)
}

export function isPlaybackQuality(value: unknown): value is PlaybackQuality {
  return value === 'original' || value === 'remux' || isVideoQuality(value)
}

export function qualityLabel(quality: PlaybackQuality): string {
  if (quality === 'original') return 'Original'
  if (quality === 'remux') return 'Original (HLS remux)'
  return `Up to ${quality === '4k' ? '4K' : quality}`
}

export function availablePlaybackQualities(settings?: {
  playbackConversionAvailable?: boolean
  playbackConversion?: PlaybackConversion
  playbackQualities?: readonly VideoQuality[]
} | null): PlaybackQuality[] {
  const available: PlaybackQuality[] = ['original']
  if (settings?.playbackConversionAvailable && settings.playbackConversion !== 'off') {
    available.push('remux')
    if (settings.playbackConversion !== 'remux') {
      available.push(...(settings.playbackQualities ?? DEFAULT_VIDEO_QUALITIES))
    }
  }
  return available
}

export function canConvertPlaybackAudio(qualities: readonly PlaybackQuality[], conversion: PlaybackConversion | undefined): boolean {
  return qualities.includes('remux') && conversion !== 'remux'
}

export function isHdrTransfer(transfer?: string): boolean {
  return transfer === 'smpte2084' || transfer === 'arib-std-b67'
}

/** Output negotiated for one conversion. Omitted fields use compatibility encoding. */
export interface PlaybackOutput {
  sound?: 'copy' | 'stereo'
  videoCodec?: 'avc' | 'hevc' | 'vp9'
}

/** Software AVC profiles can retain source chroma sampling and up to ten bits. */
export function avcFormat(pixelFormat = '') {
  const tenBit = /(?:10|12|14|16)(?:le|be)$/.test(pixelFormat)
  const chroma = /444|gbr|rgb|bgr/.test(pixelFormat) ? '444' : /422|nv16|nv20/.test(pixelFormat) ? '422' : '420'
  const profile = chroma === '444' ? 'f400' : chroma === '422' ? '7a00' : tenBit ? '6e00' : '6400'
  return { pixelFormat: `yuv${chroma}p${tenBit ? '10le' : ''}`, profile, wideChroma: chroma !== '420', tenBit }
}
