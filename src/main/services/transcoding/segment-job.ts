import { join } from 'node:path'
import type { LocalMediaTrack } from '@shared/local-media'
import type { PlaybackEncodingPreferences, PlaybackVideoBackend, VideoQuality } from '@shared/playback-quality'
import { endOfSegment, transcodeSegmentSeconds, type PlaybackTimeline } from './timeline'

const heights: Record<VideoQuality, number> = {
  '4k': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360, '240p': 240
}

export type SegmentQuality = VideoQuality | 'remux' | 'audio'

export function copiesVideo(quality: SegmentQuality): quality is 'remux' | 'audio' {
  return quality === 'remux' || quality === 'audio'
}

export interface SegmentSource {
  path: string
  video: LocalMediaTrack
  audioTracks: readonly LocalMediaTrack[]
  quality: SegmentQuality
  fragmented: boolean
  encoding: PlaybackEncodingPreferences
  timeline: PlaybackTimeline
  vaapiDevice?: string
}


const segmentName = /^segment-(\d+)\.(?:ts|mp4),/
// Reserve timestamp space for reordered video and audio preroll at the start
// of a file. Negative MPEG-TS timestamps wrap to the end of the 33-bit clock.
const transportStreamPreroll = 1.4

export function lastSegmentInJob(source: SegmentSource, first: number): number {
  const segmentCount = copiesVideo(source.quality) ? 4 : 12 / transcodeSegmentSeconds
  return Math.min(source.timeline.starts.length - 1, first + segmentCount - 1)
}

export function startSegmentJob(
  executable: string, directory: string, source: SegmentSource, first: number,
  mode: PlaybackVideoBackend,
  onSegment: (index: number, path: string) => void | Promise<void>
) {
  const { quality, timeline, path, video, audioTracks, fragmented, encoding } = source
  const last = lastSegmentInJob(source, first)
  const start = timeline.starts[first]
  const end = endOfSegment(timeline, last)
  const interior = timeline.starts.slice(first + 1, last + 1).map((time) => (time - start).toFixed(6))
  const remux = copiesVideo(quality)
  const hardware = !remux && mode !== 'software' ? source.vaapiDevice : undefined
  // TrueHD needs a Blu-ray stream type and an AC-3 compatibility stream.
  const mpegtsFormat = [
    'mpegts_copyts=1', 'mpegts_flags=initial_discontinuity',
    ...(remux ? ['avoid_negative_ts=disabled'] : []),
    ...(quality === 'remux' && audioTracks.some((track) => track.codec === 'truehd') ? ['mpegts_m2ts_mode=1'] : [])
  ].join(':')
  // frag_discont keeps the source's decode times in tfdt across independently
  // opened MP4 muxers. default_base_moof makes media readable without its moov.
  const mp4Format = 'movflags=+frag_keyframe+delay_moov+default_base_moof+skip_trailer+frag_discont:use_editlist=0:strict=experimental:avoid_negative_ts=disabled'
  const extension = fragmented ? 'mp4' : 'ts'
  const args = [
    executable, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...(remux ? ['-copyts', '-start_at_zero'] : []),
    ...(hardware ? ['-vaapi_device', hardware] : []),
    ...(mode === 'vaapi' ? ['-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi'] : []),
    '-ss', (timeline.seekStarts?.[first] ?? start).toFixed(6),
    '-threads', '2', '-protocol_whitelist', 'file', '-i', path,
    '-map', `0:${video.index}`, ...audioTracks.flatMap((track) => ['-map', `0:${track.index}`]),
    '-map_metadata', '-1', '-map_chapters', '-1'
  ]
  for (const [index, track] of audioTracks.entries()) {
    if (track.language) args.push(`-metadata:s:a:${index}`, `language=${track.language}`)
    args.push(`-disposition:a:${index}`, index === 0 ? 'default' : '0')
  }
  if (remux) {
    args.push('-c:v', 'copy', '-avoid_negative_ts', 'disabled')
    if (fragmented && video.codec === 'hevc') args.push('-tag:v', 'hvc1')
    if (end < timeline.duration) interior.push((end - start).toFixed(6))
  } else {
    const height = Math.floor(Math.min(video.height!, heights[quality]) / 2) * 2
    const width = Math.round(height * video.width! / video.height! / 2) * 2
    const hdr = video.colorTransfer === 'smpte2084' || video.colorTransfer === 'arib-std-b67'
    const filters = hardware
      ? [
          ...(mode === 'vaapi-upload' ? [hdr ? 'format=p010le' : 'format=nv12', 'hwupload'] : []),
          `scale_vaapi=w=${width}:h=${height}:format=${hdr ? 'p010' : 'nv12'}`,
          ...(hdr ? ['tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709'] : [])
        ]
      : [
          `scale=${width}:${height}`,
          ...(hdr ? ['zscale=t=linear:npl=100', 'format=gbrpf32le', 'tonemap=tonemap=mobius',
            'zscale=p=bt709:t=bt709:m=bt709:r=tv', 'format=yuv420p'] : [])
        ]
    const encoder = hardware
      ? ['-c:v', 'h264_vaapi', '-async_depth', '1']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-threads:v', '2']
    const bitrate = encoding.videoBitrateMbps
    const high = encoding.videoQuality === 'high'
    if (bitrate) {
      if (hardware) encoder.push('-rc_mode', 'VBR')
      encoder.push('-b:v', `${bitrate}M`, '-maxrate', `${bitrate}M`, '-bufsize', `${2 * bitrate}M`)
    } else if (hardware) {
      encoder.push('-qp', high ? '20' : '23')
    } else {
      encoder.push('-crf', high ? '18' : '21')
    }
    args.push(
      '-vf', filters.join(','), '-filter_threads', '2', ...encoder, '-bf', '0', '-flags:v', '+cgop',
      '-force_key_frames', `expr:gte(t,n_forced*${transcodeSegmentSeconds})`
    )
  }
  if (quality === 'remux') {
    args.push('-c:a', 'copy')
  } else {
    args.push('-c:a', 'aac')
    for (const [index, track] of audioTracks.entries()) {
      const channels = encoding.audioChannels === 'surround' ? Math.min(track.channels || 2, 6) : 2
      args.push(`-ac:a:${index}`, String(channels), `-b:a:${index}`, `${Math.min(channels * 96, 384)}k`)
    }
  }
  // Give every independently started job the same output timestamp origin.
  // FFmpeg writes one CSV row after the corresponding segment has been closed.
  args.push(
    ...(remux ? ['-to', Math.min(timeline.duration, end + 0.5).toFixed(6)] : ['-t', (end - start).toFixed(6)]),
    '-f', 'segment', '-segment_format', fragmented ? 'mp4' : 'mpegts',
    '-segment_format_options', fragmented ? mp4Format : mpegtsFormat,
    '-segment_start_number', String(first), '-initial_offset',
    (transportStreamPreroll + (remux ? 0 : start)).toFixed(6),
    '-segment_list_type', 'csv', '-segment_list', 'pipe:1',
    ...(interior.length ? ['-segment_times', interior.join(',')] : ['-segment_time', String(Math.ceil(end - start) + 1)]),
    `segment-%d.${extension}`
  )
  const process = Bun.spawn(args, { cwd: directory, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const stderr = new Response(process.stderr).text()
  const segments = (async () => {
    let pending = ''
    for await (const chunk of process.stdout.pipeThrough(new TextDecoderStream())) {
      const lines = (pending + chunk).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const match = segmentName.exec(line)
        if (!match) continue
        const index = Number(match[1])
        if (index >= first && index <= last) await onSegment(index, join(directory, `segment-${index}.${extension}`))
      }
    }
  })().catch((error: unknown) => {
    process.kill('SIGKILL')
    return error
  })
  const finished = Promise.all([process.exited, segments, stderr]).then(([code, muxError, errors]) => {
    if (muxError) throw muxError
    if (code !== 0) throw new Error(errors.trim().slice(0, 1024) || `FFmpeg exited with status ${code}`)
  })
  return { finished, stop: () => process.kill('SIGKILL') }
}
