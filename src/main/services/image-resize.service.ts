/**
 * Scaled copies of stored artwork for clients that ask for a size. Widths are
 * rounded up to a few steps so the cache stays small, and a copy is never
 * larger than its source. Without FFmpeg, or if scaling fails, the stored
 * file is served.
 */
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveLibraryPath } from './paths.service'
import { ffmpeg } from './transcoding/runtime'

const WIDTHS = [160, 320, 480, 720, 1080, 1440, 1920]
const pending = new Map<string, Promise<string>>()

/** The cache key is the image's version tag, so a replaced image gets new copies. */
export async function resizedImage(source: string, tag: string, width: number): Promise<string> {
  const step = WIDTHS.find((candidate) => candidate >= width)
  const directory = resolveLibraryPath(path.join('cache', 'images'))
  if (!ffmpeg || !step || !directory || !Number.isFinite(width) || width <= 0) return source
  const extension = path.extname(source).toLowerCase() === '.png' ? '.png' : '.jpg'
  const target = path.join(directory, `${tag}-${step}${extension}`)
  if (await stat(target).then(() => true, () => false)) return target
  const key = target
  let job = pending.get(key)
  if (!job) {
    job = scale(source, target, step).finally(() => pending.delete(key))
    pending.set(key, job)
  }
  return job
}

async function scale(source: string, target: string, width: number): Promise<string> {
  await mkdir(path.dirname(target), { recursive: true })
  const partial = `${target}.${process.pid}.part${path.extname(target)}`
  const process_ = Bun.spawn([ffmpeg!, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source,
    '-vf', `scale='min(iw,${width})':-2`, '-frames:v', '1', ...(target.endsWith('.jpg') ? ['-q:v', '3'] : []), partial],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
  const [code, errors] = await Promise.all([process_.exited, new Response(process_.stderr).text()])
  if (code !== 0) {
    await rm(partial, { force: true })
    console.warn('[Images] Could not scale artwork, serving the original', { source: path.basename(source), width, error: errors.trim().slice(0, 300) })
    return source
  }
  await rename(partial, target)
  return target
}
