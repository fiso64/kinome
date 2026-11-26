import { join } from 'node:path'
import type { LocalMediaTrack } from '@shared/local-media'
import { avcFormat, isHdrTransfer, videoQualityHeights, type PlaybackEncodingPreferences, type PlaybackOutput, type PlaybackVideoBackend, type VideoQuality } from '@shared/playback-quality'
import { endOfSegment, transcodeSegmentSeconds, type PlaybackTimeline } from './timeline'
import { LIBPLACEBO_TO_SDR, vaapiDeviceArgs, type VaapiAccelerator } from './runtime'

export type SegmentQuality = VideoQuality | 'remux' | 'audio'

export function copiesVideo(quality: SegmentQuality): quality is 'remux' | 'audio' {
  return quality === 'remux' || quality === 'audio'
}

export interface SegmentSource {
  path: string
  video: LocalMediaTrack
  audioTracks: readonly LocalMediaTrack[]
  quality: SegmentQuality
  browser?: boolean
  fragmented: boolean
  seekMpegInput?: (start: number, signal: AbortSignal) => Promise<number>
  x264Build?: number
  copyAudio: Set<number>
  videoCodec?: PlaybackOutput['videoCodec']
  channelLimit: number
  encoding: PlaybackEncodingPreferences
  timeline: PlaybackTimeline
  vaapi?: VaapiAccelerator
}


const segmentName = /^segment-(\d+)\.(?:ts|mp4),/
// Reserve timestamp space for reordered video and audio preroll at the start
// of a file. Negative MPEG-TS timestamps wrap to the end of the 33-bit clock.
const transportStreamPreroll = 1.4

// A VOD playlist advertises its cuts before any frames are encoded. A long
// source picture can span a cut, leaving the muxer without a picture there.
export class MissingVideoCut extends Error {}

export function lastSegmentInJob(source: SegmentSource, first: number): number {
  const segmentCount = copiesVideo(source.quality) ? 4 : 12 / transcodeSegmentSeconds
  return Math.min(source.timeline.starts.length - 1, first + segmentCount - 1)
}

export function startSegmentJob(
  executable: string, directory: string, source: SegmentSource, first: number,
  mode: PlaybackVideoBackend, encodeFrom: number, inputStart: number,
  onSegment: (index: number, path: string) => void | Promise<void>, fillVideoGaps = false
) {
  const { quality, timeline, path, video, audioTracks, fragmented, encoding } = source
  const last = lastSegmentInJob(source, first)
  const start = timeline.starts[encodeFrom]
  const end = endOfSegment(timeline, last)
  const boundaries = timeline.starts.slice(encodeFrom + 1, last + 2)
  const firstPicture = Math.max(start, timeline.firstPicture)
  const firstSound = Math.min(firstPicture, ...audioTracks.map(track => track.startSeconds ?? 0))
  // MSE takes the intersection of buffered tracks. Hold the first picture
  // through an audio intro so the player can present the opening soundtrack.
  const openingLead = source.browser && start === 0 && firstPicture - firstSound > 0.25 ? firstPicture - firstSound : 0
  const splitTimes = boundaries.map((time) => (time - firstPicture + openingLead).toFixed(6))
  const remux = copiesVideo(quality)
  const hardware = !remux && mode !== 'software' ? source.vaapi : undefined
  const interlaced = ['tt', 'bb', 'tb', 'bt'].includes(video.fieldOrder ?? '')
  const preserveTimestamps = !remux && !(interlaced && hardware)
  const checkCuts = preserveTimestamps && !fillVideoGaps
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
  // frag_duration splits a long keyframe interval into one-second fragments
  // so a browser can present a segment while it is still downloading.
  const mp4Format = 'movflags=+frag_keyframe+delay_moov+default_base_moof+skip_trailer+frag_discont:frag_duration=1000000:use_editlist=0:strict=experimental:avoid_negative_ts=disabled'
  const extension = fragmented ? 'mp4' : 'ts'
  const args = [
    executable, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-copyts', '-start_at_zero',
    ...(hardware ? vaapiDeviceArgs(hardware) : []),
    ...(mode === 'vaapi' ? ['-hwaccel', 'vaapi', ...(hardware?.libplacebo ? ['-hwaccel_device', 'va'] : []), '-hwaccel_output_format', 'vaapi'] : []),
    // A copied video seeks just past its keyframe to select the correct cue.
    // Keep the corresponding decoded audio preroll instead of trimming it to
    // that later timestamp when only the audio is being converted.
    ...(quality === 'audio' || fillVideoGaps ? ['-noaccurate_seek'] : []),
    // Seeking even to zero can jump to a delayed first video keyframe
    // and discard the audio that precedes it in the container.
    ...(inputStart > 0 ? ['-ss', inputStart.toFixed(6)] : []),
    ...(!remux && source.x264Build !== undefined ? ['-x264_build', String(source.x264Build)] : []),
    '-threads', '2', '-protocol_whitelist', 'file', '-i', path,
    '-map', `0:${video.index}`, ...audioTracks.flatMap((track) => ['-map', `0:${track.index}`]),
    '-map_metadata', '-1', '-map_chapters', '-1', '-avoid_negative_ts', 'disabled'
  ]
  for (const [index, track] of audioTracks.entries()) {
    if (track.language) args.push(`-metadata:s:a:${index}`, `language=${track.language}`)
    args.push(`-disposition:a:${index}`, index === 0 ? 'default' : '0')
  }
  const videoBitstreamFilters: string[] = []
  if (remux) {
    args.push('-c:v', 'copy')
    if (source.x264Build !== undefined && source.x264Build < 151) {
      // Include the source encoder identity at each random-access point.
      videoBitstreamFilters.push('h264_mp4toannexb', 'h264_metadata=sei_user_data=' +
        `dc45e9bde6d948b7962cd820d923eeef+x264 - core ${source.x264Build}`)
    } else if (!fragmented && video.codec === 'h264') {
      // An open-GOP recovery point need not be an IDR. Include the parameter
      // sets there too so a fresh TS parser can configure the video on a seek.
      videoBitstreamFilters.push('h264_mp4toannexb', 'dump_extra=freq=keyframe')
    }
    if (fragmented && video.codec === 'hevc') args.push('-tag:v', 'hvc1')
    // A player that sees Dolby Vision looks for a decoder few devices have, and
    // shows nothing without one. A compatible base layer plays as plain HDR10,
    // SDR or HLG. Profile 5 has none, so its Dolby Vision is kept.
    if (video.dolbyVision?.compatibility) videoBitstreamFilters.push('dovi_rpu=strip=1')
  } else {
    const height = Math.floor(Math.min(video.height!, videoQualityHeights[quality]) / 2) * 2
    const width = Math.round(height * video.width! / video.height! / 2) * 2
    // Autorotation happens before scaling. Preserve the selected reduction
    // on both picture axes even when the filter receives a portrait frame.
    const scale = video.displayMatrix
      ? `w=2*round(iw*${height}/${video.height}/2):h=2*round(ih*${height}/${video.height}/2)`
      : `w=${width}:h=${height}`
    const hdr = isHdrTransfer(video.colorTransfer)
    const toneMap = hdr && !source.videoCodec
    const tenBit = hdr || !!source.videoCodec
    const filters = hardware
      ? [
          ...(mode === 'vaapi-upload' ? [tenBit ? 'format=p010le' : 'format=nv12', 'hwupload'] : []),
          ...(interlaced ? ['deinterlace_vaapi=rate=field:auto=1'] : []),
          `scale_vaapi=${scale}:format=${tenBit ? 'p010' : 'nv12'}`,
          // libplacebo works on the scaled picture in memory, which this GPU path copies out and back.
          ...(toneMap ? hardware.libplacebo ? ['hwdownload', 'format=p010le', LIBPLACEBO_TO_SDR, 'hwupload']
            : ['tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709'] : [])
        ]
      : [
          ...(interlaced ? ['bwdif=mode=send_field:deint=interlaced'] : []),
          `scale=${scale}`,
          // HDR video places SDR white at 203 nits (ITU-R BT.2408). mpv maps it there too.
          ...(toneMap ? ['zscale=t=linear:npl=203', 'format=gbrpf32le', 'tonemap=tonemap=mobius',
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
    if (fillVideoGaps) {
      // Retain the picture preceding the seek and hold it through missing cuts.
      filters.unshift(`fps=fps='max(source_fps,1)':start_time=${firstPicture}:round=near`)
    } else if (source.seekMpegInput && start) filters.unshift(`trim=start=${start}`)
    if (checkCuts) {
      // Observe only the first picture in each second of the filtered video.
      // The segmenter's CSV alone can report a normal video duration even
      // when the final file has absorbed many seconds of audio in a picture gap.
      filters.push("split[video][clock];[clock]select='isnan(prev_t)+gt(floor(t),floor(prev_t))'," +
        "metadata=mode=add:key=cut:value=1,metadata=mode=print:key=cut:file='pipe\\:1':direct=1,nullsink;[video]null")
    }
    // The quality setting picks the encoding quality. A maximum bitrate caps it for limited links.
    const maximum = encoding.videoBitrateMbps
    const high = encoding.videoQuality === 'high'
    if (hardware && maximum) {
      // VA-API drivers have no mode that encodes for quality under a ceiling: Intel's QVBR
      // follows its average like VBR. Scaling the average with the picture area keeps smaller
      // sizes smaller, which Automatic quality relies on when it steps down.
      const average = maximum * Math.min(1, width * height / (1920 * 1080))
      encoder.push('-rc_mode', 'VBR', '-b:v', `${Math.max(average, 0.25).toFixed(2)}M`, '-maxrate', `${maximum}M`, '-bufsize', `${2 * maximum}M`)
    } else if (hardware) {
      // Constant QP. Intel's ICQ measured no better, and AMD's drivers lack it.
      encoder.push(codec === 'vp9' ? '-global_quality' : '-qp', high ? '20' : '23')
    } else {
      encoder.push('-crf', high ? '18' : '21')
      // libvpx caps constant quality through -b:v. x264 and x265 cap it through their VBV.
      if (codec === 'vp9') encoder.push('-b:v', maximum ? `${maximum}M` : '0')
      else if (maximum) encoder.push('-maxrate', `${maximum}M`, '-bufsize', `${2 * maximum}M`)
    }
    args.push(
      '-vf', filters.join(','), '-filter_threads', '2',
      ...(preserveTimestamps ? ['-fps_mode:v', 'vfr', '-enc_time_base:v', '1:90000'] : []),
      ...encoder, '-bf', '0', '-flags:v', '+cgop',
      ...(boundaries.length ? ['-force_key_frames', boundaries.join(',')] : [])
    )
  }
  if (openingLead) {
    const shift = `${openingLead}/TB`
    videoBitstreamFilters.push(`setts=pts='if(eq(N,0),PTS-${shift},PTS)':dts='if(eq(N,0),DTS-${shift},DTS)':duration='if(eq(N,0),DURATION+${shift},DURATION)'`)
  }
  if (videoBitstreamFilters.length) args.push('-bsf:v', videoBitstreamFilters.join(','))
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
    let picture: number | undefined
    let awaitingCut: number | undefined
    const publish = (index: number) => onSegment(index, join(directory, `segment-${index}.${extension}`))
    for await (const chunk of process.stdout.pipeThrough(new TextDecoderStream())) {
      const lines = (pending + chunk).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (checkCuts && line.startsWith('frame:')) {
          const time = Number(line.split('pts_time:')[1])
          const cut = picture === undefined ? firstPicture : Math.floor(picture) + 1
          if (time > cut + 0.25) throw new MissingVideoCut()
          picture = time
          if (awaitingCut !== undefined && time >= timeline.starts[awaitingCut + 1]) {
            await publish(awaitingCut)
            awaitingCut = undefined
          }
          continue
        }
        const match = segmentName.exec(line)
        if (!match) continue
        const index = Number(match[1])
        if (index < first || index > last) continue
        if (awaitingCut !== undefined) throw new MissingVideoCut()
        const nextCut = timeline.starts[index + 1]
        if (checkCuts && (picture === undefined || (nextCut !== undefined && picture < nextCut))) {
          awaitingCut = index
        } else await publish(index)
      }
    }
    if (awaitingCut !== undefined) throw new MissingVideoCut()
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
