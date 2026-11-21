import { Blob as BufferBlob } from 'node:buffer'
import {
  availablePlaybackQualities, normalizePlaybackEncoding, type PlaybackEncodingPreferences,
  type PlaybackQuality, type PlaybackVideoBackend, type PlaybackWorkerHealth
} from '@shared/playback-quality'
import * as accountFilters from './account-filter.service'
import { readSettings } from './settings.service'
import { handleFileStreamFast, resolveStreamPath } from './playback.service'
import { openPlaybackSource, PlaybackSession, segmentPlaylist } from './transcoding'
import { copiesVideo, type SegmentQuality } from './transcoding/segment-job'
import { conversionAvailable, conversionEnabled, ffmpeg, ffprobe, getVaapiDevice } from './transcoding/runtime'

const hlsType = 'application/vnd.apple.mpegurl'
const clientPattern = /^[a-zA-Z0-9_-]{1,128}$/
export const hlsSegmentPattern = /^segment-(\d+)\.(ts|m4s)$/

interface Viewer {
  session: PlaybackSession
  fragmented: boolean
  timeline: Awaited<ReturnType<typeof openPlaybackSource>>['timeline']
}

const viewers = new Map<string, Promise<Viewer>>()
let lastFailureLog = -Infinity
let lastVideoBackend: PlaybackVideoBackend | undefined

export async function closeTranscodingSessions(): Promise<void> {
  const active = [...viewers.values()]
  viewers.clear()
  await Promise.allSettled(active.map(async (viewer) => (await viewer).session.close()))
}

export async function getWorkerStatus(): Promise<PlaybackWorkerHealth> {
  if (!conversionEnabled) return { status: 'unconfigured', detail: 'Playback conversion is disabled on this server.' }
  if (!conversionAvailable) {
    return { status: 'unready', detail: 'Kinome needs FFmpeg and FFprobe on its PATH to convert playback.' }
  }
  const settings = await readSettings()
  if (settings.playbackConversion === 'off') {
    return { status: 'unconfigured', detail: 'Playback conversion is turned off in settings.' }
  }
  if (settings.playbackConversion === 'remux') {
    return { status: 'ready', detail: 'FFmpeg is ready to remux media.' }
  }
  const softwareOnly = settings.playbackEncoding?.hardwareAcceleration === 'software'
  const vaapiDevice = softwareOnly ? undefined : await getVaapiDevice()
  return {
    status: 'ready',
    detail: vaapiDevice ? 'VA-API passed a hardware encode test.'
      : softwareOnly ? 'Software encoding is selected.' : 'Software encoding is available. No usable VA-API device was detected.',
    videoBackend: vaapiDevice ? 'vaapi' : 'software',
    vaapiDevice,
    lastVideoBackend
  }
}

function getViewer(path: string, accountId: string, itemId: string, quality: SegmentQuality,
  client: string, encoding: PlaybackEncodingPreferences, audioIndex?: number, browser = false): Promise<Viewer> {
  const key = JSON.stringify([accountId, itemId, path, quality, client, audioIndex, browser])
  let viewer = viewers.get(key)
  if (viewer) return viewer
  viewer = Promise.all([
    openPlaybackSource(ffprobe!, path, quality, encoding, audioIndex, browser),
    !copiesVideo(quality) && encoding.hardwareAcceleration === 'auto' ? getVaapiDevice() : undefined
  ]).then(([source, vaapiDevice]) => {
    source.vaapiDevice = vaapiDevice
    const session = new PlaybackSession(ffmpeg!, source, () => {
      if (viewers.get(key) === viewer) viewers.delete(key)
      void session.close().catch((error) => console.warn('[Playback] Could not clean up a playback session', { itemId, error }))
    }, (mode) => {
      lastVideoBackend = mode
    })
    return { session, fragmented: source.fragmented, timeline: source.timeline }
  })
  viewers.set(key, viewer)
  void viewer.catch(() => {
    if (viewers.get(key) === viewer) viewers.delete(key)
  })
  return viewer
}

function hlsError(status: number, detail: string): Response {
  return new Response(detail, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

export async function serveHls(
  request: Request, itemId: string, quality: PlaybackQuality | 'audio', resource: string, accountId: string
): Promise<Response> {
  if (!conversionAvailable) return hlsError(503, (await getWorkerStatus()).detail)
  const isPlaylist = resource === 'master.m3u8'
  const isInit = resource === 'init.mp4'
  const segment = hlsSegmentPattern.exec(resource)
  const settings = await readSettings()
  const params = new URL(request.url).searchParams
  const browser = params.get('web') === '1'
  const available = availablePlaybackQualities(settings)
  const qualityAllowed = quality === 'audio'
    ? browser && available.includes('remux') && settings.playbackConversion !== 'remux'
    : quality !== 'original' && available.includes(quality)
  if (!qualityAllowed || quality === 'original' || (!isPlaylist && !isInit && !segment)) {
    return hlsError(404, 'This playback quality or resource is unavailable.')
  }

  const client = isPlaylist ? crypto.randomUUID() : params.get('clientId')
  const audio = params.get('audio')
  const audioIndex = audio === null ? undefined : Number(audio)
  if (!client || !clientPattern.test(client) ||
    (audio !== null && (!/^\d+$/.test(audio) || !Number.isSafeInteger(audioIndex)))) {
    return hlsError(400, 'Invalid playback parameters.')
  }

  accountFilters.ensureUpToDate(accountId)
  const path = await resolveStreamPath(itemId, accountId)
  if (!path) return hlsError(404, 'File not found.')

  try {
    const encoding = settings.playbackEncoding ?? normalizePlaybackEncoding()
    const { session, timeline, fragmented } = await getViewer(path, accountId, itemId, quality, client, encoding, audioIndex, browser)
    const extension = fragmented ? 'm4s' : 'ts'
    if (isPlaylist) {
      const query = new URLSearchParams({ clientId: client })
      const token = params.get('token')
      if (token) query.set('token', token)
      if (audio !== null) query.set('audio', audio)
      if (browser) query.set('web', '1')
      const suffix = query.toString()
      const playlist = request.method === 'HEAD' ? null : segmentPlaylist(
        timeline, (index) => `segment-${index}.${extension}?${suffix}`, fragmented ? `init.mp4?${suffix}` : undefined, browser
      )
      return new Response(playlist, { headers: { 'Content-Type': hlsType, 'Cache-Control': 'private, no-store' } })
    }

    let data: BufferBlob | Bun.BunFile
    if (isInit) {
      if (!fragmented) return hlsError(404, 'Initialization not found.')
      data = new BufferBlob([await session.initialization(request.signal)])
    } else {
      const index = Number(segment![1])
      if (segment![2] !== extension || !Number.isSafeInteger(index) || index >= timeline.starts.length) {
        return hlsError(404, 'Segment not found.')
      }
      const cached = await session.segment(index, request.signal)
      const file = Bun.file(cached.path)
      data = cached.offset ? file.slice(cached.offset, cached.bytes) : file
    }
    const response = handleFileStreamFast(data, data.size, fragmented ? 'video/mp4' : 'video/mp2t',
      request.headers.get('range'), { method: request.method })
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch (error) {
    const now = performance.now()
    if (!request.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError') &&
      now - lastFailureLog >= 30_000) {
      lastFailureLog = now
      console.warn('[Playback] Could not convert playback', { itemId, quality, resource, error })
    }
    return isPlaylist
      ? hlsError(422, 'Kinome could not prepare this file for the requested playback quality.')
      : hlsError(503, 'Kinome could not generate this playback segment. Retry the request.')
  }
}
