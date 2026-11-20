export interface LocalMediaTrack {
  index: number
  kind: 'video' | 'audio' | 'subtitle'
  codec?: string
  profile?: string
  encoder?: string
  pixelFormat?: string
  frameRate?: string
  bitrate?: number
  language?: string
  title?: string
  width?: number
  height?: number
  channels?: number
  channelLayout?: string
  sampleRate?: number
  default: boolean
  forced: boolean
  hearingImpaired: boolean
}

export interface LocalMedia {
  container?: string
  durationSeconds?: number
  bitrate?: number
  encoder?: string
  tracks: LocalMediaTrack[]
}
