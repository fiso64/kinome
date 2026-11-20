import path from 'node:path'
import type { LocalMedia, LocalMediaTrack } from '@shared/local-media'

interface ProbeStream {
  index: number
  codec_type: string
  codec_name?: string
  profile?: string
  pix_fmt?: string
  avg_frame_rate?: string
  bit_rate?: string
  width?: number
  height?: number
  channels?: number
  channel_layout?: string
  sample_rate?: string
  tags?: Record<string, string>
  disposition?: { attached_pic?: number; default?: number; forced?: number; hearing_impaired?: number }
}

interface ProbeResult {
  streams?: ProbeStream[]
  format?: { format_name?: string; duration?: string; bit_rate?: string; tags?: Record<string, string> }
}

function positiveNumber(value: string | number | undefined): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function tag(tags: Record<string, string> | undefined, key: string): string | undefined {
  if (!tags) return
  return tags[key] ?? Object.entries(tags).find(([name]) => name.toLowerCase() === key)?.[1]
}

export async function probeMedia(executable: string, filePath: string): Promise<LocalMedia> {
  const process = Bun.spawn([
    executable, '-v', 'error', '-protocol_whitelist', 'file',
    '-show_entries', [
      'format=format_name,duration,bit_rate', 'format_tags=encoder',
      'stream=index,codec_type,codec_name,profile,pix_fmt,avg_frame_rate,bit_rate,width,height,channels,channel_layout,sample_rate',
      'stream_tags=language,title,encoder', 'stream_disposition=attached_pic,default,forced,hearing_impaired'
    ].join(':'),
    '-of', 'json', '-i', filePath
  ], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(30_000) })
  const [code, json, errors] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()
  ])
  if (code !== 0 || errors.trim()) throw new Error(errors.trim().slice(0, 512) || `ffprobe exited with status ${code}`)

  const { format, streams } = JSON.parse(json) as ProbeResult
  const tracks: LocalMediaTrack[] = []
  for (const stream of streams ?? []) {
    const kind = stream.codec_type
    if ((kind !== 'video' && kind !== 'audio' && kind !== 'subtitle') || stream.disposition?.attached_pic) continue
    tracks.push({
      index: stream.index, kind, codec: stream.codec_name, profile: stream.profile,
      language: tag(stream.tags, 'language')?.trim().toLowerCase() || undefined,
      title: tag(stream.tags, 'title'), encoder: tag(stream.tags, 'encoder'), pixelFormat: stream.pix_fmt,
      frameRate: stream.avg_frame_rate === '0/0' ? undefined : stream.avg_frame_rate,
      bitrate: positiveNumber(stream.bit_rate),
      width: positiveNumber(stream.width), height: positiveNumber(stream.height),
      channels: positiveNumber(stream.channels), channelLayout: stream.channel_layout,
      sampleRate: positiveNumber(stream.sample_rate),
      default: Boolean(stream.disposition?.default),
      forced: Boolean(stream.disposition?.forced),
      hearingImpaired: Boolean(stream.disposition?.hearing_impaired)
    })
  }
  if (!tracks.some((track) => track.kind === 'video' && track.codec && track.width && track.height)) {
    throw new Error('ffprobe did not find a usable video stream')
  }

  const formats = format?.format_name?.split(',') ?? []
  const extension = path.extname(filePath).slice(1).toLowerCase()
  return {
    container: formats.includes(extension) ? extension : formats[0],
    durationSeconds: positiveNumber(format?.duration),
    bitrate: positiveNumber(format?.bit_rate),
    encoder: tracks.find((track) => track.kind === 'video')?.encoder ?? tag(format?.tags, 'encoder'),
    tracks
  }
}
