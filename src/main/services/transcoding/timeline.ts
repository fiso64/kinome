const targetRemuxSegmentSeconds = 2
// HLS players fetch whole segments before resuming a seek. Short encoded
// segments make the first few responses available sooner.
export const transcodeSegmentSeconds = 1
const minimumTailSeconds = 0.15
// Container cues index presentation time. HLS readers such as libavformat
// compare decode timestamps on a seek, and can otherwise discard the opening
// keyframe of a copied segment. Slightly lead the advertised boundaries while
// retaining the original packet timestamps and the total running time.
const remuxSeekLead = 0.25

export interface PlaybackTimeline {
  readonly firstPicture: number
  readonly duration: number
  readonly starts: readonly number[]
  readonly seekStarts?: readonly number[]
}

export function createTimeline(duration: number, keyframes?: readonly number[], videoEnd = duration, firstPicture = 0): PlaybackTimeline {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The file has no usable duration')
  // The final video segment carries any remaining audio. A cut after the last
  // picture cannot be produced by the video-referenced segment muxer.
  const lastCut = Math.min(duration, videoEnd) - minimumTailSeconds
  const starts = [0]
  if (keyframes) {
    if (!keyframes.length) throw new Error('The file has no usable video seek index')
    const seekStarts = [0]
    for (const [index, keyframe] of keyframes.entries()) {
      if (keyframe >= lastCut) break
      if (keyframe <= firstPicture) continue
      if (keyframe - starts[starts.length - 1] < targetRemuxSegmentSeconds) continue
      starts.push(keyframe)
      // Some demuxers back up across their seek preroll. Seek slightly beyond
      // the desired cue without reaching the next keyframe.
      const next = keyframes[index + 1] ?? duration
      seekStarts.push(keyframe + Math.min(0.25, (next - keyframe) / 2))
    }
    return { firstPicture, duration, starts, seekStarts }
  }
  const firstCut = Math.ceil((firstPicture + minimumTailSeconds) / transcodeSegmentSeconds) * transcodeSegmentSeconds
  for (let time = firstCut; time < lastCut; time += transcodeSegmentSeconds) starts.push(time)
  return { firstPicture, duration, starts }
}

export function endOfSegment(timeline: PlaybackTimeline, index: number): number {
  return timeline.starts[index + 1] ?? timeline.duration
}

export function segmentPlaylist(
  timeline: PlaybackTimeline, urlForSegment: (index: number) => string, initUrl?: string, browser = false
): string {
  const startOf = (index: number) => {
    const start = timeline.starts[index]
    if (start === undefined) return timeline.duration
    // Browser HLS players need the actual boundaries to choose the segment
    // that contains the requested position before the first frame is decoded.
    return !browser && timeline.seekStarts && index > 0 ? start - remuxSeekLead : start
  }
  let targetDuration = 1
  const durations = timeline.starts.map((_, index) => startOf(index + 1) - startOf(index))
  for (const duration of durations) targetDuration = Math.max(targetDuration, Math.ceil(duration))
  const playlist = [
    '#EXTM3U', initUrl ? '#EXT-X-VERSION:7' : '#EXT-X-VERSION:6', '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-TARGETDURATION:${targetDuration}`
  ]
  if (initUrl) playlist.push(`#EXT-X-MAP:URI="${initUrl}"`)
  for (const [index, duration] of durations.entries()) {
    playlist.push(`#EXTINF:${duration.toFixed(6)},`, urlForSegment(index))
  }
  return playlist.concat('#EXT-X-ENDLIST', '').join('\n')
}
