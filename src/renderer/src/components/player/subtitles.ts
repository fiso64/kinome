import type JassubRenderer from 'jassub'
import { subtitleUrl } from '@lib/services/web-playback.service'
import type { LocalMediaTrack } from '@shared/local-media'
import { ASS_WINDOW_HEADER, ASS_WINDOW_SECONDS, type WebSubtitle } from '@shared/web-playback'

export interface SubtitleRenderer {
  setDelay(seconds: number): void
  setPosition?(percent: number): void
}

interface SubtitleOptions {
  itemId: string
  track: WebSubtitle
  video: HTMLVideoElement
  container: HTMLElement
  source?: LocalMediaTrack
  fonts: number[]
  delay: number
  signal: AbortSignal
  onReady: () => void
  onError: () => void
}

export async function openSubtitle(options: SubtitleOptions): Promise<SubtitleRenderer> {
  const { track, video, itemId, signal, delay, container, source, fonts, onReady, onError } = options
  const url = subtitleUrl(itemId, track.id)
  if (track.format === 'text') return textTrack(video, url, track.language, delay, signal, onReady, onError)
  if (track.format === 'ass') {
    const firstWindow = assWindow(video.currentTime - delay)
    const windows = track.sidecar ? undefined : assWindows(url, signal)
    const [{ default: JASSUB }, initial] = await Promise.all([
      import('jassub'), windows?.load(firstWindow) ?? fetchAss(url, signal)
    ])
    signal.throwIfAborted()
    // Give libass the source storage dimensions across resolution switches. The
    // overlay still renders at the size of the displayed frame on this screen.
    class StyledSubtitles extends JASSUB {
      override manualRender(frame: Parameters<JassubRenderer['manualRender']>[0], repaint?: boolean) {
        if (source?.width && source.height &&
          Math.abs((source.width / source.height) / (frame.width / frame.height) - 1) < 0.025) {
          frame = { ...frame, width: source.width, height: source.height }
        }
        return super.manualRender(frame, repaint)
      }

      override resize(repaint?: boolean) {
        const { videoWidth, videoHeight, clientWidth, clientHeight } = video
        if (!videoWidth || !videoHeight || !clientWidth || !clientHeight) return super.resize(repaint)
        const ratio = videoWidth / videoHeight
        const height = Math.round(Math.min(clientHeight, clientWidth / ratio) * devicePixelRatio)
        const capped = Math.min(2160, height)
        return super.resize(repaint, Math.round(capped * ratio), capped)
      }
    }
    const canvas = document.createElement('canvas')
    canvas.className = 'subtitle-canvas'
    container.append(canvas)
    let renderer: JassubRenderer | undefined
    const close = () => {
      canvas.remove()
      void renderer?.destroy().catch(() => {})
    }
    signal.addEventListener('abort', close, { once: true })
    try {
      renderer = new StyledSubtitles({
        video, canvas, subContent: initial.content, timeOffset: -delay, queryFonts: false,
        fonts: fonts.map((index) => subtitleUrl(itemId, 'font', String(index)))
      })
      await renderer.ready
      signal.throwIfAborted()
    } catch (error) {
      signal.removeEventListener('abort', close)
      if (!signal.aborted) close()
      throw error
    }
    const active = renderer
    function repaint() {
      if (video.paused && video.videoWidth) {
        void active.manualRender({
          expectedDisplayTime: performance.now(), mediaTime: video.currentTime,
          width: video.videoWidth, height: video.videoHeight
        }, true).catch(() => {})
      }
    }
    const follow = windows && initial.windowed
      ? followAssWindows(video, canvas, active, windows, firstWindow, signal, repaint, onReady, onError)
      : undefined
    video.addEventListener('seeked', repaint, { signal })
    const setDelay = (seconds: number) => {
      active.timeOffset = -seconds
      follow?.()
      repaint()
    }
    setDelay(delay)
    onReady()
    return { setDelay }
  }

  const { PgsRenderer, VobSubRenderer } = await import('libbitsub')
  signal.throwIfAborted()
  const canvas = document.createElement('canvas')
  canvas.className = 'subtitle-canvas'
  const settings = {
    video, container, canvas, subUrl: url, timeOffset: -delay,
    onLoaded: () => { if (!signal.aborted) onReady() },
    onError: () => { if (!signal.aborted) onError() }
  }
  const renderer = track.format === 'pgs' ? new PgsRenderer(settings) : new VobSubRenderer({
    ...settings, ...(track.sidecar
      ? { idxUrl: subtitleUrl(itemId, track.id, 'idx') }
      : { fileName: 'subtitle.mks' })
  })
  const close = () => {
    renderer.dispose()
    canvas.remove()
  }
  signal.addEventListener('abort', close, { once: true })
  return { setDelay: (seconds) => { renderer.timeOffset = -seconds } }
}

const assWindow = (seconds: number) => Math.floor(Math.max(0, seconds) / ASS_WINDOW_SECONDS)

async function fetchAss(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error('Could not load ASS subtitles')
  return { content: await response.text(), windowed: response.headers.has(ASS_WINDOW_HEADER) }
}

function assWindows(url: string, signal: AbortSignal) {
  const requests = new Map<number, {
    controller: AbortController
    content: ReturnType<typeof fetchAss>
  }>()
  return {
    load(window: number) {
      const existing = requests.get(window)
      if (existing) return existing.content
      const controller = new AbortController()
      const request = {
        controller,
        content: fetchAss(`${url}&window=${window}`, AbortSignal.any([signal, controller.signal])).catch((error) => {
          if (requests.get(window) === request) requests.delete(window)
          throw error
        })
      }
      requests.set(window, request)
      return request.content
    },
    keep(window: number) {
      for (const [index, request] of requests) {
        if (Math.abs(index - window) <= 1) continue
        requests.delete(index)
        request.controller.abort()
      }
    }
  }
}

function followAssWindows(
  video: HTMLVideoElement, canvas: HTMLCanvasElement, renderer: JassubRenderer,
  windows: ReturnType<typeof assWindows>, firstWindow: number, signal: AbortSignal,
  repaint: () => void, onReady: () => void, onError: () => void
) {
  let displayed = firstWindow
  let wanted = firstWindow
  let failed = -1
  let applying = false
  let complete = false
  let prefetched = -1

  async function change(window: number) {
    applying = true
    try {
      const next = await windows.load(window)
      if (signal.aborted || window !== wanted) return
      await renderer.renderer.setTrack(next.content)
      displayed = window
      complete = !next.windowed
      if ((complete || window === wanted) && !signal.aborted) {
        canvas.hidden = false
        repaint()
        onReady()
      }
    } catch {
      if (!signal.aborted && window === wanted) {
        failed = window
        onError()
      }
    } finally {
      applying = false
      if (!signal.aborted && !complete && wanted !== displayed && wanted !== failed) void change(wanted)
    }
  }

  function follow() {
    if (signal.aborted || complete) return
    const time = video.currentTime + renderer.timeOffset
    const window = assWindow(time)
    if (window !== wanted) {
      wanted = window
      failed = -1
      prefetched = -1
      windows.keep(window)
    }
    canvas.hidden = window !== displayed
    if (window !== displayed && !applying && window !== failed) void change(window)
    const nextStart = (window + 1) * ASS_WINDOW_SECONDS
    if (displayed === window && prefetched !== window && nextStart - time <= 5 && nextStart < video.duration) {
      prefetched = window
      void windows.load(window + 1).catch(() => {})
    }
  }
  video.addEventListener('timeupdate', follow, { signal })
  video.addEventListener('seeking', follow, { signal })
  return follow
}

function textTrack(
  video: HTMLVideoElement, url: string, language: string | undefined, delay: number,
  signal: AbortSignal, onReady: () => void, onError: () => void
): SubtitleRenderer {
  const element = document.createElement('track')
  element.kind = 'subtitles'
  element.srclang = language ?? 'und'
  element.src = url
  let originals: {
    cue: TextTrackCue; start: number; end: number; placement?: Pick<VTTCue, 'line' | 'lineAlign' | 'snapToLines'>
  }[] = []
  let offset = delay
  let applied = 0
  let position = 0
  const apply = () => {
    if (offset === applied) return
    for (const { cue, start, end } of originals) {
      cue.startTime = Math.max(0, start + offset)
      cue.endTime = Math.max(0, end + offset)
    }
    applied = offset
  }
  function moveCues() {
    for (const { cue, placement } of originals) {
      if (!(cue instanceof VTTCue) || !placement) continue
      const { line, lineAlign, snapToLines } = placement
      if (position === 0) {
        cue.snapToLines = snapToLines
        cue.lineAlign = lineAlign
        cue.line = line
      } else {
        const original = line === 'auto' ? 95 : !snapToLines ? line : line < 0 ? 100 + 5 * line : 5 * line
        cue.snapToLines = false
        cue.lineAlign = line === 'auto' || (snapToLines && line < 0) ? 'end' : lineAlign
        cue.line = Math.min(100, Math.max(0, original + position))
      }
    }
  }
  element.addEventListener('load', () => {
    originals = Array.from(element.track.cues ?? [], (cue) => ({
      cue, start: cue.startTime, end: cue.endTime,
      placement: cue instanceof VTTCue && !cue.vertical
        ? { line: cue.line, lineAlign: cue.lineAlign, snapToLines: cue.snapToLines } : undefined
    }))
    apply()
    if (position) moveCues()
    onReady()
  }, { signal })
  element.addEventListener('error', onError, { signal })
  video.append(element)
  element.track.mode = 'showing'
  const close = () => {
    element.track.mode = 'disabled'
    element.remove()
  }
  signal.addEventListener('abort', close, { once: true })
  return {
    setDelay: (seconds) => { offset = seconds; apply() },
    setPosition: (percent) => {
      if (position === percent) return
      position = percent
      moveCues()
    }
  }
}
