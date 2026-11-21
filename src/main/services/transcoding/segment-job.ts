import { join } from 'node:path'
import type { LocalMediaTrack } from '@shared/local-media'
import { avcFormat, type PlaybackEncodingPreferences, type PlaybackOutput, type PlaybackVideoBackend, type VideoQuality } from '@shared/playback-quality'
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
  seekMpegInput?: (start: number, signal: AbortSignal) => Promise<number>
  x264Build?: number
  copyAudio: Set<number>
  videoCodec?: PlaybackOutput['videoCodec']
  channelLimit: number
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
  mode: PlaybackVideoBackend, encodeFrom: number, inputStart: number,
  onSegment: (index: number, path: string) => void | Promise<void>
) {
  const { quality, timeline, path, video, audioTracks, fragmented, encoding } = source
  const last = lastSegmentInJob(source, first)
  const start = timeline.starts[encodeFrom]
  const end = endOfSegment(timeline, last)
  const boundaries = timeline.starts.slice(encodeFrom + 1, last + 2)
  const firstPicture = Math.max(start, timeline.firstPicture)
  const splitTimes = boundaries.map((time) => (time - firstPicture).toFixed(6))
  const remux = copiesVideo(quality)
  const hardware = !remux && mode !== 'software' ? source.vaapiDevice : undefined
  // TrueHD needs a Blu-ray stream type and an AC-3 compatibility stream.
  const mpegtsFormat = [
    'mpegts_copyts=1', 'mpegts_flags=initial_discontinuity',
    'avoid_negative_ts=disabled',
    // Emit copied audio early enough for progressive playback on slow links.
    ...(!remux && source.copyAudio.size ? ['pes_payload_size=512'] : []),
    ...(quality === 'remux' && audioTracks.some((track) => track.codec === 'truehd') ? ['mpegts_m2ts_mode=1'] : [])
  ].join(':')
  // frag_discont keeps the source's decode times in tfdt across independently
  // opened MP4 muxers. default_base_moof makes media readable without its moov.
  const mp4Format = 'movflags=+frag_keyframe+delay_moov+default_base_moof+skip_trailer+frag_discont:use_editlist=0:strict=experimental:avoid_negative_ts=disabled'
  const extension = fragmented ? 'mp4' : 'ts'
  const args = [
    executable, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-copyts', '-start_at_zero',
    ...(hardware ? ['-vaapi_device', hardware] : []),
    ...(mode === 'vaapi' ? ['-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi'] : []),
    // A copied video seeks just past its keyframe to select the correct cue.
    // Keep the corresponding decoded audio preroll instead of trimming it to
    // that later timestamp when only the audio is being converted.
    ...(quality === 'audio' ? ['-noaccurate_seek'] : []),
    '-ss', inputStart.toFixed(6),
    ...(!remux && source.x264Build !== undefined ? ['-x264_build', String(source.x264Build)] : []),
    '-threads', '2', '-protocol_whitelist', 'file', '-i', path,
    '-map', `0:${video.index}`, ...audioTracks.flatMap((track) => ['-map', `0:${track.index}`]),
    '-map_metadata', '-1', '-map_chapters', '-1', '-avoid_negative_ts', 'disabled'
  ]
  for (const [index, track] of audioTracks.entries()) {
    if (track.language) args.push(`-metadata:s:a:${index}`, `language=${track.language}`)
    args.push(`-disposition:a:${index}`, index === 0 ? 'default' : '0')
  }
  if (remux) {
    args.push('-c:v', 'copy')
    if (source.x264Build !== undefined && source.x264Build < 151) {
      // Include the source encoder identity at each random-access point.
      args.push('-bsf:v', 'h264_mp4toannexb,h264_metadata=sei_user_data=' +
        `dc45e9bde6d948b7962cd820d923eeef+x264 - core ${source.x264Build}`)
    }
    if (fragmented && video.codec === 'hevc') args.push('-tag:v', 'hvc1')
  } else {
    const height = Math.floor(Math.min(video.height!, heights[quality]) / 2) * 2
    const width = Math.round(height * video.width! / video.height! / 2) * 2
    const hdr = video.colorTransfer === 'smpte2084' || video.colorTransfer === 'arib-std-b67'
    const toneMap = hdr && !source.videoCodec
    const tenBit = hdr || !!source.videoCodec
    const interlaced = ['tt', 'bb', 'tb', 'bt'].includes(video.fieldOrder ?? '')
    const filters = hardware
      ? [
          ...(mode === 'vaapi-upload' ? [tenBit ? 'format=p010le' : 'format=nv12', 'hwupload'] : []),
          ...(interlaced ? ['deinterlace_vaapi=rate=field:auto=1'] : []),
          `scale_vaapi=w=${width}:h=${height}:format=${tenBit ? 'p010' : 'nv12'}`,
          ...(toneMap ? ['tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709'] : [])
        ]
      : [
          ...(interlaced ? ['bwdif=mode=send_field:deint=interlaced'] : []),
          `scale=${width}:${height}`,
          ...(toneMap ? ['zscale=t=linear:npl=100', 'format=gbrpf32le', 'tonemap=tonemap=mobius',
            'zscale=p=bt709:t=bt709:m=bt709:r=tv', 'format=yuv420p'] : [])
        ]
    const codec = source.videoCodec === 'avc' ? 'h264' : source.videoCodec ?? 'h264'
    const pixelFormat = source.videoCodec === 'avc' ? avcFormat(video.pixelFormat).pixelFormat :
      source.videoCodec ? 'yuv420p10le' : 'yuv420p'
    const softwareCodecs = { h264: 'libx264', hevc: 'libx265', vp9: 'libvpx-vp9' }
    const encoder = hardware
      ? ['-c:v', codec + '_vaapi', '-async_depth', '1']
      : ['-c:v', softwareCodecs[codec], '-pix_fmt', pixelFormat, '-threads:v', '2']
    if (!hardware) {
      if (codec === 'vp9') encoder.push('-deadline', 'realtime', '-cpu-used', '5', '-row-mt', '1', '-lag-in-frames', '0')
      else encoder.push('-preset', 'veryfast')
      if (codec === 'hevc') encoder.push('-x265-params', 'pools=2:open-gop=0', '-forced-idr', '1')
    }
    if (codec === 'hevc') encoder.push('-tag:v', 'hvc1')
    if (source.videoCodec && video.colorTransfer) encoder.push('-color_trc', video.colorTransfer)
    if (source.seekMpegInput && start) filters.unshift(`trim=start=${start}`)
    const bitrate = encoding.videoBitrateMbps
    const high = encoding.videoQuality === 'high'
    if (bitrate) {
      if (hardware) encoder.push('-rc_mode', 'VBR')
      encoder.push('-b:v', `${bitrate}M`, '-maxrate', `${bitrate}M`, '-bufsize', `${2 * bitrate}M`)
    } else if (hardware) {
      encoder.push(codec === 'vp9' ? '-global_quality' : '-qp', high ? '20' : '23')
    } else {
      encoder.push('-crf', high ? '18' : '21')
      if (codec === 'vp9') encoder.push('-b:v', '0')
    }
    args.push(
      '-vf', filters.join(','), '-filter_threads', '2', ...encoder, '-bf', '0', '-flags:v', '+cgop',
      ...(boundaries.length ? ['-force_key_frames', boundaries.join(',')] : [])
    )
  }
  for (const [index, track] of audioTracks.entries()) {
    if (source.copyAudio.has(track.index)) {
      args.push(`-c:a:${index}`, 'copy')
      if (!remux && start > 0) {
        // Input seeking can return audio from the preceding video keyframe.
        // Keep the packet crossing the cut but discard older copied packets.
        args.push(`-bsf:a:${index}`, `noise=drop='lte((pts+duration)*tb,${start})'`)
      }
      continue
    }
    const channels = Math.min(track.channels || 2, source.channelLimit)
    args.push(`-c:a:${index}`, 'aac')
    // Anchor AAC frames to the source clock across independent jobs.
    if (track.sampleRate) {
      const firstSample = Math.floor(start * track.sampleRate / 1024) * 1024
      args.push(`-filter:a:${index}`, `aresample=first_pts=${firstSample}`)
    }
    args.push(`-ac:a:${index}`, String(channels), `-b:a:${index}`, `${Math.min(channels * 96, channels > 6 ? 512 : 384)}k`)
  }
  // Give every independently started job the same output timestamp origin.
  // FFmpeg writes one CSV row after the corresponding segment has been closed.
  args.push(
    '-to', Math.min(timeline.duration, end + 0.5).toFixed(6),
    '-f', 'segment', '-segment_format', fragmented ? 'mp4' : 'mpegts',
    '-segment_format_options', fragmented ? mp4Format : mpegtsFormat,
    ...(!remux ? ['-segment_time_delta', '0.05'] : []),
    '-segment_start_number', String(encodeFrom), '-initial_offset',
    String(transportStreamPreroll),
    '-segment_list_type', 'csv', '-segment_list', 'pipe:1',
    ...(splitTimes.length ? ['-segment_times', splitTimes.join(',')] : ['-segment_time', String(Math.ceil(end - start) + 1)]),
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
