import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectMp4Segment } from './mp4-keyframes'
import type { PlaybackVideoBackend } from '@shared/playback-quality'
import { copiesVideo, lastSegmentInJob, startSegmentJob, type SegmentSource } from './segment-job'
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
  stop: () => void
  waiters: Map<number, SegmentWaiter>
}

export class PlaybackSession {
  readonly #executable: string
  readonly #source: SegmentSource
  readonly #onIdle: () => void
  readonly #onVideoBackend: (mode: PlaybackVideoBackend) => void
  readonly #completed = new Map<number, CachedSegment>()
  readonly #jobs = new Set<Promise<void>>()
  #cachedBytes = 0
  #directory?: Promise<string>
  #initialization?: Buffer
  #videoMode: PlaybackVideoBackend
  #job?: Job
  #timer?: ReturnType<typeof setTimeout>
  #closed = false

  constructor(executable: string, source: SegmentSource, onIdle: () => void, onVideoBackend: (mode: PlaybackVideoBackend) => void) {
    this.#executable = executable
    this.#source = source
    this.#onIdle = onIdle
    this.#onVideoBackend = onVideoBackend
    this.#videoMode = !copiesVideo(source.quality) && source.vaapiDevice ? 'vaapi' : 'software'
    this.touch()
  }

  touch(): void {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(this.#onIdle, retentionMs)
    this.#timer.unref()
  }

  async initialization(signal?: AbortSignal): Promise<Buffer> {
    this.touch()
    if (!this.#initialization) await this.segment(0, signal)
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
    for (const waiter of job.waiters.values()) waiter.reject(new DOMException('Playback moved to another segment', 'AbortError'))
    job.waiters.clear()
    job.stop()
  }

  async #segmentFrom(job: Job, index: number, signal?: AbortSignal): Promise<CachedSegment> {
    let waiter = job.waiters.get(index)
    if (!waiter) {
      waiter = Promise.withResolvers<CachedSegment>()
      job.waiters.set(index, waiter)
    }
    job.requests++
    const aborted = Promise.withResolvers<never>()
    const abort = () => aborted.reject(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    try {
      return await (signal ? Promise.race([waiter.promise, aborted.promise]) : waiter.promise)
    } finally {
      signal?.removeEventListener('abort', abort)
      job.requests--
      if (signal?.aborted && !job.requests && this.#job === job) this.#cancelJob()
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
            ? await inspectMp4Segment(path, !this.#initialization)
            : undefined
          if (this.#job !== job || this.#closed) return
          this.#initialization ??= fragment?.initialization
          const bytes = Bun.file(path).size
          cached = { path, bytes, offset: fragment?.offset ?? 0 }
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
      for (const mode of videoModes.slice(videoModes.indexOf(this.#videoMode))) {
        let emitted = false
        const process = startSegmentJob(this.#executable, directory, this.#source, index, mode, async (segment, path) => {
          await publish(segment, path)
          if (!emitted && !copiesVideo(this.#source.quality) && this.#job === job) this.#onVideoBackend(mode)
          emitted = true
          if (this.#job === job) this.#videoMode = mode
        })
        job.stop = process.stop
        try {
          await process.finished
          if (emitted) break
        } catch (error) {
          if (emitted || this.#job !== job || mode === 'software') throw error
        }
        if (this.#job !== job) break
      }
    } catch (error) {
      if (error instanceof Error) failure = error
    } finally {
      if (this.#job === job) this.#job = undefined
      for (const waiter of job.waiters.values()) waiter.reject(failure)
      job.waiters.clear()
      const cached = new Set(Array.from(this.#completed.values(), (segment) => segment.path))
      const entries = await readdir(directory).catch(() => [])
      await Promise.all(entries.map((entry) => {
        const path = join(directory, entry)
        if (!cached.has(path)) return rm(path, { force: true }).catch(() => {})
      }))
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    clearTimeout(this.#timer)
    this.#cancelJob()
    await Promise.all(this.#jobs)
    const directory = await this.#directory?.catch(() => undefined)
    if (directory) await rm(directory, { recursive: true, force: true })
  }
}
