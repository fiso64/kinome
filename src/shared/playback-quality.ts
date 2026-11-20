export const VIDEO_QUALITIES = ['4k', '1440p', '1080p', '720p', '480p', '360p', '240p'] as const

export type VideoQuality = (typeof VIDEO_QUALITIES)[number]
export type PlaybackQuality = 'original' | 'remux' | VideoQuality
export type PlaybackConversion = 'full' | 'remux' | 'off'
export type PlaybackWorkerStatus = 'unconfigured' | 'ready' | 'unreachable' | 'unready'
export type PlaybackVideoBackend = 'software' | 'vaapi' | 'vaapi-upload'

export const VIDEO_BITRATE_TARGETS = [0, 1, 2, 4, 8, 12, 20, 40, 80] as const

export interface PlaybackEncodingPreferences {
  hardwareAcceleration: 'auto' | 'software'
  videoQuality: 'balanced' | 'high'
  videoBitrateMbps: (typeof VIDEO_BITRATE_TARGETS)[number]
  audioChannels: 'stereo' | 'surround'
}

export function normalizePlaybackEncoding(value?: Partial<PlaybackEncodingPreferences>): PlaybackEncodingPreferences {
  return {
    hardwareAcceleration: value?.hardwareAcceleration === 'software' ? 'software' : 'auto',
    videoQuality: value?.videoQuality === 'high' ? 'high' : 'balanced',
    videoBitrateMbps: VIDEO_BITRATE_TARGETS.find((target) => target === value?.videoBitrateMbps) ?? 0,
    audioChannels: value?.audioChannels === 'surround' ? 'surround' : 'stereo'
  }
}

export interface PlaybackWorkerHealth {
  status: PlaybackWorkerStatus
  detail: string
  videoBackend?: 'software' | 'vaapi'
  vaapiDevice?: string
  lastVideoBackend?: PlaybackVideoBackend
}

export const DEFAULT_VIDEO_QUALITIES: readonly VideoQuality[] = ['1080p', '720p', '480p']

export function isVideoQuality(value: unknown): value is VideoQuality {
  return typeof value === 'string' && VIDEO_QUALITIES.some((quality) => quality === value)
}

export function isPlaybackQuality(value: unknown): value is PlaybackQuality {
  return value === 'original' || value === 'remux' || isVideoQuality(value)
}

export function qualityLabel(quality: PlaybackQuality): string {
  if (quality === 'original') return 'Original'
  if (quality === 'remux') return 'Original · HLS remux'
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
