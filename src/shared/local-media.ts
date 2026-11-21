export interface LocalMediaTrack {
  index: number
  kind: 'video' | 'audio' | 'subtitle'
  codec?: string
  profile?: string
  encoder?: string
  pixelFormat?: string
  colorTransfer?: string
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

export interface MediaChapter {
  startSeconds: number
  endSeconds?: number
  title?: string
}

export interface LocalMedia {
  container?: string
  durationSeconds?: number
  bitrate?: number
  encoder?: string
  tracks: LocalMediaTrack[]
  fonts?: number[]
  chapters?: MediaChapter[]
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
  '.mpeg'
]

export function isSupportedVideoFile(fileName: string): boolean {
  const ext = fileName.toLowerCase().slice(Math.max(0, fileName.lastIndexOf('.')) || Infinity)
  return VIDEO_EXTENSIONS.includes(ext)
}
