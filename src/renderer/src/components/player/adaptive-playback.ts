import type { ErrorData, Events, FragLoadedData } from 'hls.js'

// Kinome generates renditions on demand. A switch reopens the source, so
// require evidence that the interruption will buy sustained playable quality.
export interface RenditionTarget {
  index: number
  bitrate?: number
}

interface Sample {
  time: number
  end: number
  frames: number
  dropped: number
}

export class AdaptivePlaybackStats {
  private samples: Sample[] = []
  private throughput = 0
  private fragments = 0
  private lastHealthy = 0
  private headroomSince?: number
  stableSince = 0
  deliveryRatio?: number

  constructor(public bitrate?: number, private readonly segmented = false) {}

  reset(now: number) {
    this.samples.length = 0
    this.headroomSince = undefined
    this.stableSince = this.lastHealthy = now
  }

  fragment(bytes: number, duration: number, milliseconds: number) {
    if (bytes <= 0 || duration <= 0 || milliseconds <= 0) return
    const bits = bytes * 8
    const measured = bits * 1000 / milliseconds
    // Include generation time. Let a slow segment reduce the estimate
    // immediately, but require several faster downloads to raise it.
    this.throughput = this.fragments ? Math.min(measured, this.throughput * 0.75 + measured * 0.25) : measured
    this.bitrate = this.fragments && this.bitrate ? this.bitrate * 0.75 + bits / duration * 0.25 : bits / duration
    this.fragments++
  }

  sample(sample: Sample, position: number, duration: number, rate: number, stalled: boolean,
    higher: RenditionTarget | undefined, recoverySeconds: number): 'lower' | 'higher' | undefined {
    const { time, end } = sample
    const previous = this.samples.at(-1)
    if (!previous || time - previous.time > 2500) {
      this.reset(time)
      this.samples.push(sample)
      return
    }
    this.samples.push(sample)
    if (this.samples.length > 7) this.samples.shift()
    const instantRate = (end - previous.end) * 1000 / (time - previous.time)
    // Progressive downloads advance continuously. HLS appends in bursts.
    if (!this.segmented && (instantRate < 0.02 || instantRate >= rate * 0.98)) this.lastHealthy = time
    const first = this.samples[0]
    const seconds = (time - first.time) / 1000
    if (seconds < 3 || (duration - position) / rate < 5) return
    const ahead = (end - position) / rate
    const mid = this.samples[Math.floor(this.samples.length / 2)]
    const recentRate = (end - mid.end) * 1000 / (time - mid.time)
    const earlierRate = (mid.end - first.end) * 1000 / (mid.time - first.time)
    const sustained = seconds >= 5.8 && earlierRate < rate * 0.9 && (this.segmented || time - this.lastHealthy >= 5000)
    const starving = (sustained || (ahead < 1 && stalled)) && ahead < 4 && end < duration - 0.25 &&
      recentRate > 0 && recentRate < rate * 0.9 && (end - first.end) / seconds < rate * 0.88 &&
      (this.segmented || instantRate < rate * 0.9)

    const total = sample.frames - first.frames
    const dropped = sample.dropped - first.dropped
    const recentDrops = (sample.dropped - mid.dropped) / Math.max(1, sample.frames - mid.frames)
    const earlierDrops = (mid.dropped - first.dropped) / Math.max(1, mid.frames - first.frames)
    const decodePressure = ahead >= 2 && total >= 30 && dropped >= 8 && earlierDrops > 0.08 && recentDrops > 0.08 &&
      dropped / total > (seconds >= 5.8 ? 0.1 : 0.25)
    if (total >= 30 && dropped >= 6 && dropped / total > 0.05) this.stableSince = time
    if (starving || decodePressure) {
      // Media seconds arriving per second of playback. Only skip a rung on
      // bandwidth evidence. CPU-limited playback tries its nearest neighbour.
      this.deliveryRatio = starving && !decodePressure ? recentRate / rate : undefined
      this.reset(time)
      return 'lower'
    }
    const stableSeconds = (time - this.stableSince) / 1000
    const headroom = stableSeconds >= recoverySeconds * 2 ? 1.15 : 1.35
    const spare = higher && (!this.fragments || !higher.bitrate ||
      (this.fragments >= 3 && this.throughput > higher.bitrate * rate * headroom))
    if (spare && ahead >= 8) this.headroomSince ??= time
    else this.headroomSince = undefined
    if (this.headroomSince !== undefined && stableSeconds >= recoverySeconds &&
      (time - this.headroomSince) / 1000 >= Math.min(24, recoverySeconds * 0.4) && (duration - position) / rate > 15) {
      return 'higher'
    }
  }
}

export function bufferedEnd(video: HTMLVideoElement) {
  const position = video.currentTime
  const ranges = video.buffered
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= position + 0.05 && ranges.end(i) >= position) return ranges.end(i)
  }
  return position
}

export function monitorAdaptivePlayback(
  video: HTMLVideoElement, signal: AbortSignal, stats: AdaptivePlaybackStats,
  previousRenditions: readonly RenditionTarget[], recoverySeconds: number,
  switchDown: (bitrate?: number, deliveryRatio?: number) => void, switchUp: () => void
) {
  let started = false
  const reset = () => stats.reset(performance.now())
  function suspend() {
    started = false
    reset()
  }
  video.addEventListener('playing', () => { started = true }, { signal })
  video.addEventListener('waiting', () => { stats.stableSince = performance.now() }, { signal })
  video.addEventListener('pause', suspend, { signal })
  video.addEventListener('seeking', suspend, { signal })
  video.addEventListener('ratechange', reset, { signal })
  document.addEventListener('visibilitychange', reset, { signal })
  window.addEventListener('offline', reset, { signal })
  const timer = window.setInterval(() => {
    if (!started || document.hidden || !navigator.onLine || video.seeking || video.paused || video.ended) return reset()
    const position = video.currentTime
    const frames = video.getVideoPlaybackQuality?.()
    const decision = stats.sample({
      time: performance.now(), end: bufferedEnd(video), frames: frames?.totalVideoFrames ?? 0, dropped: frames?.droppedVideoFrames ?? 0
    }, position, video.duration, video.playbackRate, video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
    previousRenditions.at(-1), recoverySeconds)
    if (decision === 'lower') switchDown(stats.bitrate, stats.deliveryRatio)
    if (decision === 'higher') switchUp()
  }, 1000)
  signal.addEventListener('abort', () => clearInterval(timer), { once: true })
  return stats
}

type HlsClass = typeof import('hls.js').default

export function createPlaybackHls(Hls: HlsClass, position: number, prefetch = false) {
  const player = new Hls({
    progressive: true, maxBufferLength: 12, maxMaxBufferLength: 30,
    startPosition: position || -1, startFragPrefetch: prefetch
  })
  // Request the streaming loader above, but deliver complete fragments until
  // the playlist identifies TS. HLS.js can start its first fragment inside
  // its own LEVEL_LOADED listener, before application listeners run.
  const canStream = player.config.progressive
  player.config.progressive = false
  player.on(Hls.Events.LEVEL_UPDATED, (_event, { details }) => {
    const first = details.fragments[0]
    player.config.progressive = canStream && !!first && !first.initSegment
  })
  return player
}

/** Keep presenting the current source while the first on-demand segment is generated. */
export async function prefetchRendition(url: string, position: number, signal: AbortSignal) {
  const { default: Hls } = await import('hls.js')
  signal.throwIfAborted()
  if (!Hls.isSupported()) return
  const player = createPlaybackHls(Hls, position, true)
  try {
    const compatible = await new Promise<boolean>((resolve, reject) => {
      const aborted = () => reject(signal.reason)
      signal.addEventListener('abort', aborted, { once: true })
      function loaded(_event: Events.FRAG_LOADED, { frag }: FragLoadedData) {
        if (frag.sn === 'initSegment') return
        signal.removeEventListener('abort', aborted)
        player.off(Hls.Events.ERROR, failed)
        player.off(Hls.Events.FRAG_LOADED, loaded)
        resolve(true)
      }
      function failed(_event: Events.ERROR, data: ErrorData) {
        if (!data.fatal) return
        if (data.response?.code === 422 || data.type === Hls.ErrorTypes.MEDIA_ERROR) resolve(false)
        else reject(data.error)
      }
      player.on(Hls.Events.ERROR, failed)
      player.on(Hls.Events.FRAG_LOADED, loaded)
      player.loadSource(url)
    })
    if (compatible) return player
    player.destroy()
    return false
  } catch (error) {
    player.destroy()
    throw error
  }
}
