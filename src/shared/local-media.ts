export interface LocalMediaTrack {
  index: number
  kind: 'video' | 'audio' | 'subtitle'
  codec?: string
  profile?: string
  level?: number
  encoder?: string
  pixelFormat?: string
  colorTransfer?: string
  fieldOrder?: string
  frameRate?: string
  bitrate?: number
  language?: string
  title?: string
  width?: number
  height?: number
  channels?: number
  channelLayout?: string
  startSeconds?: number
  endSeconds?: number
  packetCount?: number
  sampleRate?: number
  default: boolean
  forced: boolean
  hearingImpaired: boolean
}

export interface MediaChapter {
  startSeconds: number
  endSeconds?: number
  title?: string
}

export interface LocalMedia {
  startSeconds?: number
  container?: string
  durationSeconds?: number
  bitrate?: number
  encoder?: string
  tracks: LocalMediaTrack[]
  fonts?: number[]
  chapters?: MediaChapter[]
}

export function isMp4Container(container?: string): boolean {
  return !!container && ['mov', 'mp4', 'm4v', '3gp', '3g2', 'mj2'].includes(container)
}

export const VIDEO_EXTENSIONS = [
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  '.mpg',
  '.mpeg',
  '.m2ts'
]

export function isSupportedVideoFile(fileName: string): boolean {
  const ext = fileName.toLowerCase().slice(Math.max(0, fileName.lastIndexOf('.')) || Infinity)
  return VIDEO_EXTENSIONS.includes(ext)
}
