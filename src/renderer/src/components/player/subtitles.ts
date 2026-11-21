import type JassubRenderer from 'jassub'
import { subtitleUrl } from '@lib/services/web-playback.service'
import type { LocalMediaTrack } from '@shared/local-media'
import type { WebSubtitle } from '@shared/web-playback'

export interface SubtitleRenderer {
  setDelay(seconds: number): void
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
    const { default: JASSUB } = await import('jassub')
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
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error('Could not load ASS subtitles')
    const subContent = await response.text()
    signal.throwIfAborted()
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
        video, canvas, subContent, timeOffset: -delay, queryFonts: false,
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
    const setDelay = (seconds: number) => {
      active.timeOffset = -seconds
      if (video.paused && video.videoWidth) {
        void active.manualRender({
          expectedDisplayTime: performance.now(), mediaTime: video.currentTime,
          width: video.videoWidth, height: video.videoHeight
        }, true).catch(() => {})
      }
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

function textTrack(
  video: HTMLVideoElement, url: string, language: string | undefined, delay: number,
  signal: AbortSignal, onReady: () => void, onError: () => void
): SubtitleRenderer {
  const element = document.createElement('track')
  element.kind = 'subtitles'
  element.srclang = language ?? 'und'
  element.src = url
  let originals: { cue: TextTrackCue; start: number; end: number }[] = []
  let offset = delay
  let applied = 0
  const apply = () => {
    if (offset === applied) return
    for (const { cue, start, end } of originals) {
      cue.startTime = Math.max(0, start + offset)
      cue.endTime = Math.max(0, end + offset)
    }
    applied = offset
  }
  element.addEventListener('load', () => {
    originals = Array.from(element.track.cues ?? [], (cue) => ({ cue, start: cue.startTime, end: cue.endTime }))
    apply()
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
  return { setDelay: (seconds) => { offset = seconds; apply() } }
}
