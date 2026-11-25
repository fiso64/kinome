import { basename, dirname, extname, join, parse } from 'node:path'
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { availablePlaybackQualities, canConvertPlaybackAudio } from '@shared/playback-quality'
import { isMatroskaContainer, isSupportedVideoFile, type LocalMedia } from '@shared/local-media'
import { embeddedSubtitleFormats, isPlaybackLanguageList, normalizePlaybackLanguages, playbackLanguagePriorities, SUBTITLE_WINDOW_HEADER, SUBTITLE_WINDOW_SECONDS, type PlaybackDefaultScope, type PlaybackDefaultsEditor, type PlaybackLanguageDefaults, type PlaybackPreferences, type SubtitleFormat, type WebPlaybackInfo, type WebQueueItem, type WebSubtitle } from '@shared/web-playback'
import { getPresentItemLocation } from '../database/repositories/filesystem.repo'
import { getPlaybackDefaults, getPlaybackPreferences, writePlaybackDefault, writePlaybackPreferences } from '../database/repositories/playback-defaults.repo'
import { getPlaybackTrackLanguages } from '../database/repositories/local-media.repo'
import { getPlaybackPosition, savePlaybackPosition } from '../database/repositories/user.repo'
import { ensureUpToDate } from './account-filter.service'
import { recordPlayback } from './library.service'
import { getPlaybackSequence, handleFileStreamFast, resolvePlaybackSource, resolveStreamPath } from './playback.service'
import { find, getItemById } from './repository.service'
import { readSettings } from './settings.service'
import { keyframeReaderFor, playbackMetadata } from './transcoding'
import { readMatroskaSubtitleIndexes, readMatroskaAssWindow, readMatroskaPgsWindow, readMatroskaPacketWindow } from './transcoding/matroska-cues'
import { indexSupWindows } from './transcoding/sup-windows'
import { ffmpeg, ffprobe } from './transcoding/runtime'

const sidecarFormats: Readonly<Record<string, SubtitleFormat>> = {
  '.ass': 'ass', '.ssa': 'ass', '.srt': 'text', '.vtt': 'text', '.sup': 'pgs', '.idx': 'vobsub'
}
const subtitleOutput = {
  text: { mime: 'text/vtt; charset=utf-8', muxer: 'webvtt', codec: 'webvtt' },
  ass: { mime: 'text/plain; charset=utf-8', muxer: 'ass', codec: 'copy' },
  pgs: { mime: 'application/octet-stream', muxer: 'sup', codec: 'copy' },
  vobsub: { mime: 'application/octet-stream', muxer: 'matroska', codec: 'copy' }
} as const

function subtitleWindowResponse(body: string | ArrayBuffer | Uint8Array<ArrayBuffer> | Blob, type: string, window: string): Response {
  return new Response(body, { headers: {
    [SUBTITLE_WINDOW_HEADER]: window,
    'Content-Type': type,
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff'
  } })
}

const retention = 10 * 60_000
interface CachedExtraction {
  supWindows?: ReturnType<typeof indexSupWindows>
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

async function extract(key: string, signal: AbortSignal, run: (directory: string, signal: AbortSignal) => Promise<unknown>): Promise<string> {
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

async function ffmpegExtract(args: string[], signal: AbortSignal, input?: Blob): Promise<ArrayBuffer> {
  if (!ffmpeg) throw new Error('FFmpeg is unavailable')
  const process = Bun.spawn([ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-protocol_whitelist', input ? 'pipe' : 'file', ...args], {
    stdin: input ?? 'ignore', stdout: 'pipe', stderr: 'pipe', signal
  })
  const [code, errors, output] = await Promise.all([process.exited, new Response(process.stderr).text(), new Response(process.stdout).arrayBuffer()])
  if (code !== 0) throw new Error(errors.trim().slice(0, 512) || `FFmpeg exited with status ${code}`)
  return output
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
  const prefix = parse(path).name + '.'
  const files = new Set(entries.filter((entry) => entry.name.startsWith(prefix) && entry.isFile()).map((entry) => entry.name))
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
    const format = track.kind === 'subtitle' && track.codec ? embeddedSubtitleFormats[track.codec] : undefined
    if (!format) return []
    const { index, title, language, forced, hearingImpaired } = track
    return [{ id: `e-${index}`, format, title, language, forced, hearingImpaired, default: track.default }]
  })
}

export function getWebPlaybackQueue(itemId: string, accountId: string): WebQueueItem[] {
  ensureUpToDate(accountId)
  const sequence = getPlaybackSequence(itemId)
  if (!sequence || sequence.item.type !== 'file') return []
  const { item, files } = sequence
  const videos = files.filter((file) => file.id === item.id || isSupportedVideoFile(file.name))
  const queue = videos.some((file) => file.id === item.id) ? videos : [item]
  return queue.map(({ id, type, name, title, seasonNumber, episodeNumber }) =>
    ({ id, type, name, title, seasonNumber, episodeNumber }))
}

function availablePlaybackDefaults(itemId: string, accountId: string) {
  const [item] = find({
    where: { id: itemId }, userId: accountId, fields: ['id', 'type', 'name'],
    includeHidden: true, includeIgnored: true
  })
  if (!item || (item.type === 'file' && !isSupportedVideoFile(item.name))) return []
  return getPlaybackDefaults(itemId, accountId)
}

export { getPlaybackPreferences }

/** Saves an account's playback preferences. Returns false when a language list is malformed. */
export function savePlaybackPreferences(accountId: string, preferences: PlaybackPreferences): boolean {
  const languages = (value: string | null) => value?.trim() ? normalizePlaybackLanguages(value) : null
  const audioLanguage = languages(preferences.audioLanguage)
  const subtitleLanguage = languages(preferences.subtitleLanguage)
  if ([audioLanguage, subtitleLanguage].some((value) => value !== null && !isPlaybackLanguageList(value))) return false
  writePlaybackPreferences(accountId, { audioLanguage, subtitleLanguage, subtitles: preferences.subtitles })
  return true
}

/**
 * Language priorities for an external player: the saved defaults from the most
 * specific scope outward, then the account's preferred languages. A language
 * list cannot express forced-only subtitles, so the preferred subtitle language
 * applies only in the default subtitle mode.
 */
export function getExternalPlaybackLanguages(itemId: string, accountId: string): PlaybackLanguageDefaults {
  const audio = new Set<string>()
  const subtitles = new Set<string>()
  let inheritSubtitles = true
  const preferred = getPlaybackPreferences(accountId)
  const account = {
    audioLanguage: preferred.audioLanguage,
    subtitleLanguage: preferred.subtitles === 'default' ? preferred.subtitleLanguage : null
  }
  for (const { audioLanguage, subtitleLanguage } of [...availablePlaybackDefaults(itemId, accountId), account]) {
    for (const language of playbackLanguagePriorities(audioLanguage)) audio.add(language)
    if (subtitleLanguage === 'off') inheritSubtitles = false
    if (inheritSubtitles) {
      for (const language of playbackLanguagePriorities(subtitleLanguage)) subtitles.add(language)
    }
  }
  return {
    audioLanguage: [...audio].join(',') || null,
    subtitleLanguage: [...subtitles].join(',') || null
  }
}

export async function getItemPlaybackDefault(itemId: string, accountId: string): Promise<PlaybackDefaultsEditor> {
  const [target] = availablePlaybackDefaults(itemId, accountId)
  if (!target) return { defaults: null, languages: null }
  const defaults = { audioLanguage: target.audioLanguage, subtitleLanguage: target.subtitleLanguage }
  if (target.scope !== 'file') return { defaults, languages: null }

  const languages = { audio: [] as string[], subtitles: [] as string[] }
  const source = await resolvePlaybackSource(itemId, accountId)
  if (source) {
    for (const { kind, language } of getPlaybackTrackLanguages(source.locationId)) {
      languages[kind === 'audio' ? 'audio' : 'subtitles'].push(language)
    }
    for (const track of await sidecarTracks(source.path)) {
      if (track.language && isPlayableSidecar(track)) languages.subtitles.push(track.language)
    }
  }
  return { defaults, languages }
}

function isPlayableSidecar(track: WebSubtitle): boolean {
  return Boolean(ffmpeg || track.format !== 'text' || track.title?.toLowerCase().endsWith('.vtt'))
}

export function saveItemPlaybackDefault(
  itemId: string, accountId: string, changes: Partial<PlaybackLanguageDefaults>, scope?: PlaybackDefaultScope
): boolean {
  const targets = availablePlaybackDefaults(itemId, accountId)
  const target = scope ? targets.find((entry) => entry.scope === scope) : targets[0]
  if (!target) return false
  writePlaybackDefault(accountId, target, changes)
  return true
}

export async function getWebPlaybackInfo(itemId: string, accountId: string): Promise<WebPlaybackInfo | null> {
  const path = await resolveStreamPath(itemId, accountId)
  if (!path) return null
  const [settings, sidecars, record] = await Promise.all([
    readSettings(), sidecarTracks(path),
    ffprobe ? playbackMetadata(ffprobe, path).catch(() => null) : null
  ])
  const media = await record?.media ?? null
  // A failed live probe can still allow original playback and locally stored track descriptions.
  const description = media ?? (getItemById(itemId) as { localMedia?: LocalMedia } | null)?.localMedia ?? null
  const qualities = availablePlaybackQualities(settings).filter((quality) =>
    quality !== 'remux' || !media?.container || keyframeReaderFor(media.container))
  const embedded = ffmpeg && media ? embeddedTracks(media) : []
  return {
    fontRevision: media?.fonts?.length ? record?.revision : undefined,
    media: description, subtitles: embedded.concat(sidecars.filter(isPlayableSidecar)),
    qualities, audioConversion: canConvertPlaybackAudio(qualities, settings.playbackConversion),
    position: getPlaybackPosition(itemId, accountId),
    languageDefaults: getPlaybackDefaults(itemId, accountId).map(({ scope, audioLanguage, subtitleLanguage }) =>
      ({ scope, audioLanguage, subtitleLanguage })),
    preferences: getPlaybackPreferences(accountId)
  }
}

let reportWindow = 0
let reportsInWindow = 0

/** Record a web player diagnostic. Phones and tablets have no accessible console. */
export function logPlayerReport(
  accountId: string, userAgent: string | null, level: 'info' | 'warn' | 'error', message: string, details: Record<string, unknown>
): void {
  const now = performance.now()
  if (now - reportWindow > 60_000) {
    reportWindow = now
    reportsInWindow = 0
  }
  if (++reportsInWindow > 60 || JSON.stringify(details).length > 4096) return
  console[level](`[Player] ${message}`, { accountId, userAgent: userAgent?.slice(0, 256), ...details })
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
  const path = await resolveStreamPath(itemId, accountId)
  if (!path) return missing()
  try {
    let asset: string
    let type: string
    let cacheControl = 'private, no-cache'
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
          const { codec, muxer } = subtitleOutput.text
          asset = join(await extract(JSON.stringify([source, file.size, file.mtimeMs, file.ctimeMs]), request.signal, (dir, signal) =>
            ffmpegExtract(['-i', source, '-map', '0:s:0', '-c:s', codec, '-f', muxer, join(dir, 'track')], signal)), 'track')
        }
      } else return missing()
      type = subtitleOutput[track.format].mime
    } else {
      if (!ffprobe || !ffmpeg) return missing()
      const record = await playbackMetadata(ffprobe, path)
      const media = await record.media
      if (id === 'font' && /^\d+$/.test(part) && media.fonts?.includes(Number(part))) {
        if (new URL(request.url).searchParams.get('v') === record.revision) {
          cacheControl = 'private, max-age=31536000, immutable'
        }
        const fonts = media.fonts
        const directory = await extract(record.key + ':fonts', request.signal, (dir, signal) =>
          ffmpegExtract([...fonts.flatMap((index) => [`-dump_attachment:${index}`, join(dir, String(index))]),
            '-i', path, '-map', '0:v:0', '-c', 'copy', '-frames:v', '0', '-f', 'null', '-'], signal))
        asset = join(directory, String(Number(part)))
        type = 'application/octet-stream'
      } else if (part === 'track') {
        const track = embeddedTracks(media).find((candidate) => candidate.id === id)
        if (!track) return missing()
        const requestedWindow = new URL(request.url).searchParams.get('window')
        const window = request.method === 'GET' && !request.headers.has('range') ? requestedWindow : null
        const { mime: contentType, codec, muxer } = subtitleOutput[track.format]
        // A subtitle may already be visible at the first playable sample. Without
        // clipping it, FFmpeg shifts later cues to keep the first timestamp positive.
        const clipPreroll = (media.startSeconds ?? 0) > 0
          ? ['-bsf:s', "setts=pts='max(PTS,0)':dts='max(DTS,0)':duration='max(0,DURATION+min(0,PTS))'"] : []
        if (window !== null && isMatroskaContainer(media.container)) {
          const start = Number(window) * SUBTITLE_WINDOW_SECONDS * 1000
          const end = start + SUBTITLE_WINDOW_SECONDS * 1000
          if (!/^\d+$/.test(window) || !Number.isSafeInteger(end)) return new Response(null, { status: 400 })
          record.subtitleIndexes ??= readMatroskaSubtitleIndexes(path, media.tracks, media.startSeconds).catch(() => new Map())
          const indexes = await record.subtitleIndexes
          request.signal.throwIfAborted()
          const streamIndex = Number(id.slice(2))
          const index = indexes.get(streamIndex)
          if (index?.format === track.format) {
            try {
              let body: string | ArrayBuffer | Uint8Array<ArrayBuffer>
              if ('header' in index) {
                body = await readMatroskaAssWindow(path, index, start, end, request.signal)
              } else if (index.format === 'pgs') {
                body = new Uint8Array(await readMatroskaPgsWindow(path, index, start, end, request.signal))
              } else {
                const packets = new Uint8Array(await readMatroskaPacketWindow(path, index, start, end, request.signal))
                if (packets.length) {
                  body = await ffmpegExtract(['-copyts', ...(index.sourceStartMs ? ['-itsoffset', String(-index.sourceStartMs / 1000)] : []), '-f', 'matroska', '-i', 'pipe:0', '-c:s', codec,
                    ...clipPreroll, '-f', muxer, 'pipe:1'], request.signal, new Blob([packets]))
                } else {
                  body = index.emptyTrack
                }
              }
              return subtitleWindowResponse(body, contentType, window)
            } catch (error) {
              request.signal.throwIfAborted()
              indexes.delete(streamIndex)
              console.debug('[Subtitles] Could not read indexed subtitle cues, using extraction', { itemId, id, error })
            }
          }
        }
        const key = record.key + ':' + id
        const directory = await extract(key, request.signal, async (dir, signal) => {
          console.debug('[Subtitles] Extracting full embedded track', { itemId, id, format: track.format, windowRequested: requestedWindow !== null })
          await ffmpegExtract(['-i', path, '-map', '0:' + id.slice(2), '-map_metadata', '-1',
            '-c:s', codec, ...clipPreroll, '-f', muxer, join(dir, 'track')], signal)
        })
        asset = join(directory, 'track')
        type = contentType
        const cached = extractions.get(key)
        if (track.format === 'pgs' && cached && window !== null && /^\d+$/.test(window)) {
          cached.supWindows ??= indexSupWindows(asset).catch(() => undefined)
          const range = await cached.supWindows
          request.signal.throwIfAborted()
          if (range) return subtitleWindowResponse(Bun.file(asset).slice(...range(Number(window))), contentType, window)
        }
      } else return missing()
    }
    const file = await lstat(asset).catch(() => null)
    if (!file?.isFile() || !file.size) return missing()
    const response = handleFileStreamFast(request, asset, file.size, type)
    response.headers.set('Cache-Control', cacheControl)
    if (id === 'font') response.headers.set('Vary', 'Origin')
    response.headers.set('X-Content-Type-Options', 'nosniff')
    return response
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 })
    console.warn('[Subtitles] Could not prepare subtitle asset', { itemId, id, part, error })
    return new Response('Kinome could not prepare the subtitle asset.', { status: 422 })
  }
}
