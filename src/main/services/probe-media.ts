import path from 'node:path'
import { matroskaWriter } from './transcoding/matroska-cues'
import { isFontAttachment } from '@shared/web-playback'
import type { LocalMedia, LocalMediaTrack, MediaChapter } from '@shared/local-media'

interface ProbeStream {
  index: number
  codec_type: string
  codec_name?: string
  profile?: string
  level?: number
  pix_fmt?: string
  color_transfer?: string
  field_order?: string
  avg_frame_rate?: string
  bit_rate?: string
  duration?: string
  start_time?: string
  width?: number
  height?: number
  channels?: number
  channel_layout?: string
  sample_rate?: string
  tags?: Record<string, string>
  disposition?: { attached_pic?: number; default?: number; forced?: number; hearing_impaired?: number }
}

interface ProbeChapter {
  start_time?: string
  end_time?: string
  tags?: Record<string, string>
}

interface ProbeResult {
  chapters?: ProbeChapter[]
  streams?: ProbeStream[]
  format?: { format_name?: string; start_time?: string; duration?: string; bit_rate?: string; tags?: Record<string, string> }
}

function positiveNumber(value: string | number | undefined): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function clockSeconds(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/)
  return match ? positiveNumber(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) : undefined
}

function tag(tags: Record<string, string> | undefined, key: string): string | undefined {
  if (!tags) return
  return tags[key] ?? Object.entries(tags).find(([name]) => name.toLowerCase() === key)?.[1]
}

function parseChapters(chapters: ProbeChapter[], duration?: number): MediaChapter[] {
  const result = new Map<number, MediaChapter>()
  for (const chapter of chapters) {
    const startSeconds = Number(chapter.start_time?.trim() || NaN)
    if (!Number.isFinite(startSeconds) || startSeconds < 0 ||
      (duration !== undefined && startSeconds >= duration) || result.has(startSeconds)) continue

    const end = Number(chapter.end_time?.trim() || NaN)
    const endSeconds = Number.isFinite(end) && end > startSeconds ? Math.min(end, duration ?? end) : undefined
    const title = tag(chapter.tags, 'title')?.trim() || undefined
    result.set(startSeconds, { startSeconds, endSeconds, title })
  }
  return [...result.values()].sort((a, b) => a.startSeconds - b.startSeconds)
}

export async function probeMedia(executable: string, filePath: string): Promise<LocalMedia> {
  const process = Bun.spawn([
    executable, '-v', 'error', '-protocol_whitelist', 'file',
    '-show_entries', [
      'format=format_name,start_time,duration,bit_rate', 'format_tags=encoder',
      'chapter=start_time,end_time', 'chapter_tags=title',
      'stream=index,codec_type,codec_name,profile,level,pix_fmt,color_transfer,field_order,avg_frame_rate,bit_rate,width,height,channels,channel_layout,sample_rate,start_time,duration',
      'stream_tags=language,title,encoder,filename,mimetype,DURATION,NUMBER_OF_FRAMES,NUMBER_OF_FRAMES-eng', 'stream_disposition=attached_pic,default,forced,hearing_impaired'
    ].join(':'),
    '-of', 'json', '-i', filePath
  ], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(30_000) })
  const [code, json, errors] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()
  ])
  // A recording can begin between keyframes. ffprobe reports decoder errors
  // for those opening packets even after it identifies the playable streams.
  if (code !== 0) throw new Error(errors.trim().slice(0, 512) || `ffprobe exited with status ${code}`)

  const { format, streams, chapters = [] } = JSON.parse(json) as ProbeResult
  const tracks: LocalMediaTrack[] = []
  const startSeconds = Number(format?.start_time) || 0
  const formats = format?.format_name?.split(',') ?? []
  // The ENCODER tag can survive a remux. Only the segment's WritingApp
  // identifies how this file's track durations were stored.
  const hasOffsets = startSeconds !== 0 || streams?.some((stream) =>
    (stream.codec_type === 'audio' || stream.codec_type === 'video') && Number(stream.start_time))
  const writer = formats.includes('matroska') && hasOffsets ? await matroskaWriter(filePath).catch(() => undefined) : undefined
  const absoluteEndTags = writer?.startsWith('Lavf')
  const elapsedTags = writer?.startsWith('mkvmerge')
  let avDuration = 0
  for (const stream of streams ?? []) {
    const kind = stream.codec_type
    if ((kind !== 'video' && kind !== 'audio' && kind !== 'subtitle') || stream.disposition?.attached_pic) continue
    const duration = positiveNumber(stream.duration)
    const trackStart = (Number(stream.start_time) || 0) - startSeconds
    const tagged = clockSeconds(tag(stream.tags, 'duration'))
    // FFmpeg writes absolute end timestamps into Matroska DURATION tags.
    // mkvmerge writes elapsed track durations, including on delayed tracks.
    let endSeconds = tagged
    if (duration !== undefined) endSeconds = trackStart + duration
    else if (tagged !== undefined && absoluteEndTags) endSeconds = tagged - startSeconds
    else if (tagged !== undefined && elapsedTags) endSeconds = trackStart + tagged
    if (kind !== 'subtitle') avDuration = Math.max(avDuration, endSeconds ?? 0)
    tracks.push({
      index: stream.index, kind, startSeconds: Math.max(0, trackStart), endSeconds,
      codec: stream.codec_name, profile: stream.profile, level: stream.level !== undefined && stream.level >= 0 ? stream.level : undefined,
      language: tag(stream.tags, 'language')?.trim().toLowerCase() || undefined,
      title: tag(stream.tags, 'title'), encoder: tag(stream.tags, 'encoder'), pixelFormat: stream.pix_fmt,
      colorTransfer: stream.color_transfer, fieldOrder: stream.field_order,
      frameRate: stream.avg_frame_rate === '0/0' ? undefined : stream.avg_frame_rate,
      bitrate: positiveNumber(stream.bit_rate),
      width: positiveNumber(stream.width), height: positiveNumber(stream.height),
      channels: positiveNumber(stream.channels), channelLayout: stream.channel_layout,
      packetCount: kind === 'subtitle' ? positiveNumber(tag(stream.tags, 'NUMBER_OF_FRAMES') ?? tag(stream.tags, 'NUMBER_OF_FRAMES-eng')) : undefined,
      sampleRate: positiveNumber(stream.sample_rate),
      default: Boolean(stream.disposition?.default),
      forced: Boolean(stream.disposition?.forced),
      hearingImpaired: Boolean(stream.disposition?.hearing_impaired)
    })
  }
  if (!tracks.some((track) => track.kind === 'video' && track.codec && track.width && track.height)) {
    throw new Error('ffprobe did not find a usable video stream')
  }

  const rawDuration = positiveNumber(format?.duration)
  const containerDuration = rawDuration && absoluteEndTags ? positiveNumber(rawDuration - startSeconds) : rawDuration
  // A broken subtitle end timestamp can extend the container by days. Use
  // the playable streams to measure the duration when they disagree.
  const duration = avDuration && (!containerDuration || containerDuration > avDuration + 2)
    ? avDuration : containerDuration
  const extension = path.extname(filePath).slice(1).toLowerCase()
  return {
    startSeconds,
    container: formats.includes(extension) ? extension : formats[0],
    durationSeconds: duration,
    bitrate: positiveNumber(format?.bit_rate),
    encoder: tracks.find((track) => track.kind === 'video')?.encoder ?? tag(format?.tags, 'encoder'),
    tracks,
    chapters: parseChapters(chapters, duration),
    fonts: streams?.filter((stream) => stream.codec_type === 'attachment' &&
      isFontAttachment(tag(stream.tags, 'filename'), tag(stream.tags, 'mimetype'))).map((stream) => stream.index)
  }
}
