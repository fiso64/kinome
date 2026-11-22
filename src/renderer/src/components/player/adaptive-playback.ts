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
  offline?: boolean
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
    // A local media server can still deliver bytes while the browser
    // reports offline. Keep the current rendition through an actual outage.
    if (sample.offline && end <= first.end) {
      this.headroomSince = undefined
      return
    }
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

/** Recover a stopped media clock or a native seek abandoned by the demuxer. */
export function watchPlaybackProgress(
  video: HTMLVideoElement, signal: AbortSignal, native: boolean,
  stalled: (reason: string, details: Record<string, number>) => void
) {
  const page = video.ownerDocument
  let timer: ReturnType<typeof setInterval> | undefined
  let lastTime = 0
  let lastPosition = 0
  let healthyAt = 0
  let healthyPosition = 0

  function stop() {
    clearInterval(timer)
    timer = undefined
  }
  function active() {
    return !page.hidden && !video.ended && !video.error && (video.seeking ? native : !video.paused)
  }
  function sample() {
    if (!active()) { stop(); return }
    const now = performance.now()
    const position = video.currentTime
    const elapsed = now - lastTime
    const advance = position - lastPosition
    lastTime = now
    lastPosition = position
    const idleRead = native && video.networkState === video.NETWORK_IDLE &&
      (video.seeking || video.readyState < video.HAVE_FUTURE_DATA)
    // Firefox can stay at HAVE_CURRENT_DATA with seconds of both tracks
    // already buffered. Use the buffered range to distinguish a stuck decoder
    // from an ordinary wait for bytes.
    const slowClock = !video.seeking && advance >= 0 && advance < elapsed / 1000 * video.playbackRate / 4
    if (elapsed > 5000 || (!idleRead && !slowClock)) {
      healthyAt = now
      healthyPosition = position
      return
    }
    if (now - healthyAt < 6000) return
    const progress = position - healthyPosition
    healthyAt = now
    healthyPosition = position
    const bufferedAhead = bufferedEnd(video) - position
    if (!idleRead && bufferedAhead < 2 * video.playbackRate) return
    stop()
    stalled(idleRead ? 'The browser stopped loading before the requested position was playable.' :
      'The playback clock stopped advancing with media buffered.', {
      bufferedAhead, progress, readyState: video.readyState, networkState: video.networkState
    })
  }
  function reset() {
    stop()
    if (!active()) return
    lastTime = healthyAt = performance.now()
    lastPosition = healthyPosition = video.currentTime
    timer = setInterval(sample, 2000)
  }

  for (const event of ['play', 'playing', 'waiting', 'suspend']) {
    video.addEventListener(event, () => { if (timer === undefined) reset() }, { signal })
  }
  for (const event of ['pause', 'ended', 'seeking', 'seeked', 'ratechange']) video.addEventListener(event, reset, { signal })
  page.addEventListener('visibilitychange', reset, { signal })
  signal.addEventListener('abort', stop, { once: true })
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
    if (!started || document.hidden || video.seeking || video.paused || video.ended) return reset()
    const position = video.currentTime
    const frames = video.getVideoPlaybackQuality?.()
    const decision = stats.sample({
      time: performance.now(), end: bufferedEnd(video), frames: frames?.totalVideoFrames ?? 0,
      dropped: frames?.droppedVideoFrames ?? 0, offline: !navigator.onLine
    }, position, video.duration, video.playbackRate, video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
    previousRenditions.at(-1), recoverySeconds)
    if (decision === 'lower') switchDown(stats.bitrate, stats.deliveryRatio)
    if (decision === 'higher') switchUp()
  }, 1000)
  signal.addEventListener('abort', () => clearInterval(timer), { once: true })
  return stats
}

type HlsClass = typeof import('hls.js').default

export function watchHlsSeeks(
  Hls: HlsClass, player: InstanceType<HlsClass>, video: HTMLVideoElement, signal: AbortSignal,
  stalled: (detail: string) => void
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSegment: number | undefined
  let unhelpfulFragments = 0
  function clear() {
    clearTimeout(timer)
    timer = undefined
    lastSegment = undefined
    unhelpfulFragments = 0
  }
  function check() {
    if (!video.seeking || signal.aborted) return
    if (unhelpfulFragments >= 2) {
      clear()
      stalled('HLS buffered segments without reaching the seek target.')
      return
    }
    const { state } = player.inFlightFragments.main
    // An active transfer has its own timeout and retries. An idle loader
    // can wait forever when MSE reports a buffered but unplayable range.
    if (state === 'IDLE' || state === 'STOPPED' || state === 'ENDED') stalled('HLS stopped loading during the seek.')
    else timer = setTimeout(check, 8000)
  }
  video.addEventListener('seeking', () => {
    clear()
    timer = setTimeout(check, 8000)
    if (!player.config.progressive) return
    const { frag } = player.inFlightFragments.main
    const target = video.currentTime
    // Abandoning a partly transmuxed TS fragment can carry samples across
    // the seek. Reset the parser while keeping completed media buffers.
    // Parsed audio/video timestamps can move a playlist cut by a few
    // frames. HLS still considers that fragment a match for the target.
    const tolerance = player.config.maxFragLookUpTolerance
    if (frag && frag.stats.chunkCount && !frag.stats.buffering.end &&
      (target < frag.start - tolerance || target > frag.end + tolerance)) player.startLoad(target, true)
  }, { signal })
  player.on(Hls.Events.FRAG_BUFFERED, (_event, { frag }) => {
    if (timer === undefined || !video.seeking || typeof frag.sn !== 'number') return
    // One neighbouring fragment can legitimately supply decode preroll.
    const margin = player.latestLevelDetails?.targetduration ?? frag.duration
    const outside = video.currentTime < frag.start - margin || video.currentTime > frag.end + margin
    if (lastSegment === frag.sn || outside) {
      if (++unhelpfulFragments === 2) {
        // Cached fragments can finish in one burst before the decoder reports
        // seeked. Give the pending seek time to present its first picture.
        clearTimeout(timer)
        timer = setTimeout(check, 1000)
      }
    } else {
      unhelpfulFragments = 0
      clearTimeout(timer)
      timer = setTimeout(check, 8000)
    }
    lastSegment = frag.sn
  })
  video.addEventListener('seeked', () => { if (!video.seeking) clear() }, { signal })
  signal.addEventListener('abort', clear, { once: true })
}

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
        if (!data.fatal && data.response?.code !== 422) return
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
