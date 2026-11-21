import { basename, dirname, extname, join, parse } from 'node:path'
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { availablePlaybackQualities } from '@shared/playback-quality'
import type { LocalMedia } from '@shared/local-media'
import type { SubtitleFormat, WebPlaybackInfo, WebSubtitle } from '@shared/web-playback'
import { getPresentItemLocation } from '../database/repositories/filesystem.repo'
import { getPlaybackPosition, savePlaybackPosition } from '../database/repositories/user.repo'
import { ensureUpToDate } from './account-filter.service'
import { recordPlayback } from './library.service'
import { handleFileStreamFast, resolveStreamPath } from './playback.service'
import { getItemById } from './repository.service'
import { readSettings } from './settings.service'
import { playbackMetadata } from './transcoding'
import { ffmpeg, ffprobe } from './transcoding/runtime'

const sidecarFormats: Readonly<Record<string, SubtitleFormat>> = {
  '.ass': 'ass', '.ssa': 'ass', '.srt': 'text', '.vtt': 'text', '.sup': 'pgs', '.idx': 'vobsub'
}
const embeddedFormats: Readonly<Record<string, SubtitleFormat>> = {
  ass: 'ass', ssa: 'ass', subrip: 'text', webvtt: 'text', mov_text: 'text', text: 'text',
  hdmv_pgs_subtitle: 'pgs', dvd_subtitle: 'vobsub'
}
const encodedSubtitles = {
  text: { muxer: 'webvtt', codec: 'webvtt' },
  ass: { muxer: 'ass', codec: 'copy' },
  pgs: { muxer: 'sup', codec: 'copy' },
  vobsub: { muxer: 'matroska', codec: 'copy' }
} as const
const mime: Record<SubtitleFormat, string> = {
  text: 'text/vtt; charset=utf-8', ass: 'text/plain; charset=utf-8',
  pgs: 'application/octet-stream', vobsub: 'application/octet-stream'
}

const retention = 10 * 60_000
interface CachedExtraction {
  directory: Promise<string>
  controller: AbortController
  requests: number
  completed: boolean
  timer?: ReturnType<typeof setTimeout>
}
const extractions = new Map<string, CachedExtraction>()

async function discard(entry: CachedExtraction): Promise<void> {
  clearTimeout(entry.timer)
  entry.controller.abort()
  const path = await entry.directory.catch(() => undefined)
  if (path) await rm(path, { recursive: true, force: true })
}

export async function closeSubtitleExtractions(): Promise<void> {
  const entries = [...extractions.values()]
  extractions.clear()
  await Promise.allSettled(entries.map(discard))
}

async function extract(key: string, signal: AbortSignal, run: (directory: string, signal: AbortSignal) => Promise<void>): Promise<string> {
  signal.throwIfAborted()
  let cached = extractions.get(key)
  if (!cached) {
    const controller = new AbortController()
    const directory = mkdtemp(join(tmpdir(), 'kinome-subtitles-')).then(async (path) => {
      try {
        controller.signal.throwIfAborted()
        await run(path, controller.signal)
        return path
      } catch (error) {
        await rm(path, { recursive: true, force: true })
        throw error
      }
    })
    const entry = { directory, controller, requests: 0, completed: false }
    extractions.set(key, entry)
    void directory.then(() => { entry.completed = true }, () => {
      if (extractions.get(key) === entry) extractions.delete(key)
    })
    cached = entry
  }
  const entry = cached
  entry.requests++
  clearTimeout(entry.timer)
  const cancelled = Promise.withResolvers<never>()
  const abort = () => cancelled.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([entry.directory, cancelled.promise])
  } finally {
    signal.removeEventListener('abort', abort)
    if (--entry.requests === 0 && extractions.get(key) === entry) {
      // Keep completed assets for track switches and range requests. Stop an
      // abandoned extraction after giving replacement requests time to join.
      entry.timer = setTimeout(() => {
        extractions.delete(key)
        void discard(entry).catch((error) => console.warn('[Subtitles] Cache cleanup failed', error))
      }, entry.completed ? retention : 500)
      entry.timer.unref()
    }
  }
}

async function ffmpegExtract(args: string[], signal: AbortSignal): Promise<void> {
  if (!ffmpeg) throw new Error('FFmpeg is unavailable')
  const process = Bun.spawn([ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-protocol_whitelist', 'file', ...args], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', signal
  })
  const [code, errors] = await Promise.all([process.exited, new Response(process.stderr).text()])
  if (code !== 0) throw new Error(errors.trim().slice(0, 512) || `FFmpeg exited with status ${code}`)
}

function sidecarTrack(path: string, filename: string): WebSubtitle | undefined {
  if (basename(filename) !== filename) return
  const { name, ext } = parse(filename)
  const format = sidecarFormats[ext.toLowerCase()]
  const stem = parse(path).name
  if (!format || (name !== stem && !name.startsWith(stem + '.'))) return
  const suffix = name.slice(stem.length + 1).toLowerCase().split('.')
  return {
    id: 's-' + Buffer.from(filename).toString('base64url'), format, sidecar: true, title: filename,
    language: suffix.find((part) => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(part) && part !== 'sdh'),
    default: name === stem, forced: suffix.includes('forced'),
    hearingImpaired: suffix.includes('sdh') || (suffix.length > 1 && suffix.includes('hi'))
  }
}

async function sidecarTracks(path: string): Promise<WebSubtitle[]> {
  const entries = await readdir(dirname(path), { withFileTypes: true }).catch(() => [])
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name))
  const subtitles = [...files].flatMap((filename) => {
    const track = sidecarTrack(path, filename)
    if (!track) return []
    if (track.format === 'vobsub' && !files.has(sidecarSubName(filename))) return []
    return [track]
  })
  return subtitles.sort((a, b) => a.title!.localeCompare(b.title!))
}

function sidecarSubName(filename: string): string {
  return parse(filename).name + (extname(filename) === '.IDX' ? '.SUB' : '.sub')
}

function embeddedTracks(media: LocalMedia | null): WebSubtitle[] {
  return (media?.tracks ?? []).flatMap((track) => {
    const format = track.kind === 'subtitle' && track.codec ? embeddedFormats[track.codec] : undefined
    if (!format) return []
    const { index, title, language, forced, hearingImpaired } = track
    return [{ id: `e-${index}`, format, title, language, forced, hearingImpaired, default: track.default }]
  })
}

async function visibleSource(itemId: string, accountId: string): Promise<string | null> {
  ensureUpToDate(accountId)
  return resolveStreamPath(itemId, accountId)
}

export async function getWebPlaybackInfo(itemId: string, accountId: string): Promise<WebPlaybackInfo | null> {
  const path = await visibleSource(itemId, accountId)
  if (!path) return null
  const [settings, sidecars, media] = await Promise.all([
    readSettings(), sidecarTracks(path),
    ffprobe ? playbackMetadata(ffprobe, path).then((record) => record.media).catch(() => null) : null
  ])
  // A failed live probe can still allow original playback and locally stored track descriptions.
  const description = media ?? (getItemById(itemId) as { localMedia?: LocalMedia } | null)?.localMedia ?? null
  const qualities = availablePlaybackQualities(settings)
  const embedded = ffmpeg && media ? embeddedTracks(media) : []
  return {
    media: description, subtitles: embedded.concat(sidecars.filter((track) => ffmpeg ||
      track.format !== 'text' || track.title!.toLowerCase().endsWith('.vtt'))),
    qualities, audioConversion: qualities.includes('remux') && settings.playbackConversion !== 'remux',
    position: getPlaybackPosition(itemId, accountId)
  }
}

export async function updateWebPlayback(itemId: string, accountId: string, position: number, completed: boolean): Promise<boolean> {
  // Progress only needs a visible file identity. Avoid accessing the disk on every update.
  ensureUpToDate(accountId)
  if (!getPresentItemLocation(itemId, 'file', accountId)) return false
  if (completed) {
    savePlaybackPosition(itemId, accountId, 0)
    await recordPlayback(itemId, accountId)
  } else {
    savePlaybackPosition(itemId, accountId, position)
  }
  return true
}

export async function serveSubtitle(
  request: Request, itemId: string, id: string, part: string, accountId: string
): Promise<Response> {
  const missing = () => new Response('Subtitle asset not found', { status: 404 })
  const path = await visibleSource(itemId, accountId)
  if (!path) return missing()
  try {
    let asset: string
    let type: string
    if (/^s-[\w-]+$/.test(id)) {
      const filename = Buffer.from(id.slice(2), 'base64url').toString()
      const track = sidecarTrack(path, filename)
      if (!track) return missing()
      const source = join(dirname(path), filename)
      const file = await lstat(source).catch(() => null)
      if (!file?.isFile()) return missing()
      if (part === 'idx' && track.format === 'vobsub') {
        asset = source
      } else if (part === 'track') {
        asset = track.format === 'vobsub' ? join(dirname(path), sidecarSubName(filename)) : source
        if (track.format === 'text' && extname(source).toLowerCase() !== '.vtt') {
          asset = join(await extract(JSON.stringify([source, file.size, file.mtimeMs, file.ctimeMs]), request.signal, (dir, signal) =>
            ffmpegExtract(['-i', source, '-map', '0:s:0', '-c:s', 'webvtt', '-f', 'webvtt', join(dir, 'track')], signal)), 'track')
        }
      } else return missing()
      type = mime[track.format]
    } else {
      if (!ffprobe || !ffmpeg) return missing()
      const record = await playbackMetadata(ffprobe, path)
      const media = await record.media
      if (id === 'font' && /^\d+$/.test(part) && media.fonts?.includes(Number(part))) {
        const fonts = media.fonts
        const directory = await extract(record.key + ':fonts', request.signal, (dir, signal) =>
          ffmpegExtract([...fonts.flatMap((index) => [`-dump_attachment:${index}`, join(dir, String(index))]),
            '-i', path, '-map', '0:v:0', '-c', 'copy', '-frames:v', '0', '-f', 'null', '-'], signal))
        asset = join(directory, String(Number(part)))
        type = 'application/octet-stream'
      } else if (part === 'track') {
        const track = embeddedTracks(media).find((candidate) => candidate.id === id)
        if (!track) return missing()
        const { codec, muxer } = encodedSubtitles[track.format]
        const directory = await extract(record.key + ':' + id, request.signal, (dir, signal) => ffmpegExtract([
          '-i', path, '-map', '0:' + id.slice(2), '-map_metadata', '-1', '-c:s', codec, '-f', muxer, join(dir, 'track')
        ], signal))
        asset = join(directory, 'track')
        type = mime[track.format]
      } else return missing()
    }
    const file = await lstat(asset).catch(() => null)
    if (!file?.isFile() || !file.size) return missing()
    const response = handleFileStreamFast(Bun.file(asset), file.size, type, request.headers.get('range'),
      { method: request.method })
    response.headers.set('Cache-Control', 'private, no-cache')
    response.headers.set('X-Content-Type-Options', 'nosniff')
    return response
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 })
    console.warn('[Subtitles] Could not prepare subtitle asset', { itemId, id, part, error })
    return new Response('Kinome could not prepare the subtitle asset.', { status: 422 })
  }
}
