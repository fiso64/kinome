import type JassubRenderer from 'jassub'
import { subtitleUrl } from '@lib/services/web-playback.service'
import type { LocalMediaTrack } from '@shared/local-media'
import { SUBTITLE_WINDOW_HEADER, SUBTITLE_WINDOW_SECONDS, type WebSubtitle } from '@shared/web-playback'

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
  localFonts: boolean
  fonts: number[]
  fontRevision?: string
  delay: number
  signal: AbortSignal
  onReady: () => void
  onError: (reason?: unknown) => void
}

export async function openSubtitle(options: SubtitleOptions): Promise<SubtitleRenderer> {
  const { track, video, itemId, signal, delay, container, source, fonts, onReady, onError } = options
  const url = subtitleUrl(itemId, track.id)
  if (track.format === 'text') return textTrack(video, url, track, delay, signal, onReady, onError)
  if (track.format === 'ass') {
    const firstWindow = subtitleWindow(video.currentTime - delay)
    const windows = track.sidecar ? undefined : subtitleWindows(url, signal, (response) => response.text())
    const [{ default: JASSUB }, initial] = await Promise.all([
      import('jassub'), windows?.load(firstWindow) ?? fetchWindow(url, signal, (response) => response.text())
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
        return super.resize(repaint, Math.round(height * ratio), height)
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
        video, canvas, subContent: initial.content, timeOffset: -delay,
        maxRenderHeight: 0, queryFonts: options.localFonts ? 'local' : false,
        fonts: fonts.map((index) => subtitleUrl(itemId, 'font', String(index), options.fontRevision))
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
      ? followWindows(video, canvas, windows, firstWindow, signal, () => active.timeOffset, async (content) => {
          await active.renderer.setTrack(content)
          repaint()
        }, onReady, onError)
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

  const firstWindow = subtitleWindow(video.currentTime - delay)
  const windows = !track.sidecar
    ? subtitleWindows(url, signal, async (response) =>
        track.format === 'pgs' && !response.headers.has(SUBTITLE_WINDOW_HEADER) ? response : await response.arrayBuffer()) : undefined
  const [{ PgsRenderer, VobSubRenderer }, initial] = await Promise.all([
    import('libbitsub'), windows?.load(firstWindow)
  ])
  signal.throwIfAborted()
  const canvas = document.createElement('canvas')
  canvas.className = 'subtitle-canvas'
  const settings = {
    video, container, canvas, timeOffset: -delay,
    // These assets are consumed sequentially. A single streaming GET avoids a
    // range probe and one round trip per half megabyte on remote connections.
    rangeRequests: false,
    onLoaded: () => { if (!signal.aborted) onReady() },
    onError: (error: Error) => { if (!signal.aborted) onError(error) }
  }
  if (track.format === 'vobsub' && windows && initial) {
    let renderer: InstanceType<typeof VobSubRenderer> | undefined
    let offset = -delay
    let cancel: (() => void) | undefined
    const close = () => { cancel?.(); renderer?.dispose(); canvas.remove() }
    signal.addEventListener('abort', close, { once: true })
    const display = async (content: ArrayBuffer | Response) => {
      renderer?.dispose()
      renderer = undefined
      // Reset the backing surface even for an empty window.
      canvas.width = canvas.width
      if (!(content instanceof ArrayBuffer) || !content.byteLength) return
      try {
        await new Promise<void>((resolve, reject) => {
          cancel = () => reject(signal.reason)
          renderer = new VobSubRenderer({ ...settings, fileName: 'subtitle.mks', subContent: content,
            timeOffset: offset, onLoaded: resolve, onError: reject })
        })
      } finally {
        cancel = undefined
      }
    }
    await display(initial.content)
    signal.throwIfAborted()
    const follow = initial.windowed
      ? followWindows(video, canvas, windows, firstWindow, signal, () => offset, display, onReady, onError)
      : undefined
    onReady()
    follow?.()
    return {
      setDelay: (seconds) => {
        offset = -seconds
        if (renderer) renderer.timeOffset = offset
        follow?.()
      }
    }
  }
  if (windows && initial) {
    const renderer = new PgsRenderer({ ...settings, onLoaded: undefined })
    signal.addEventListener('abort', () => { renderer.dispose(); canvas.remove() }, { once: true })
    const apply = async (content: ArrayBuffer | Response) => {
      await renderer.reset()
      signal.throwIfAborted()
      if (content instanceof Response && content.body) {
        // Unindexed sources use the full SUP response. Display incoming cues
        // while the rest downloads, including on a slow connection.
        const reader = content.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (await renderer.append(value)) onReady()
          }
        } finally {
          reader.releaseLock()
        }
      } else if (content instanceof ArrayBuffer && content.byteLength) {
        await renderer.append(content)
      }
      await renderer.flush()
    }
    await apply(initial.content)
    signal.throwIfAborted()
    const follow = initial.windowed
      ? followWindows(video, canvas, windows, firstWindow, signal, () => renderer.timeOffset, apply, onReady, onError)
      : undefined
    onReady()
    return { setDelay: (seconds) => { renderer.timeOffset = -seconds; follow?.() } }
  }
  const renderer = track.format === 'pgs' ? new PgsRenderer({ ...settings, subUrl: url }) : new VobSubRenderer({
    ...settings, subUrl: url, idxUrl: subtitleUrl(itemId, track.id, 'idx')
  })
  const close = () => {
    renderer.dispose()
    canvas.remove()
  }
  signal.addEventListener('abort', close, { once: true })
  return { setDelay: (seconds) => { renderer.timeOffset = -seconds } }
}

const subtitleWindow = (seconds: number) => Math.floor(Math.max(0, seconds) / SUBTITLE_WINDOW_SECONDS)

async function fetchWindow<T>(url: string, signal: AbortSignal, read: (response: Response) => Promise<T>) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Subtitle request failed (HTTP ${response.status})`)
  return { content: await read(response), windowed: response.headers.has(SUBTITLE_WINDOW_HEADER) }
}

function subtitleWindows<T>(url: string, signal: AbortSignal, read: (response: Response) => Promise<T>) {
  const requests = new Map<number, {
    controller: AbortController
    content: ReturnType<typeof fetchWindow<T>>
  }>()
  return {
    load(window: number) {
      const existing = requests.get(window)
      if (existing) return existing.content
      const controller = new AbortController()
      const request = {
        controller,
        content: fetchWindow(`${url}&window=${window}`, AbortSignal.any([signal, controller.signal]), read).catch((error) => {
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

function followWindows<T>(
  video: HTMLVideoElement, canvas: HTMLCanvasElement | undefined, windows: ReturnType<typeof subtitleWindows<T>>,
  firstWindow: number, signal: AbortSignal, offset: () => number, apply: (content: T) => Promise<void>,
  onReady: () => void, onError: (reason?: unknown) => void
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
      await apply(next.content)
      displayed = window
      complete = !next.windowed
      if ((complete || window === wanted) && !signal.aborted) {
        if (canvas) canvas.hidden = false
        onReady()
      }
    } catch (error) {
      if (!signal.aborted && window === wanted) {
        failed = window
        onError(error)
      }
    } finally {
      applying = false
      if (!signal.aborted && !complete && wanted !== displayed && wanted !== failed) void change(wanted)
    }
  }

  function follow() {
    if (signal.aborted || complete) return
    const time = video.currentTime + offset()
    const window = subtitleWindow(time)
    if (window !== wanted) {
      wanted = window
      failed = -1
      prefetched = -1
      windows.keep(window)
    }
    if (canvas) canvas.hidden = window !== displayed
    if (window !== displayed && !applying && window !== failed) void change(window)
    const nextStart = (window + 1) * SUBTITLE_WINDOW_SECONDS
    if (displayed === window && prefetched !== window && nextStart - time <= 5 && nextStart < video.duration) {
      prefetched = window
      void windows.load(window + 1).catch(() => {})
    }
  }
  video.addEventListener('timeupdate', follow, { signal })
  video.addEventListener('seeking', follow, { signal })
  return follow
}

async function textTrack(
  video: HTMLVideoElement, url: string, track: WebSubtitle, delay: number,
  signal: AbortSignal, onReady: () => void, onError: (reason?: unknown) => void
): Promise<SubtitleRenderer> {
  // Fetch before attaching a native track. A pending track can hold the
  // media element below HAVE_FUTURE_DATA even while it presents frames.
  const firstWindow = subtitleWindow(video.currentTime - delay)
  const read = (response: Response) => response.blob()
  const windows = track.sidecar ? undefined : subtitleWindows(url, signal, read)
  const initial = await (windows?.load(firstWindow) ?? fetchWindow(url, signal, read))
  signal.throwIfAborted()
  const element = document.createElement('track')
  element.kind = 'subtitles'
  element.srclang = track.language ?? 'und'
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
  let cancelLoad: (() => void) | undefined
  const close = () => {
    cancelLoad?.()
    element.track.mode = 'disabled'
    element.remove()
  }
  signal.addEventListener('abort', close, { once: true })

  async function display(blob: Blob) {
    const localUrl = URL.createObjectURL(blob)
    try {
      await new Promise<void>((resolve, reject) => {
        cancelLoad = () => reject(signal.reason)
        element.onload = () => resolve()
        element.onerror = () => reject(new Error('Could not parse subtitle track'))
        element.src = localUrl
        if (!element.parentNode) video.append(element)
        element.track.mode = 'showing'
      })
      originals = Array.from(element.track.cues ?? [], (cue) => ({
        cue, start: cue.startTime, end: cue.endTime,
        placement: cue instanceof VTTCue && !cue.vertical
          ? { line: cue.line, lineAlign: cue.lineAlign, snapToLines: cue.snapToLines } : undefined
      }))
      applied = 0
      apply()
      if (position) moveCues()
    } finally {
      cancelLoad = undefined
      element.onload = element.onerror = null
      URL.revokeObjectURL(localUrl)
    }
  }
  try {
    await display(initial.content)
    signal.throwIfAborted()
  } catch (error) {
    signal.removeEventListener('abort', close)
    close()
    throw error
  }
  const follow = windows && initial.windowed
    ? followWindows(video, undefined, windows, firstWindow, signal, () => -offset, display, onReady, onError)
    : undefined
  follow?.()
  onReady()
  return {
    setDelay: (seconds) => { offset = seconds; apply(); follow?.() },
    setPosition: (percent) => {
      if (position === percent) return
      position = percent
      moveCues()
    }
  }
}
