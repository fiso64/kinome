/**
 * Scrubbing thumbnails, made on demand as tile sheets of 10 × 10 frames one
 * interval apart, and cached until the file changes.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveLibraryPath } from './paths.service'
import { backgroundFfmpeg, ffmpeg } from './transcoding/runtime'

export const TRICKPLAY_WIDTH = 320
const TILES = 10
const INTERVAL_SECONDS = 10
const pending = new Map<string, Promise<string | undefined>>()

export function trickplayInfo(durationSeconds: number, width: number, height: number) {
  return {
    Width: TRICKPLAY_WIDTH, Height: Math.round(TRICKPLAY_WIDTH * height / width / 2) * 2, TileWidth: TILES, TileHeight: TILES,
    ThumbnailCount: Math.ceil(durationSeconds / INTERVAL_SECONDS), Interval: INTERVAL_SECONDS * 1000,
    // A sheet is about 300 KB for 1,000 seconds.
    Bandwidth: 2400
  }
}

/** The sheet with thumbnails index × 100 onwards, or undefined when it cannot be made or lies past the end. */
export async function trickplaySheet(source: string, durationSeconds: number, index: number): Promise<string | undefined> {
  const file = await stat(source).catch(() => null)
  const root = resolveLibraryPath(path.join('cache', 'trickplay'))
  const sheets = Math.ceil(durationSeconds / (INTERVAL_SECONDS * TILES * TILES))
  if (!ffmpeg || !file || !root || !Number.isSafeInteger(index) || index < 0 || index >= sheets) return undefined
  const key = createHash('md5').update(`${source}:${file.size}:${file.mtimeMs}`).digest('hex')
  const target = path.join(root, key, `${index}.jpg`)
  if (await stat(target).then(() => true, () => false)) return target
  let job = pending.get(target)
  if (!job) {
    job = render(source, target, index, durationSeconds).finally(() => pending.delete(target))
    pending.set(target, job)
  }
  return job
}

// Sheets are made one at a time, each thumbnail as background FFmpeg work.
let queue: Promise<unknown> = Promise.resolve()

function render(source: string, target: string, index: number, durationSeconds: number): Promise<string | undefined> {
  const job = queue.then(() => renderNow(source, target, index, durationSeconds))
  queue = job.catch(() => undefined)
  return job
}

/**
 * Each thumbnail seeks to its own keyframe and decodes that one frame on a
 * single thread. Decoding every keyframe of a stretch instead reads all of it,
 * gigabytes for a 4K remux, and took the CPU and memory playback needed.
 */
async function renderNow(source: string, target: string, index: number, durationSeconds: number): Promise<string | undefined> {
  await mkdir(path.dirname(target), { recursive: true })
  const frames = await mkdtemp(path.join(path.dirname(target), `.${index}-`))
  const partial = `${target}.${process.pid}.part.jpg`
  const started = performance.now()
  try {
    const first = index * TILES * TILES
    const count = Math.min(TILES * TILES, Math.ceil(durationSeconds / INTERVAL_SECONDS) - first)
    for (let i = 0; i < count; i++) {
      const error = await backgroundFfmpeg(['-threads', '1', '-skip_frame', 'nokey', '-noaccurate_seek', '-ss', String((first + i) * INTERVAL_SECONDS),
        '-i', source, '-an', '-sn', '-dn', '-frames:v', '1', '-vf', `scale=${TRICKPLAY_WIDTH}:-2:out_range=full,format=yuvj420p`,
        '-q:v', '4', path.join(frames, `${String(i).padStart(3, '0')}.jpg`)])
      if (error) throw new Error(error)
    }
    const error = await backgroundFfmpeg(['-i', path.join(frames, '%03d.jpg'), '-vf', `tile=${TILES}x${TILES}`, '-frames:v', '1', '-q:v', '4', partial])
    if (error) throw new Error(error)
    await rename(partial, target)
    console.debug('[Trickplay] Made a thumbnail sheet', { file: path.basename(source), index, ms: Math.round(performance.now() - started) })
    return target
  } catch (error) {
    await rm(partial, { force: true })
    console.warn('[Trickplay] Could not make a thumbnail sheet', { file: path.basename(source), index, error: (error as Error).message })
    return undefined
  } finally {
    await rm(frames, { recursive: true, force: true })
  }
}
