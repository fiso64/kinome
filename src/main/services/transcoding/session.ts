import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { inspectMp4Segment } from './mp4-keyframes'
import type { PlaybackVideoBackend } from '@shared/playback-quality'
import { copiesVideo, lastSegmentInJob, MissingVideoCut, startSegmentJob, type SegmentSource } from './segment-job'
import { transcodeSegmentSeconds } from './timeline'

const retentionMs = 60_000
const retainedRemuxSegments = 24
const retainedTranscodeSeconds = 48
const retainedBytes = 256 * 1024 * 1024
const videoModes: readonly PlaybackVideoBackend[] = ['vaapi', 'vaapi-upload', 'software']

interface CachedSegment {
  path: string
  bytes: number
  offset: number
}

interface SegmentWaiter {
  promise: Promise<CachedSegment>
  resolve: (segment: CachedSegment) => void
  reject: (error: Error) => void
}

interface Job {
  first: number
  last: number
  requests: number
  idle?: PromiseWithResolvers<void>
  cancelTimer?: ReturnType<typeof setTimeout>
  stop: () => void
  waiters: Map<number, SegmentWaiter>
}

async function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  const aborted = Promise.withResolvers<never>()
  const abort = () => aborted.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    return await Promise.race([promise, aborted.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export class PlaybackSession {
  readonly #executable: string
  readonly #source: SegmentSource
  readonly #onIdle: () => void
  readonly #onVideoBackend: (mode: PlaybackVideoBackend) => void
  readonly #completed = new Map<number, CachedSegment>()
  readonly #jobs = new Set<Promise<void>>()
  readonly #id: string
  readonly #started = performance.now()
  #generated = 0
  #cancelled = 0
  #windows = 0
  #cachedBytes = 0
  #directory?: Promise<string>
  #initialization?: Buffer
  #videoMode: PlaybackVideoBackend
  #job?: Job
  #timer?: ReturnType<typeof setTimeout>
  #closed = false

  constructor(id: string, executable: string, source: SegmentSource, onIdle: () => void, onVideoBackend: (mode: PlaybackVideoBackend) => void) {
    this.#id = id
    this.#executable = executable
    this.#source = source
    this.#onIdle = onIdle
    this.#onVideoBackend = onVideoBackend
    this.#videoMode = 'software'
    if (!copiesVideo(source.quality) && source.vaapiDevice) {
      // FFmpeg applies the source display matrix on CPU frames. VA-API
      // decode can discard it, leaving the encoded picture sideways or mirrored.
      this.#videoMode = source.video.displayMatrix ? 'vaapi-upload' : 'vaapi'
    }
    console.info('[Playback] Opened conversion session', { operationId: id, quality: source.quality })
    this.touch()
  }

  touch(): void {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      if (this.#job?.requests) this.touch()
      else this.#onIdle()
    }, retentionMs)
    this.#timer.unref()
  }

  /** Every segment carries the same initialization. Take it from the job that playback will use next. */
  async initialization(nearSegment: number, signal?: AbortSignal): Promise<Buffer> {
    this.touch()
    if (!this.#initialization) await this.segment(nearSegment, signal)
    if (!this.#initialization) throw new Error('Missing MP4 initialization')
    return this.#initialization
  }

  async segment(index: number, signal?: AbortSignal): Promise<CachedSegment> {
    signal?.throwIfAborted()
    if (this.#closed || !Number.isSafeInteger(index) || index < 0 || index >= this.#source.timeline.starts.length) {
      throw new RangeError('Segment is unavailable')
    }
    this.touch()
    const cached = this.#completed.get(index)
    if (cached) return this.#reuse(index, cached)
    this.#directory ??= mkdtemp(join(tmpdir(), 'kinome-playback-'))
    const directoryPromise = this.#directory
    const root = await directoryPromise.catch((error: unknown) => {
      if (this.#directory === directoryPromise) this.#directory = undefined
      throw error
    })
    signal?.throwIfAborted()
    if (this.#closed) throw new Error('Playback session ended')
    const completed = this.#completed.get(index)
    if (completed) return this.#reuse(index, completed)
    if (this.#job && index >= this.#job.first && index <= this.#job.last) {
      return this.#segmentFrom(this.#job, index, signal)
    }
    if (this.#job?.requests) {
      // A player can request neighbouring segments in reverse order. Finish
      // any still-wanted responses before replacing their encoding window.
      this.#job.idle ??= Promise.withResolvers<void>()
      await waitFor(this.#job.idle.promise, signal)
      return this.segment(index, signal)
    }

    this.#cancelJob()
    const directory = join(root, crypto.randomUUID())
    // Reserve this window before creating its directory so requests can coalesce.
    const job: Job = {
      first: index,
      last: lastSegmentInJob(this.#source, index),
      requests: 0,
      waiters: new Map(),
      stop: () => {}
    }
    this.#job = job
    this.#windows++
    const done = this.#run(job, directory, index)
    this.#jobs.add(done)
    void done.then(() => this.#jobs.delete(done))
    return this.#segmentFrom(job, index, signal)
  }

  #reuse(index: number, segment: CachedSegment): CachedSegment {
    if (this.#job && !this.#job.requests && (index < this.#job.first - 1 || index > this.#job.last)) this.#cancelJob()
    this.#completed.delete(index)
    this.#completed.set(index, segment)
    return segment
  }

  #cancelJob(): void {
    const job = this.#job
    if (!job) return
    this.#job = undefined
    this.#cancelled++
    clearTimeout(job.cancelTimer)
    for (const waiter of job.waiters.values()) waiter.reject(new DOMException('Playback moved to another segment', 'AbortError'))
    job.waiters.clear()
    job.stop()
  }

  async #segmentFrom(job: Job, index: number, signal?: AbortSignal): Promise<CachedSegment> {
    clearTimeout(job.cancelTimer)
    let waiter = job.waiters.get(index)
    if (!waiter) {
      waiter = Promise.withResolvers<CachedSegment>()
      job.waiters.set(index, waiter)
    }
    job.requests++
    try {
      return await waitFor(waiter.promise, signal)
    } finally {
      job.requests--
      if (!job.requests) {
        job.idle?.resolve()
        job.idle = undefined
        if (signal?.aborted && this.#job === job) {
          // A fragment timeout is followed by a new HTTP request for the same
          // segment. Let that request reuse the encode. A seek outside this
          // window still replaces it immediately.
          job.cancelTimer = setTimeout(() => {
            if (this.#job === job && !job.requests) this.#cancelJob()
          }, 1500)
        }
      }
    }
  }

  async #run(job: Job, directory: string, index: number): Promise<void> {
    let failure = new Error('FFmpeg did not produce the requested segment')
    try {
      await mkdir(directory)
      if (this.#closed || this.#job !== job) throw new Error('Playback moved to another segment')
      const segmentLimit = copiesVideo(this.#source.quality)
        ? retainedRemuxSegments
        : retainedTranscodeSeconds / transcodeSegmentSeconds
      const publish = async (segment: number, path: string) => {
        if (this.#job !== job || this.#closed) return
        let cached = this.#completed.get(segment)
        if (!cached) {
          const fragment = this.#source.fragmented
            ? await inspectMp4Segment(path, !this.#initialization, copiesVideo(this.#source.quality) ? this.#source.x264Build : undefined)
            : undefined
          if (this.#job !== job || this.#closed) return
          const bytes = Bun.file(path).size
          if (!bytes) throw new Error('FFmpeg produced an empty media segment')
          // Move published files out of the job directory. This keeps scratch
          // directories bounded across a feature-length stream or many seeks.
          const retained = join(dirname(directory), basename(directory) + '-' + basename(path))
          await rename(path, retained)
          if (this.#job !== job || this.#closed) {
            await rm(retained, { force: true })
            return
          }
          this.#initialization ??= fragment?.initialization
          cached = { path: retained, bytes, offset: fragment?.offset ?? 0 }
          this.#generated++
          this.#completed.set(segment, cached)
          this.#cachedBytes += bytes
        }
        job.waiters.get(segment)?.resolve(cached)
        job.waiters.delete(segment)
        while (this.#completed.size > segmentLimit || (this.#cachedBytes > retainedBytes && this.#completed.size > 1)) {
          const [oldIndex, old] = this.#completed.entries().next().value!
          this.#completed.delete(oldIndex)
          this.#cachedBytes -= old.bytes
          void rm(old.path).catch(() => {})
        }
      }
      // Include the preceding segment at a sequential window boundary so
      // audio and video decode history overlap before publication resumes.
      const from = this.#completed.has(index - 1) ? Math.max(0, index - 1) : index
      const timeline = this.#source.timeline
      let seek = timeline.seekStarts?.[from] ?? timeline.starts[from]
      if (this.#source.seekMpegInput && seek > 0) {
        const controller = new AbortController()
        job.stop = () => controller.abort()
        seek = await this.#source.seekMpegInput(seek, controller.signal)
        if (this.#job !== job) return
      }
      for (const mode of videoModes.slice(videoModes.indexOf(this.#videoMode))) {
        let emitted = false
        const onSegment = async (segment: number, path: string) => {
          await publish(segment, path)
          if (!emitted && !copiesVideo(this.#source.quality) && this.#job === job) this.#onVideoBackend(mode)
          emitted = true
          if (this.#job === job) this.#videoMode = mode
        }
        const encode = (fillVideoGaps: boolean) => {
          const process = startSegmentJob(this.#executable, directory, this.#source, index, mode, from, seek, onSegment, fillVideoGaps)
          job.stop = process.stop
          return process.finished
        }
        try {
          await encode(false).catch((error: unknown) => {
            if (!(error instanceof MissingVideoCut) || this.#job !== job) throw error
            return encode(true)
          })
          if (emitted) break
        } catch (error) {
          if (emitted || this.#job !== job || mode === 'software') throw error
        }
        if (this.#job !== job) break
      }
    } catch (error) {
      if (error instanceof Error) failure = error
    } finally {
      clearTimeout(job.cancelTimer)
      if (this.#job === job) this.#job = undefined
      for (const waiter of job.waiters.values()) waiter.reject(failure)
      job.waiters.clear()
      await rm(directory, { recursive: true, force: true }).catch((error) =>
        console.warn('[Playback] Could not remove segment work files', { operationId: this.#id, error }))
    }
  }

  async close(reason: 'idle' | 'shutdown' = 'shutdown'): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    clearTimeout(this.#timer)
    this.#cancelJob()
    await Promise.all(this.#jobs)
    const directory = await this.#directory?.catch(() => undefined)
    if (directory) await rm(directory, { recursive: true, force: true })
    console.info('[Playback] Closed conversion session', {
      operationId: this.#id, reason, durationMs: Math.round(performance.now() - this.#started),
      windows: this.#windows, cancelledWindows: this.#cancelled, segments: this.#generated
    })
  }
}
