/**
 * Scrubbing thumbnails, made on demand as tile sheets of 10 × 10 frames one
 * interval apart. A sheet decodes only keyframes, so it takes about a second,
 * and is cached until the file changes.
 */
import { createHash } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveLibraryPath } from './paths.service'
import { ffmpeg } from './transcoding/runtime'

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
    job = render(source, target, index).finally(() => pending.delete(target))
    pending.set(target, job)
  }
  return job
}

async function render(source: string, target: string, index: number): Promise<string | undefined> {
  await mkdir(path.dirname(target), { recursive: true })
  const span = TILES * TILES * INTERVAL_SECONDS
  const partial = `${target}.${process.pid}.part.jpg`
  const child = Bun.spawn([ffmpeg!, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-skip_frame', 'nokey',
    '-ss', String(index * span), '-t', String(span), '-i', source, '-an', '-sn', '-dn',
    '-vf', `fps=1/${INTERVAL_SECONDS},scale=${TRICKPLAY_WIDTH}:-2,tile=${TILES}x${TILES}`, '-frames:v', '1', '-q:v', '4', partial],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
  const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0 || !(await stat(partial).then((info) => info.size > 0, () => false))) {
    await rm(partial, { force: true })
    console.warn('[Trickplay] Could not make a thumbnail sheet', { file: path.basename(source), index, error: errors.trim().slice(0, 300) })
    return undefined
  }
  await rename(partial, target)
  return target
}
