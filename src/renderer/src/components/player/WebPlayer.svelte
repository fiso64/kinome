<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import type HlsType from 'hls.js'
  import type { ErrorData } from 'hls.js'
  import '@videojs/html/video/player'
  import '@videojs/html/ui/container'
  import '@videojs/html/ui/fullscreen-button'
  import '@videojs/html/ui/mute-button'
  import '@videojs/html/ui/slider-track'
  import '@videojs/html/ui/slider-fill'
  import '@videojs/html/ui/slider-thumb'
  import '@videojs/html/ui/volume-slider'
  import '@videojs/html/icons/element'
  import NotificationContainer from '@ui/NotificationContainer.svelte'
  import { authStore } from '@lib/auth-store.svelte'
  import { clientSettingsStore } from '@lib/client-settings-store.svelte'
  import { BUILTIN_WEB_PLAYER, playerLauncherService, resolveClientPlayers, resolvePlaybackQuality } from '@lib/services/player-launcher.service'
  import {
    automaticQualities, browserPlaybackUrl, getWebPlaybackInfo, getWebPlaybackQueue, hlsMime, languageName,
    matchesLanguage, preferredSubtitle, storePlaybackPosition
  } from '@lib/services/web-playback.service'
  import { webQualityLabel, type WebPlaybackInfo, type WebPlaybackQuality, type WebQualityChoice, type WebQueueItem } from '@shared/web-playback'
  import type { MediaChapter } from '@shared/local-media'
  import type { MediaFile, Settings } from '@shared/types'
  import { openSubtitle, type SubtitleRenderer } from './subtitles'

  let { item: startItem, settings, initialQuality, onClose }: {
    item: MediaFile
    settings: Settings | null
    initialQuality?: WebQualityChoice
    onClose: () => void
  } = $props()

  let item = $state<MediaFile>(untrack(() => startItem))
  let queue = $state.raw<WebQueueItem[]>([])
  let opening: AbortController | undefined

  let dialog: HTMLDialogElement
  let video: HTMLVideoElement
  let surface: HTMLDivElement
  let fullscreenButton: HTMLElement
  let chromeHeader: HTMLElement
  let chromeFooter: HTMLElement
  let pointerFrame = 0
  let pointerY = 0
  let cursorIdle = $state(false)
  let lastPointerActivity = 0
  let cursorTimer: ReturnType<typeof setTimeout> | undefined
  let videoClickTimer: ReturnType<typeof setTimeout> | undefined
  let settingsButton: HTMLButtonElement
  let tracksButton = $state<HTMLButtonElement>()
  let queueButton: HTMLButtonElement
  let panelHeading = $state<HTMLHeadingElement>()
  let panelOrigin = $state<HTMLElement>()
  let panelElement = $state<HTMLElement>()
  let keyboardNavigation = false
  let playbackSpace = false
  let dismissedPanelOnVideo = false

  type Panel = 'tracks' | 'queue' | 'chapters' | 'settings' | 'quality' | 'speed' | 'external' | 'shortcuts'
  const panelTitles: Record<Panel, string> = {
    tracks: 'Audio & subtitles', queue: 'Playback queue', chapters: 'Chapters', settings: 'Playback settings', quality: 'Video quality',
    speed: 'Playback speed', external: 'Play with', shortcuts: 'Keyboard shortcuts'
  }
  let panel = $state<Panel>()
  const settingsOpen = $derived(Boolean(panel && panel !== 'tracks' && panel !== 'queue'))

  let info = $state<WebPlaybackInfo>()
  let timelineDuration = $state(0)
  let playbackPosition = $state(0)
  let requestedPosition = $state<number>()
  let committedPosition: number | undefined
  let lastSeekAt = -Infinity
  let seekTimer: ReturnType<typeof setTimeout> | undefined
  let scrubPointer = $state<number>()
  let seekInput: HTMLInputElement
  let pointerPosition = $state<number>()
  const playhead = $derived(requestedPosition ?? playbackPosition)
  const previewPosition = $derived(scrubPointer !== undefined ? playhead : pointerPosition)
  let chapterIndex = $state(-1)
  let pointedChapter = $state(-1)
  let focusedChapter = $state(-1)
  const chapters = $derived(info?.media?.chapters ?? [])
  const chapterHighlights = $derived(getChapterHighlights(chapters))
  const chapterHintIndex = $derived(focusedChapter >= 0 ? focusedChapter : pointedChapter)
  const chapterHint = $derived(chapters[chapterHintIndex])
  const previewChapterIndex = $derived(previewPosition === undefined ? -1 : chapterAfter(previewPosition, 0) - 1)
  const previewChapter = $derived(chapters[previewChapterIndex])
  let quality = $state<WebQualityChoice>('auto')
  let activeQuality = $state<WebPlaybackQuality>()
  let audioIndex = $state<number>()
  let subtitleId = $state('')
  let lastSubtitle = ''
  let delay = $state(0)
  let subtitleScale = $state(100)
  let subtitlePosition = $state(0)
  let speed = $state(1)
  let paused = $state(true)
  let loading = $state(true)
  let mediaReady = $state(false)
  let error = $state('')
  let subtitleReady = $state(false)
  let subtitleNotice = $state('')
  let playBlocked = $state(false)
  let shortcutFeedback = $state('')
  let showTimelineForShortcut = $state(false)
  let shortcutTimer: ReturnType<typeof setTimeout> | undefined
  let width = $state(0)
  let height = $state(0)
  let resumeAt = 0
  let wantPlayback = true
  let operation: AbortController | undefined
  let hls: HlsType | undefined
  let renderer = $state.raw<SubtitleRenderer>()
  let lastSaved = 0
  let lastSaveAt = 0
  let hasPlayed = false
  let completed = false
  let writes = Promise.resolve()
  let pendingFrameTime: number | undefined
  let steppedFrameTime: number | undefined
  let presentedFrameTime: number | undefined
  let audioCapability = $derived(info?.media?.tracks.filter((track) => track.kind === 'audio') ?? [])
  let defaultAudio = $derived(audioCapability.find((track) => track.default) ?? audioCapability[0])
  let availablePlayers = $derived(resolveClientPlayers(settings?.playerCommands ?? [], clientSettingsStore.settings.enabledPlayerIds)
    .filter((player) => player.id !== BUILTIN_WEB_PLAYER.id))
  const qualityChoices = $derived<WebQualityChoice[]>([
    'auto', ...(info?.qualities ?? []), ...(info?.audioConversion ? ['audio' as const] : [])
  ])
  const canSwitchAudio = $derived(audioCapability.length > 1 && (info?.qualities.length ?? 0) > 1)
  const speeds = [0.25, 0.5, 0.75, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
  const title = $derived(item.title || item.name)
  const queueIndex = $derived(queue?.findIndex((entry) => entry.id === item.id) ?? -1)
  const previous = $derived(queueIndex > 0 ? queue?.[queueIndex - 1] : undefined)
  const next = $derived(queueIndex >= 0 ? queue?.[queueIndex + 1] : undefined)

  function navigate(entry: WebQueueItem | undefined) {
    if (!entry || entry.id === item.id) return
    persist(true)
    clearSource()
    closePanel()
    item = entry
    info = undefined
    activeQuality = undefined
    mediaReady = false
    subtitleReady = false
    chapterIndex = pointedChapter = focusedChapter = -1
    subtitleId = ''
    delay = 0
    paused = true
    hasPlayed = false
    completed = false
    lastSaveAt = 0
    wantPlayback = true
    openItem(quality)
  }

  function openItem(preferredQuality?: WebQualityChoice) {
    opening?.abort()
    opening = new AbortController()
    void initialize(opening.signal, preferredQuality)
  }

  function episodeLabel(entry: WebQueueItem): string {
    if (entry.episodeNumber == null) return ''
    return entry.seasonNumber == null ? `Episode ${entry.episodeNumber}`
      : `S${String(entry.seasonNumber).padStart(2, '0')}E${String(entry.episodeNumber).padStart(2, '0')}`
  }

  function revealNearPointer(event: PointerEvent) {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
    wakeCursor()
    pointerY = event.clientY
    if (pointerFrame) return
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = 0
      const top = chromeHeader.getBoundingClientRect().bottom
      const bottom = chromeFooter.getBoundingClientRect().top
      setChromeProximity(chromeHeader, pointerY - top)
      setChromeProximity(chromeFooter, bottom - pointerY)
    })
  }

  function wakeCursor() {
    lastPointerActivity = performance.now()
    cursorIdle = false
    cursorTimer ??= setTimeout(hideIdleCursor, 1000)
  }

  function hideIdleCursor() {
    const remaining = 1000 - (performance.now() - lastPointerActivity)
    cursorTimer = remaining > 0 ? setTimeout(hideIdleCursor, remaining) : undefined
    if (remaining <= 0) cursorIdle = true
  }

  function setChromeProximity(element: HTMLElement, distance: number) {
    const reveal = Math.max(0, Math.min(1, (120 - distance) / (120 - 32)))
    element.style.setProperty('--reveal', reveal.toFixed(2))
    element.toggleAttribute('data-near-pointer', reveal > 0)
  }

  function resetProximity() {
    clearTimeout(cursorTimer)
    cursorTimer = undefined
    cursorIdle = false
    cancelAnimationFrame(pointerFrame)
    pointerFrame = 0
    setChromeProximity(chromeHeader, Infinity)
    setChromeProximity(chromeFooter, Infinity)
  }


  const streamDescription = $derived(activeQuality === 'original' ? 'Direct play'
    : activeQuality === 'remux' ? 'Remuxing'
    : activeQuality === 'audio' ? 'Converting audio'
    : activeQuality ? 'Transcoding' : '')

  function persist(force = false, finished = false) {
    if (!hasPlayed || !mediaReady || (completed && !finished)) return
    const now = performance.now()
    const position = finished ? 0 : Math.round(video.currentTime)
    if (!finished && (!Number.isFinite(position) || position === lastSaved || (!force && now - lastSaveAt < 15_000))) return
    lastSaveAt = now
    lastSaved = position
    const token = authStore.token
    if (!token) return
    const id = item.id
    writes = writes.then(() => storePlaybackPosition(id, token, position, finished)).catch(() => {
      if (item.id === id && lastSaved === position) lastSaved = -1
    })
  }

  function clearSource() {
    resetFrameStep()
    clearSeek()
    clearTimeout(videoClickTimer)
    videoClickTimer = undefined
    operation?.abort()
    hls?.destroy()
    hls = undefined
    video.pause()
    video.removeAttribute('src')
    video.load()
  }

  function statusDetail(data: ErrorData): string {
    const text = data.response?.text
    if (text && typeof text === 'string' && text.length < 250 && !text.includes('<') && !text.includes('token=')) return text
    const status = data.response?.code
    if (status && status >= 400) return `Playback request failed (HTTP ${status}).`
    if (data.details === 'manifestParsingError') return 'The server returned an unreadable HLS playlist.'
    if (data.details.toLowerCase().includes('timeout')) return 'Playback timed out while waiting for the server.'
    return 'The browser could not load or decode the stream.'
  }

  async function loadSource(remember = true) {
    if (!info) return
    if (remember && mediaReady) {
      persist(true)
      resumeAt = video.ended ? 0 : video.currentTime
      wantPlayback = !video.paused || video.ended
    }
    clearSource()
    loading = true
    mediaReady = false
    error = ''
    playBlocked = false
    width = 0
    height = 0
    timelineDuration = 0
    playbackPosition = 0
    paused = true
    const controller = new AbortController()
    operation = controller
    const audio = audioCapability.find((track) => track.index === audioIndex)
    const candidates = quality === 'auto'
      ? await automaticQualities(video, info, audio, defaultAudio)
      : [quality]
    if (controller.signal.aborted) return
    let index = 0
    let attempt: AbortController | undefined
    controller.signal.addEventListener('abort', () => attempt?.abort(), { once: true })

    async function nextSource() {
      if (controller.signal.aborted) return
      const mode = candidates[index++]
      if (attempt) {
        attempt.abort()
        clearSeek()
        hls?.destroy()
        hls = undefined
        video.removeAttribute('src')
        video.load()
      }
      if (!mode) {
        loading = false
        activeQuality = undefined
        error = 'The selected audio track requires playback conversion.'
        return
      }
      activeQuality = mode
      const signal = (attempt = new AbortController()).signal
      const listen = <K extends keyof HTMLMediaElementEventMap>(event: K, handler: () => void, once = false) =>
        video.addEventListener(event, handler, { signal, once })

      function failed(message: string) {
        if (signal.aborted) return
        if (mediaReady) {
          persist(true)
          resumeAt = requestedPosition ?? video.currentTime
          wantPlayback = !video.paused
        }
        mediaReady = false
        if (index < candidates.length) {
          void nextSource()
        } else {
          loading = false
          activeQuality = undefined
          error = message
          clearSource()
        }
      }

      const url = browserPlaybackUrl(item.id, item.name, mode, audioIndex)
      video.playbackRate = speed
      video.defaultPlaybackRate = speed
      const play = () => {
        if (!wantPlayback) return
        void video.play().catch((reason: DOMException) => {
          if (signal.aborted || reason.name === 'AbortError') return
          if (reason.name === 'NotAllowedError') { playBlocked = true; loading = false }
          else failed('This browser could not play the selected source.')
        })
      }
      listen('durationchange', () => {
        timelineDuration = Number.isFinite(video.duration) ? video.duration : 0
      })
      listen('seeked', () => {
        if (video.seeking) return
        updatePlaybackPosition()
        if (committedPosition !== undefined) {
          const settledPosition = committedPosition
          committedPosition = undefined
          if (requestedPosition === settledPosition) {
            if (scrubPointer === undefined) requestedPosition = undefined
          } else scheduleLiveSeek()
        }
        applyFrameStep()
      })
      listen('play', () => {
        paused = false
        resetFrameStep()
      })
      listen('loadedmetadata', () => {
        if (!video.videoWidth && info?.media?.tracks.some((track) => track.kind === 'video')) {
          failed('The browser could decode the audio but could not decode the video.')
          return
        }
        if (resumeAt > 0 && Number.isFinite(video.duration)) {
          video.currentTime = Math.min(resumeAt, Math.max(0, video.duration - 0.1))
        }
        timelineDuration = Number.isFinite(video.duration) ? video.duration : 0
        updatePlaybackPosition()
        observePresentedFrames(signal)
        width = video.videoWidth
        height = video.videoHeight
        mediaReady = true
        subtitleReady = true
      }, true)
      listen('canplay', () => { loading = false })
      listen('waiting', () => { if (!video.paused) loading = true })
      listen('playing', () => {
        hasPlayed = true
        playBlocked = false
        loading = false
        if (completed) {
          completed = false
          lastSaved = 0
        }
      })
      listen('pause', () => {
        paused = true
        loading = false
        if (!video.ended) persist(true)
      })
      listen('timeupdate', () => {
        updatePlaybackPosition()
        persist()
      })
      listen('ended', () => {
        paused = true
        completed = true
        resumeAt = 0
        persist(true, true)
      })
      listen('error', () => failed(video.error?.code === MediaError.MEDIA_ERR_NETWORK
        ? 'The video could not be loaded from the server.' : 'The browser could not decode the selected source.'))
      if (mode === 'original' || (video.canPlayType(hlsMime) && navigator.vendor === 'Apple Computer, Inc.')) {
        video.src = url
        play()
        return
      }
      try {
        const { default: Hls } = await import('hls.js')
        if (signal.aborted) return
        if (Hls.isSupported()) {
          hls = new Hls({ maxBufferLength: 12, maxMaxBufferLength: 30, startPosition: resumeAt || -1 })
          hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) failed(statusDetail(data)) })
          hls.on(Hls.Events.MANIFEST_PARSED, play)
          hls.loadSource(url)
          hls.attachMedia(video)
        } else if (video.canPlayType(hlsMime)) {
          video.src = url
          play()
        } else {
          failed('This browser does not support HLS playback.')
        }
      } catch {
        failed('Could not start the HLS player.')
      }
    }
    await nextSource()
  }

  function selectQuality(value: WebQualityChoice) {
    if (value === 'original' && audioIndex !== defaultAudio?.index) audioIndex = defaultAudio?.index
    quality = value
    void loadSource()
  }

  function selectAudio(index: number) {
    audioIndex = index
    if (quality === 'original') quality = 'auto'
    void loadSource()
  }

  function setSubtitle(value: string) {
    if (value) lastSubtitle = value
    subtitleId = value
  }

  function toggleSubtitle() {
    setSubtitle(subtitleId ? '' : lastSubtitle || info?.subtitles[0]?.id || '')
  }

  function changeSubtitleTrack(direction: number) {
    const tracks = info?.subtitles ?? []
    if (!tracks.length) return
    // Slot zero is Off, followed by the tracks in display order.
    const slots = tracks.length + 1
    const current = tracks.findIndex((track) => track.id === subtitleId) + 1
    const next = (current + direction + slots) % slots
    setSubtitle(tracks[next - 1]?.id ?? '')
  }

  function subtitleFeedback(offLabel = 'Subtitles hidden') {
    if (!info?.subtitles.length) return 'No subtitle tracks'
    const track = info.subtitles.find((track) => track.id === subtitleId)
    return track ? `Subtitles: ${track.title || languageName(track.language)}` : offLabel
  }

  function updatePlaybackPosition() {
    playbackPosition = video.currentTime
    if (chapters.length) chapterIndex = chapterAfter(playbackPosition) - 1
  }

  function clearSeek() {
    clearTimeout(seekTimer)
    seekTimer = undefined
    lastSeekAt = -Infinity
    requestedPosition = committedPosition = pointerPosition = scrubPointer = undefined
  }

  function commitSeek() {
    clearTimeout(seekTimer)
    seekTimer = undefined
    if (requestedPosition === undefined || requestedPosition === committedPosition) return
    if (!video.seeking && requestedPosition === video.currentTime) {
      updatePlaybackPosition()
      if (scrubPointer === undefined) requestedPosition = undefined
      return
    }
    committedPosition = requestedPosition
    lastSeekAt = performance.now()
    video.currentTime = committedPosition
  }

  function scheduleLiveSeek() {
    // Give the browser a chance to present each intermediate seek. Keep only
    // the latest target while it is decoding, and skip redundant short seeks.
    if (committedPosition !== undefined || requestedPosition === undefined || seekTimer !== undefined) return
    const remaining = 150 - (performance.now() - lastSeekAt)
    if (remaining > 0) seekTimer = setTimeout(commitSeek, remaining)
    else commitSeek()
  }

  function seekTo(seconds: number, live = false) {
    if (!mediaReady || timelineDuration <= 0) return
    resetFrameStep()
    requestedPosition = Math.min(timelineDuration, Math.max(0, seconds))
    if (live) scheduleLiveSeek()
    else commitSeek()
  }

  function seek(seconds: number, live = false) {
    seekTo((requestedPosition ?? video.currentTime) + seconds, live)
  }

  function startScrub(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || !mediaReady || !timelineDuration) return
    resetFrameStep()
    clearTimeout(seekTimer)
    seekTimer = undefined
    scrubPointer = event.pointerId
    requestedPosition ??= video.currentTime
  }

  function updateScrub(event: Event & { currentTarget: HTMLInputElement }) {
    const time = event.currentTarget.valueAsNumber
    if (scrubPointer === undefined) seekTo(time)
    else {
      requestedPosition = time
      scheduleLiveSeek()
    }
  }

  function finishScrub(event: PointerEvent) {
    if (event.pointerId !== scrubPointer) return
    scrubPointer = undefined
    if (event.type === 'pointercancel') {
      clearTimeout(seekTimer)
      seekTimer = undefined
      requestedPosition = committedPosition
      pointerPosition = undefined
    } else {
      if (event.pointerType === 'touch') pointerPosition = undefined
      commitSeek()
    }
  }

  function updateSeekPreview(event: PointerEvent & { currentTarget: HTMLInputElement }) {
    if (!mediaReady || event.pointerType === 'touch') return
    const width = event.currentTarget.clientWidth
    if (width) pointerPosition = Math.min(1, Math.max(0, event.offsetX / width)) * timelineDuration
  }

  function stepFrame(direction: number) {
    if (!mediaReady || !Number.isFinite(video.duration)) return
    if (scrubPointer === undefined) commitSeek()
    video.pause()
    const [frames, seconds = 1] = (info?.media?.tracks.find((track) => track.kind === 'video')?.frameRate ?? '').split('/').map(Number)
    const rate = frames / seconds
    const step = Number.isFinite(rate) && rate > 0 ? 1 / rate : 1 / 30
    const presented = presentedFrameTime
    // Center seeks within the target frame. Encoders and HLS can shift frame
    // boundaries relative to currentTime even at a constant frame rate.
    const base = steppedFrameTime ?? (presented !== undefined && !video.seeking &&
      Math.abs(presented - video.currentTime) < step ? presented + step / 2 : video.currentTime)
    steppedFrameTime = Math.min(video.duration, Math.max(0, base + direction * step))
    pendingFrameTime = steppedFrameTime
    applyFrameStep()
  }

  function resetFrameStep() {
    pendingFrameTime = steppedFrameTime = undefined
  }

  function observePresentedFrames(signal: AbortSignal) {
    presentedFrameTime = undefined
    if (typeof video.requestVideoFrameCallback !== 'function') return
    let callback = video.requestVideoFrameCallback(rememberFrame)
    function rememberFrame(_now: number, frame: VideoFrameCallbackMetadata) {
      presentedFrameTime = frame.mediaTime
      callback = video.requestVideoFrameCallback(rememberFrame)
    }
    signal.addEventListener('abort', () => {
      video.cancelVideoFrameCallback(callback)
      presentedFrameTime = undefined
    }, { once: true })
  }

  function applyFrameStep() {
    if (pendingFrameTime === undefined || video.seeking) return
    const position = pendingFrameTime
    pendingFrameTime = undefined
    if (position !== video.currentTime) video.currentTime = position
  }

  // Playback can report a seek a few milliseconds before the exact target.
  function chapterAfter(seconds: number, tolerance = 0.01): number {
    let left = 0
    let right = chapters.length
    while (left < right) {
      const middle = Math.floor((left + right) / 2)
      if (chapters[middle].startSeconds <= seconds + tolerance) left = middle + 1
      else right = middle
    }
    return left
  }

  function seekChapter(next: boolean) {
    const index = chapterAfter(requestedPosition ?? video.currentTime)
    const chapter = chapters[next ? index : index - 2]
    if (chapter) seekTo(chapter.startSeconds)
    else if (!next) seekTo(0)
  }

  function chapterTitle(chapter: MediaChapter, index: number): string {
    return chapter.title ?? `Chapter ${index + 1}`
  }

  // uosc's default chapter patterns, including its Japanese aliases.
  const creditsPattern = /^(?:op|ed)(?: |$)| (?:op|ed)$|(?:^| )(?:opening|ending)$|^ending |オープニング|エンディング/u
  const introOutroPattern = /(?:^| )(?:intro|outro)$|^closing(?: |$)|^(?:avant|prologue|preview|pv)$/

  function getChapterHighlights(chapters: readonly MediaChapter[]) {
    const credits = { label: '#30abf9', range: '#30abf964' }
    const sponsor = { label: '#c54e4e', range: '#c54e4e80' }
    const sponsorStarts = new Map<string, number[]>()
    const labels: (string | undefined)[] = []
    const ranges: { startSeconds: number; endSeconds?: number; color: string }[] = []

    function highlight(index: number, endSeconds: number | undefined, palette: typeof credits) {
      labels[index] = palette.label
      ranges.push({ startSeconds: chapters[index].startSeconds, endSeconds, color: palette.range })
    }

    for (const [index, chapter] of chapters.entries()) {
      const title = chapter.title?.trim().toLowerCase() ?? ''
      const segment = /segment (start|end) *\(([a-z0-9]+)\)/.exec(title)
      if (!segment) {
        const nextStart = chapters[index + 1]?.startSeconds
        const end = chapter.endSeconds === undefined ? nextStart : Math.min(chapter.endSeconds, nextStart ?? Infinity)
        if (/\[sponsorblock\]:|^sponsor/.test(title)) highlight(index, end, sponsor)
        else if (creditsPattern.test(title)) highlight(index, end, credits)
        else if (introOutroPattern.test(title)) labels[index] = credits.label
        continue
      }
      const [, boundary, id] = segment
      const starts = sponsorStarts.get(id)
      if (boundary === 'start') {
        if (starts) starts.push(index)
        else sponsorStarts.set(id, [index])
      } else if (starts) {
        for (const start of starts) labels[start] = sponsor.label
        labels[index] = sponsor.label
        highlight(starts[0], chapter.startSeconds, sponsor)
        sponsorStarts.delete(id)
      }
    }
    return { labels, ranges }
  }

  function chapterTime(chapter: MediaChapter): string {
    return clockTime(chapter.startSeconds, chapter.startSeconds)
  }

  function clockTime(seconds: number, guide = timelineDuration): string {
    const time = Math.floor(Math.max(0, seconds))
    const hours = Math.floor(time / 3600)
    const minutes = Math.floor(time / 60) % 60
    const minutesText = String(minutes).padStart(guide >= 600 ? 2 : 1, '0')
    const secondsText = String(time % 60).padStart(2, '0')
    return guide >= 3600 ? `${hours}:${minutesText}:${secondsText}` : `${minutesText}:${secondsText}`
  }

  function setSpeed(rate: number) {
    speed = rate
    video.playbackRate = rate
    video.defaultPlaybackRate = rate
  }

  function togglePlayback() {
    clearTimeout(videoClickTimer)
    videoClickTimer = undefined
    if (video.paused) void video.play().catch(() => {})
    else video.pause()
  }

  function stepSpeed(direction: number) {
    const next = Math.max(0, Math.min(speeds.length - 1, speeds.indexOf(speed) + direction))
    setSpeed(speeds[next])
  }

  function changeDelay(delta: number) {
    delay = Math.round((delay + delta) * 1000) / 1000
  }

  function changeSubtitleScale(delta: number) {
    subtitleScale = Math.max(50, Math.min(200, subtitleScale + delta))
  }

  function changeSubtitlePosition(delta: number) {
    subtitlePosition = Math.max(-80, Math.min(5, subtitlePosition + delta))
  }

  const delayLabel = $derived(`${delay > 0 ? '+' : ''}${delay.toFixed(1)} s`)
  const subtitlePositionLabel = $derived(subtitlePosition === 0 ? 'Default' :
    `${Math.abs(subtitlePosition)}% ${subtitlePosition < 0 ? 'higher' : 'lower'}`)

  function openPanel(next: Panel, origin?: HTMLElement) {
    if (origin) panelOrigin = origin
    panel = next
    void tick().then(() => panelHeading?.focus({ preventScroll: true }))
  }

  $effect(() => {
    const anchor = panelOrigin
    const popover = panelElement
    if (!anchor || !popover) return
    const updateAnchor = () => {
      const bounds = anchor.getBoundingClientRect()
      const footerLeft = chromeFooter.getBoundingClientRect().left
      popover.style.setProperty('--anchor-x', `${bounds.left - footerLeft + bounds.width / 2}px`)
    }
    updateAnchor()
    const observer = new ResizeObserver(updateAnchor)
    observer.observe(chromeFooter)
    observer.observe(anchor.parentElement ?? anchor)
    return () => observer.disconnect()
  })

  function closePanel(restoreFocus = true) {
    panel = undefined
    if (restoreFocus) panelOrigin?.focus({ preventScroll: true })
    panelOrigin = undefined
  }

  function toggleKeyboardPanel(target: Panel, anchor: HTMLElement) {
    const label = panelTitles[target]
    if (panel === target) {
      closePanel()
      return `${label} closed`
    }
    openPanel(target, anchor)
    return label
  }

  function tapVideo(event: MouseEvent) {
    if (dismissedPanelOnVideo) {
      dismissedPanelOnVideo = false
      return
    }
    const pointer = event instanceof PointerEvent ? event.pointerType : ''
    if (pointer === 'touch' || (!pointer && matchMedia('(hover: none)').matches)) return
    clearTimeout(videoClickTimer)
    if (event.detail > 1) return
    videoClickTimer = setTimeout(togglePlayback, 250)
  }

  function doubleClickVideo(event: MouseEvent) {
    if (event instanceof PointerEvent && event.pointerType === 'touch') return
    clearTimeout(videoClickTimer)
    fullscreenButton.click()
  }

  function dismissPanelOnPointerDown(event: PointerEvent) {
    if (event.pointerType === 'mouse' || event.pointerType === 'pen') wakeCursor()
    resetFrameStep()
    keyboardNavigation = false
    dismissedPanelOnVideo = false
    if (panel && event.target instanceof Element && !event.target.closest('.control-panel, [data-panel-trigger]')) {
      dismissedPanelOnVideo = event.target === video
      closePanel(false)
    }
  }

  function launchExternal(id: string) {
    const player = availablePlayers.find((entry) => entry.id === id)
    if (!player) return
    const selected = quality === 'auto' || quality === 'audio' ? resolvePlaybackQuality(settings) : quality
    void playerLauncherService.launchExternal(item, player, selected)
    closePanel()
  }

  function handleKey(event: KeyboardEvent) {
    if (event.key === ' ' && !event.repeat) playbackSpace = false
    if (event.defaultPrevented) return
    if (event.key === 'Escape') {
      if (panel || !document.fullscreenElement) {
        event.preventDefault()
        event.stopPropagation()
        if (panel) {
          if (panel !== 'tracks') showShortcutFeedback(`${panelTitles[panel]} closed`)
          closePanel()
        }
        else onClose()
      }
      return
    }
    if (event.key === 'Tab') {
      keyboardNavigation = true
      return
    }
    const key = event.key.toLowerCase()
    const subtitleModifier = event.ctrlKey && event.shiftKey && key.startsWith('arrow')
    if (event.altKey || event.metaKey || (event.ctrlKey && !subtitleModifier)) return
    const target = event.target
    const onSeekInput = target === seekInput
    if (target instanceof Element) {
      if (!onSeekInput && target.closest('textarea, select, [contenteditable], input:not([type="radio"])')) return
      const radio = target.closest('input[type="radio"]')
      const slider = target.closest('[role="slider"]')
      if (radio && (key === ' ' || (!event.shiftKey && key.startsWith('arrow')))) return
      if (keyboardNavigation && slider && !onSeekInput && !event.shiftKey && (key.startsWith('arrow') || ['home', 'end'].includes(key))) return
      const button = target.closest('button, [role="button"]')
      if ((keyboardNavigation || panel) && key === ' ' && button && !button.matches('.play-button, .center-play')) return
    }
    if (key === ' ' || key === 'k' || key === 'f') {
      event.preventDefault()
      event.stopPropagation()
      if (key === ' ') playbackSpace = true
      if (!event.repeat) {
        if (key === 'f') fullscreenButton.click()
        else togglePlayback()
      }
      return
    }
    let feedback = ''
    let revealTimeline = false
    if (subtitleModifier) {
      if (key === 'arrowup' || key === 'arrowdown') {
        changeSubtitleScale(key === 'arrowup' ? 10 : -10)
        feedback = `Subtitle scale: ${subtitleScale}%`
      } else {
        changeDelay(key === 'arrowright' ? 0.1 : -0.1)
        feedback = `Subtitle delay: ${delayLabel}`
      }
    } else switch (key) {
      case ',': case '.':
        stepFrame(key === '.' ? 1 : -1)
        revealTimeline = true
        break
      case 'arrowleft': case 'arrowright': {
        const seconds = event.shiftKey ? 30 : onSeekInput && keyboardNavigation ? 1 : 5
        seek(key === 'arrowright' ? seconds : -seconds, event.repeat)
        revealTimeline = true
        break
      }
      case 'arrowup': case 'arrowdown': {
        const up = key === 'arrowup'
        if (event.shiftKey) {
          changeSubtitleTrack(up ? -1 : 1)
          feedback = subtitleFeedback('Subtitles: no')
        } else if (onSeekInput && keyboardNavigation) {
          seek(up ? 1 : -1, event.repeat)
          revealTimeline = true
        } else {
          video.volume = Math.min(1, Math.max(0, video.volume + (up ? 0.05 : -0.05)))
          feedback = `Volume: ${Math.round(video.volume * 100)}%`
        }
        break
      }
      case 'home': case 'end':
        if (!onSeekInput) return
        seekTo(key === 'end' ? timelineDuration : 0)
        revealTimeline = true
        break
      case 'm':
        if (event.repeat) return
        video.muted = !video.muted
        feedback = video.muted ? 'Muted' : 'Unmuted'
        break
      case 'pageup':
      case 'pagedown': {
        const forward = key === 'pagedown'
        if (event.shiftKey) {
          const entry = forward ? next : previous
          feedback = entry ? `Playing: ${entry.title || entry.name}` : `No ${forward ? 'next' : 'previous'} video`
          navigate(entry)
        } else {
          seekChapter(forward)
          revealTimeline = true
        }
        break
      }
      case '[': case ']':
        stepSpeed(key === ']' ? 1 : -1)
        feedback = `Playback speed: ${speed}x`
        break
      case 's':
        if (event.repeat) return
        toggleSubtitle()
        feedback = subtitleId ? 'Subtitles visible' : subtitleFeedback()
        break
      case 'a': case 'p': case 'q':
      case '?':
        if (event.repeat) return
        if (key === 'a') toggleKeyboardPanel('tracks', tracksButton ?? settingsButton)
        else if (key === 'p') feedback = toggleKeyboardPanel('queue', queueButton)
        else feedback = toggleKeyboardPanel(key === 'q' ? 'quality' : 'shortcuts', settingsButton)
        break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    if (feedback || revealTimeline) showShortcutFeedback(feedback, revealTimeline)
  }

  function handleKeyRelease(event: KeyboardEvent) {
    if (event.key === ' ' && playbackSpace) {
      playbackSpace = false
      // Some media controls activate on Space release even when keydown was handled.
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (scrubPointer === undefined && event.key.startsWith('Arrow')) commitSeek()
  }

  function playerLostFocus(event: KeyboardEvent) {
    // Removing a focused control can leave focus on the document while the modal remains open.
    return dialog?.open && (event.target === document.body || event.target === document.documentElement)
  }

  function showShortcutFeedback(text: string, revealTimeline = false) {
    shortcutFeedback = text
    showTimelineForShortcut = revealTimeline
    clearTimeout(shortcutTimer)
    shortcutTimer = setTimeout(() => {
      shortcutFeedback = ''
      showTimelineForShortcut = false
    }, 2000)
  }

  let volumeTimer: ReturnType<typeof setTimeout> | undefined
  function saveVolume() {
    clearTimeout(volumeTimer)
    volumeTimer = setTimeout(persistVolume, 300)
  }

  function persistVolume() {
    volumeTimer = undefined
    clientSettingsStore.update({ playerVolume: video.volume, playerMuted: video.muted })
  }

  async function initialize(signal: AbortSignal, chosenQuality?: WebQualityChoice) {
    loading = true
    error = ''
    try {
      const result = await getWebPlaybackInfo(item.id, signal)
      if (signal.aborted) return
      info = result
      const preferences = clientSettingsStore.settings
      const preferredQuality = chosenQuality ?? preferences.webQuality
      quality = result.qualities.some((entry) => entry === preferredQuality) ||
        (preferredQuality === 'audio' && result.audioConversion) ? preferredQuality : 'auto'
      audioIndex = (quality === 'original' ? defaultAudio :
        audioCapability.find((track) => matchesLanguage(track.language, preferences.audioLanguage)) ?? defaultAudio)?.index
      subtitleId = preferredSubtitle(result.subtitles, preferences.subtitleLanguage, preferences.subtitles)
      lastSubtitle = subtitleId
      lastSaved = result.position
      resumeAt = result.position
      await loadSource(false)
    } catch (reason) {
      if (!signal.aborted) {
        error = reason instanceof Error ? reason.message : 'Could not open the player.'
        loading = false
      }
    }
  }

  const lifecycle = new AbortController()
  onMount(() => {
    dialog.showModal()
    const preferences = clientSettingsStore.settings
    video.volume = Math.max(0, Math.min(1, Number(preferences.playerVolume) || 0))
    video.muted = preferences.playerMuted
    const pageHide = () => persist(true)
    window.addEventListener('pagehide', pageHide, { signal: lifecycle.signal })
    void getWebPlaybackQueue(item.id, lifecycle.signal).then((files) => {
      if (!lifecycle.signal.aborted) queue = files
    }).catch(() => {})
    openItem(initialQuality)
    return () => {
      persist(true)
      lifecycle.abort()
      opening?.abort()
      clearTimeout(shortcutTimer)
      clearTimeout(cursorTimer)
      cancelAnimationFrame(pointerFrame)
      if (volumeTimer) {
        clearTimeout(volumeTimer)
        persistVolume()
      }
      clearSource()
    }
  })

  $effect(() => {
    const track = info?.subtitles.find((subtitle) => subtitle.id === subtitleId)
    subtitleNotice = ''
    if (!track || !subtitleReady) return
    const controller = new AbortController()
    const slow = setTimeout(() => { subtitleNotice = 'Loading subtitle track...' }, 500)
    const onReady = () => {
      clearTimeout(slow)
      subtitleNotice = ''
    }
    const onError = () => {
      clearTimeout(slow)
      if (!controller.signal.aborted) subtitleNotice = 'This subtitle track could not be displayed.'
    }
    void openSubtitle({
      itemId: item.id, track, video, container: surface,
      source: info?.media?.tracks.find((stream) => stream.kind === 'video'),
      fonts: info?.media?.fonts ?? [], signal: controller.signal, delay: untrack(() => delay), onReady, onError
    }).then((subtitle) => {
      if (controller.signal.aborted) return
      renderer = subtitle
    }).catch(onError)
    return () => { clearTimeout(slow); controller.abort(); renderer = undefined }
  })

  $effect(() => { renderer?.setDelay(delay) })
  $effect(() => { renderer?.setPosition?.(subtitlePosition) })
</script>

{#snippet choice(group: string, label: string, selected: boolean, choose: () => void, detail?: string)}
  <label class="choice" class:selected>
    <input type="radio" name={group} checked={selected} onchange={choose} />
    <span class="choice-copy">
      <span>{label}</span>
      {#if detail}<small>{detail}</small>{/if}
    </span>
    {#if selected}<media-icon name="check" class="check" aria-hidden="true"></media-icon>{/if}
  </label>
{/snippet}

{#snippet settingsLink(icon: string, label: string, target: Panel, value?: string)}
  <button type="button" class="settings-link" onclick={() => openPanel(target)}>
    <media-icon name={icon} aria-hidden="true"></media-icon>
    <span>{label}</span>
    {#if value}<span class="setting-value">{value}</span>{/if}
    <media-icon class="forward" name="chevron" aria-hidden="true"></media-icon>
  </button>
{/snippet}

{#snippet subtitleAdjustment(label: string, value: string, adjust: (direction: number) => void, reset: () => void)}
  <div class="subtitle-adjustment" role="group" aria-label={label}>
    <span>{label}</span>
    <div class="subtitle-stepper">
      <button type="button" class="control" aria-label={`Decrease ${label.toLowerCase()}`} onclick={() => adjust(-1)}>-</button>
      <button type="button" class="control adjustment-value" aria-label={`Reset ${label.toLowerCase()}: ${value}`}
        title={`Reset ${label.toLowerCase()}`} onclick={reset}>{value}</button>
      <button type="button" class="control" aria-label={`Increase ${label.toLowerCase()}`} onclick={() => adjust(1)}>+</button>
    </div>
  </div>
{/snippet}

<svelte:window onpointerup={finishScrub} onpointercancel={finishScrub}
  onkeydowncapture={(event) => { if (playerLostFocus(event)) handleKey(event) }}
  onkeyupcapture={(event) => { if (playerLostFocus(event)) handleKeyRelease(event) }} />

<dialog bind:this={dialog} class="player-dialog" aria-label={title} onkeydowncapture={handleKey} onkeyupcapture={handleKeyRelease}
  onkeydown={(event) => event.stopPropagation()}
  onpointerdown={dismissPanelOnPointerDown} onpointerenter={revealNearPointer} onpointermove={revealNearPointer} onpointerleave={resetProximity}
  oncancel={(event) => { event.preventDefault(); if (panel) closePanel(); else onClose() }}>
  <video-player>
    <media-container class="player" class:cursor-idle={cursorIdle}
      class:keep-controls={Boolean(panel || loading || error || playBlocked || subtitleNotice || showTimelineForShortcut || requestedPosition !== undefined)}
      aria-label={title}>
      <div class="video-surface" class:media-ready={mediaReady} bind:this={surface}
        style:--subtitle-scale={subtitleScale / 100} style:--subtitle-position={`${subtitlePosition}%`}>
        <video bind:this={video} class:subtitle-scaled={subtitleScale !== 100} playsinline preload="auto"
          onclick={tapVideo} ondblclick={doubleClickVideo} onvolumechange={saveVolume}></video>
        {#if error}
          <div class="playback-error" role="alert">
            <h2>Couldn't play this video</h2>
            <p>{error}</p>
            <button class="primary" onclick={() => info ? loadSource(false) : openItem(quality)}>Retry playback</button>
          </div>
        {:else if loading}
          <div class="buffering" role="status" aria-label={mediaReady ? 'Buffering' : 'Opening video'}>
            <span class="spinner"></span>
          </div>
        {:else if playBlocked || paused}
          <button class="center-play" onclick={togglePlayback} aria-label="Play video" title="Play video">
            <media-icon name="play" aria-hidden="true"></media-icon>
          </button>
        {/if}
      </div>
      <div class="shortcut-feedback" role="status">{shortcutFeedback}</div>

      <header class="player-header chrome" bind:this={chromeHeader}>
        <button type="button" class="control back-button" title="Close player (Esc)" aria-label="Close player" onclick={onClose}>
          <media-icon name="chevron" aria-hidden="true"></media-icon>
        </button>
        <div class="title">
          <h1>{title}</h1>
          {#if streamDescription}
            <p>{streamDescription}{width && height ? ` (${width} x ${height})` : ''}</p>
          {/if}
        </div>
      </header>

      <footer class="player-footer chrome" bind:this={chromeFooter}>
        {#if subtitleNotice}<p class="subtitle-notice" role="status">{subtitleNotice}</p>{/if}
        {#if panel}
          <section class="control-panel" id="player-control-panel" aria-labelledby="player-panel-heading" bind:this={panelElement}>
            <header class="panel-header">
              {#if panel !== 'tracks' && panel !== 'queue' && panel !== 'settings'}
                <button type="button" class="control back-button" aria-label="Back to playback settings" onclick={() => openPanel('settings')}>
                  <media-icon name="chevron" aria-hidden="true"></media-icon>
                </button>
              {/if}
              <h2 id="player-panel-heading" tabindex="-1" bind:this={panelHeading}>{panelTitles[panel]}</h2>
              <button type="button" class="control panel-close" aria-label="Close playback panel" onclick={() => closePanel()}>
                <svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            </header>
            {#if panel === 'tracks'}
              <div class="panel-body">
                <div class="track-groups">
                  <fieldset>
                    <legend>Audio</legend>
                    {#if audioCapability.length}
                      {#if canSwitchAudio}
                        {#each audioCapability as track (track.index)}
                          {@render choice('player-audio', track.title || languageName(track.language), track.index === audioIndex,
                            () => selectAudio(track.index), [track.codec?.toUpperCase(), track.channels ? `${track.channels} ch` : ''].filter(Boolean).join(', '))}
                        {/each}
                      {:else if audioCapability.length > 1}
                        <p class="panel-note">Audio switching requires playback conversion.</p>
                      {:else}
                        <p class="panel-note">{audioCapability[0].title || languageName(audioCapability[0].language)}</p>
                      {/if}
                    {:else}
                      <p class="panel-note">No audio tracks available</p>
                    {/if}
                  </fieldset>
                  <fieldset>
                    <legend>Subtitles</legend>
                    {#if info?.subtitles.length}
                      {@render choice('player-subtitles', 'Off', !subtitleId, () => setSubtitle(''))}
                      {#each info.subtitles as track (track.id)}
                        {@render choice('player-subtitles', track.title || languageName(track.language), subtitleId === track.id,
                          () => setSubtitle(track.id), [
                            track.format === 'text' ? 'Text' : track.format.toUpperCase(),
                            track.forced ? 'Forced' : '', track.hearingImpaired ? 'SDH' : ''
                          ].filter(Boolean).join(', '))}
                      {/each}
                    {:else}
                      <p class="panel-note">No subtitle tracks available</p>
                    {/if}
                  </fieldset>
                </div>
                {#if info?.subtitles.length}
                  <div class="subtitle-adjustments">
                    {@render subtitleAdjustment('Subtitle delay', delayLabel, (step) => changeDelay(step * 0.1), () => (delay = 0))}
                    {@render subtitleAdjustment('Subtitle scale', `${subtitleScale}%`, (step) => changeSubtitleScale(step * 10), () => (subtitleScale = 100))}
                    {@render subtitleAdjustment('Subtitle position', subtitlePositionLabel, (step) => changeSubtitlePosition(step * 5), () => (subtitlePosition = 0))}
                  </div>
                {/if}
              </div>
            {:else if panel === 'queue'}
              <div class="panel-body">
                {#each queue ?? [] as entry (entry.id)}
                  <button type="button" class="settings-link queue-entry" aria-current={entry.id === item.id ? 'true' : undefined}
                    onclick={() => navigate(entry)}>
                    <span class="choice-copy">
                      <span>{entry.title || entry.name}</span>
                      {#if episodeLabel(entry)}<small>{episodeLabel(entry)}</small>{/if}
                    </span>
                    {#if entry.id === item.id}<media-icon name="play" class="check" aria-hidden="true"></media-icon>{/if}
                  </button>
                {/each}
              </div>
            {:else if panel === 'settings'}
              <div class="panel-body">
                {@render settingsLink('quality', 'Video quality', 'quality', webQualityLabel(quality))}
                {#if chapters.length}{@render settingsLink('switches', 'Chapters', 'chapters')}{/if}
                {@render settingsLink('speed', 'Playback speed', 'speed', `${speed}x`)}
                {#if availablePlayers.length}{@render settingsLink('play', 'Play with', 'external')}{/if}
                {@render settingsLink('switches', 'Keyboard shortcuts', 'shortcuts')}
              </div>
            {:else if panel === 'chapters'}
              <div class="panel-body">
                {#each chapters as chapter, index (chapter.startSeconds)}
                  <button type="button" class="settings-link queue-entry" aria-current={index === chapterIndex ? 'true' : undefined}
                    onclick={() => { seekTo(chapter.startSeconds); closePanel() }}>
                    <span class="choice-copy chapter-title" style:--chapter-color={chapterHighlights.labels[index]}>{chapterTitle(chapter, index)}</span>
                    <span class="setting-value">{chapterTime(chapter)}</span>
                  </button>
                {/each}
              </div>
            {:else if panel === 'quality'}
              <fieldset class="panel-body" aria-label="Video quality">
                {#if info}
                  {#each qualityChoices as value (value)}
                    {@render choice('player-quality', webQualityLabel(value), quality === value, () => selectQuality(value))}
                  {/each}
                {:else}
                  <p class="panel-note">Video qualities are unavailable.</p>
                {/if}
              </fieldset>
            {:else if panel === 'speed'}
              <fieldset class="panel-body speed-choices" aria-label="Playback speed">
                {#each speeds as rate (rate)}
                  {@render choice('player-speed', rate === 1 ? 'Normal (1x)' : `${rate}x`, speed === rate, () => setSpeed(rate))}
                {/each}
              </fieldset>
            {:else if panel === 'external'}
              <div class="panel-body">
                {#each availablePlayers as player (player.id)}
                  <button type="button" class="settings-link external-player" onclick={() => launchExternal(player.id)}>{player.name}</button>
                {/each}
              </div>
            {:else}
              <dl class="panel-body shortcuts">
                <dt><kbd>Space</kbd> / <kbd>K</kbd></dt><dd>Play or pause</dd>
                <dt><kbd>Left</kbd> <kbd>Right</kbd></dt><dd>Seek 5 seconds (Shift for 30)</dd>
                <dt><kbd>,</kbd> <kbd>.</kbd></dt><dd>Previous or next frame</dd>
                <dt><kbd>Up</kbd> <kbd>Down</kbd> / <kbd>M</kbd></dt><dd>Volume or mute</dd>
                <dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Playback speed</dd>
                <dt><kbd>A</kbd> / <kbd>Q</kbd> / <kbd>P</kbd></dt><dd>Audio & subtitles, quality, or queue</dd>
                <dt><kbd>S</kbd></dt><dd>Toggle subtitles</dd>
                <dt><kbd>Shift</kbd> + <kbd>Up</kbd> <kbd>Down</kbd></dt><dd>Previous or next subtitle track</dd>
                <dt><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Up</kbd> <kbd>Down</kbd></dt><dd>Subtitle scale</dd>
                <dt><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Left</kbd> <kbd>Right</kbd></dt><dd>Subtitle delay</dd>
                <dt><kbd>PgUp</kbd> <kbd>PgDn</kbd></dt><dd>Previous or next chapter</dd>
                <dt><kbd>Shift</kbd> + <kbd>PgUp</kbd> <kbd>PgDn</kbd></dt><dd>Previous or next video</dd>
                <dt><kbd>F</kbd> / <kbd>Esc</kbd></dt><dd>Fullscreen or close</dd>
                <dt><kbd>?</kbd></dt><dd>Keyboard shortcuts</dd>
              </dl>
            {/if}
          </section>
        {/if}

        <div class="transport">
          <div class="transport-group">
            <button type="button" class="control play-button" title="Play or pause (Space)"
              aria-label={paused ? 'Play' : 'Pause'} aria-keyshortcuts="Space K" disabled={!mediaReady} onclick={togglePlayback}>
              <media-icon name={paused ? 'play' : 'pause'} aria-hidden="true"></media-icon>
            </button>
            {#if audioCapability.length || info?.subtitles.length}
              <button type="button" class="control" aria-label="Audio & subtitles" title="Audio & subtitles (A)" bind:this={tracksButton}
                data-panel-trigger aria-expanded={panel === 'tracks'} aria-controls={panel === 'tracks' ? 'player-control-panel' : undefined}
                onclick={(event) => panel === 'tracks' ? closePanel() : openPanel('tracks', event.currentTarget)}>
                <media-icon name={subtitleId ? 'captions-on' : 'captions-off'} aria-hidden="true"></media-icon>
              </button>
            {/if}
            <div class="jump-buttons">
              <button class="control jump" type="button" aria-label="Back 10 seconds" title="Back 10 seconds" disabled={!mediaReady} onclick={() => seek(-10)}>
                <span aria-hidden="true">-10</span>
              </button>
              <button class="control jump" type="button" aria-label="Forward 10 seconds" title="Forward 10 seconds" disabled={!mediaReady} onclick={() => seek(10)}>
                <span aria-hidden="true">+10</span>
              </button>
            </div>
            <media-mute-button class="control mute-button" title="Mute (M)">
              <media-icon name="volume-high" class="volume-icon" aria-hidden="true"></media-icon>
              <media-icon name="volume-off" class="mute-icon" aria-hidden="true"></media-icon>
            </media-mute-button>
            <media-volume-slider class="volume-slider">
              <media-slider-track class="slider-track"><media-slider-fill class="slider-fill"></media-slider-fill></media-slider-track>
              <media-slider-thumb class="slider-thumb"></media-slider-thumb>
            </media-volume-slider>

            <button type="button" class="control" aria-label="Playback settings" title="Playback settings"
              bind:this={settingsButton} data-panel-trigger aria-expanded={settingsOpen}
              aria-controls={settingsOpen ? 'player-control-panel' : undefined}
              onclick={(event) => settingsOpen ? closePanel() : openPanel('settings', event.currentTarget)}>
              <media-icon name="gear" aria-hidden="true"></media-icon>
            </button>
          </div>
          <div class="transport-group tools">
            <button class="control playlist-step previous" type="button" aria-label="Previous video"
              title={previous ? `Previous: ${previous.title || previous.name}` : 'Previous video'}
              disabled={!previous} onclick={() => navigate(previous)}>
              <media-icon name="chevron" aria-hidden="true"></media-icon>
            </button>
            <button class="control queue-button" type="button" aria-label="Playback queue" title="Playback queue"
              bind:this={queueButton} data-panel-trigger disabled={!queue.length} aria-expanded={panel === 'queue'}
              aria-controls={panel === 'queue' ? 'player-control-panel' : undefined}
              onclick={(event) => panel === 'queue' ? closePanel() : openPanel('queue', event.currentTarget)}>
              <svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <path d="M8 8h8M8 12h8M8 16h8" />
              </svg>
            </button>
            <button class="control playlist-step" type="button" aria-label="Next video"
              title={next ? `Next: ${next.title || next.name}` : 'Next video'}
              disabled={!next} onclick={() => navigate(next)}>
              <media-icon name="chevron" aria-hidden="true"></media-icon>
            </button>
            <media-fullscreen-button class="control fullscreen-button" title="Fullscreen (F)" bind:this={fullscreenButton}>
              <media-icon name="fullscreen-enter" class="fullscreen-enter" aria-hidden="true"></media-icon>
              <media-icon name="fullscreen-exit" class="fullscreen-exit" aria-hidden="true"></media-icon>
            </media-fullscreen-button>
          </div>
        </div>
        <div class="timeline">
          <div class="seek-slider" class:scrubbing={scrubPointer !== undefined}>
            {#if mediaReady && timelineDuration > 0}
              {#each chapterHighlights.ranges as range}
                {#if range.startSeconds < timelineDuration}
                  <span class="chapter-range" aria-hidden="true" style:background={range.color}
                    style:left={`${range.startSeconds / timelineDuration * 100}%`}
                    style:right={`${(1 - Math.min(range.endSeconds ?? timelineDuration, timelineDuration) / timelineDuration) * 100}%`}></span>
                {/if}
              {/each}
            {/if}
            <span class="slider-thumb" aria-hidden="true" style:left={`${timelineDuration ? playhead / timelineDuration * 100 : 0}%`}></span>
            <span class="time-elapsed" aria-hidden="true">{clockTime(playhead)}</span>
            <span class="time-remaining" aria-hidden="true">-{clockTime(timelineDuration - playhead)}</span>
            {#if previewPosition !== undefined && timelineDuration > 0}
              <div class="seek-preview timeline-tip" aria-hidden="true" style:--preview-ratio={previewPosition / timelineDuration}>
                {#if previewChapter}<span class="timeline-tip-title">{chapterTitle(previewChapter, previewChapterIndex)}</span>{/if}
                <time class="timeline-tip-time">{clockTime(previewPosition)}</time>
              </div>
            {/if}
            <input bind:this={seekInput} type="range" class="seek-input" min="0" max={timelineDuration || 1} step="any"
              disabled={!mediaReady || !timelineDuration} value={playhead} aria-label="Seek"
              aria-valuetext={`${clockTime(playhead)} of ${clockTime(timelineDuration)}`}
              onpointerdown={startScrub} oninput={updateScrub}
              onpointermove={updateSeekPreview} onpointerleave={() => (pointerPosition = undefined)} />
          </div>
          {#if mediaReady && timelineDuration > 0}
            {#each chapters as chapter, index (chapter.startSeconds)}
              {#if chapter.startSeconds < timelineDuration}
                <button type="button" class="chapter-marker" data-testid="chapter-marker"
                  style:--chapter-position={`${chapter.startSeconds / timelineDuration * 100}%`}
                  aria-label={`${chapterTitle(chapter, index)} at ${chapterTime(chapter)}`}
                  onpointerenter={() => (pointedChapter = index)} onpointerleave={() => (pointedChapter = -1)}
                  onfocus={(event) => { if (event.currentTarget.matches(':focus-visible')) focusedChapter = index }}
                  onblur={() => (focusedChapter = -1)}
                  onclick={() => seekTo(chapter.startSeconds)}></button>
              {/if}
            {/each}
            {#if chapterHint}
              <div class="chapter-hint timeline-tip" class:align-right={chapterHint.startSeconds >= timelineDuration / 2} aria-hidden="true"
                style:--chapter-position={`${chapterHint.startSeconds / timelineDuration * 100}%`}>
                <span class="timeline-tip-title">{chapterTitle(chapterHint, chapterHintIndex)}</span>
                <time class="timeline-tip-time">{chapterTime(chapterHint)}</time>
              </div>
            {/if}
          {/if}
        </div>
      </footer>
      <NotificationContainer />
    </media-container>
  </video-player>
</dialog>

<style>
  .player-dialog, video-player, .player {
    display: block;
    width: 100%;
    height: 100%;
  }
  .player-dialog::backdrop, .player:fullscreen::backdrop { background: #000; }
  .player-dialog:not([open]) { display: none; }
  .player-dialog {
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    overflow: hidden;
    color-scheme: dark;
    background: #000;
  }
  .player {
    --player-accent: var(--color-primary-soft, #a6a5ff);
    --label-muted: #bbbcc6;
    --panel-bg: #18191f;
    --edge: clamp(0.75rem, 3.2vw, 2.8rem);
    --transport-height: 2.875rem;
    position: relative;
    isolation: isolate;
    -webkit-tap-highlight-color: transparent;
    color: #f7f7fa;
    background: #000;
  }
  .video-surface {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    overflow: hidden;
    container-type: size;
  }
  video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
  video.subtitle-scaled::cue {
    font-size: calc(5cqh * var(--subtitle-scale));
  }
  .video-surface:not(.media-ready) :global(.subtitle-canvas) { visibility: hidden; }
  .video-surface :global(.subtitle-canvas) {
    position: absolute;
    pointer-events: none;
    transform-origin: center 95%;
    transform: translateY(var(--subtitle-position)) scale(var(--subtitle-scale));
  }
  .player.cursor-idle, .player.cursor-idle :global(*) { cursor: none !important; }
  .shortcut-feedback {
    position: absolute;
    z-index: 3;
    inset-block-start: max(4.15rem, calc(env(safe-area-inset-top) + 3.4rem));
    inset-inline-start: max(var(--edge), env(safe-area-inset-left));
    max-width: calc(100% - 2 * var(--edge));
    padding: 0.4rem 0.7rem;
    border-radius: 0.35rem;
    background: #000d;
    color: #fff;
    font-size: clamp(1.05rem, 2vw, 1.3rem);
    font-weight: 600;
    overflow-wrap: anywhere;
    pointer-events: none;
  }
  .shortcut-feedback:empty { visibility: hidden; }
  .chrome {
    position: absolute;
    inset-inline: 0;
    z-index: 2;
    opacity: var(--reveal, 0);
    pointer-events: none;
    transition: opacity 140ms ease-out;
  }
  .chrome:global([data-near-pointer]) { pointer-events: auto; }
  .player.keep-controls .chrome,
  .player:has(:focus-visible, .seek-slider.scrubbing) .chrome {
    opacity: 1;
    pointer-events: auto;
  }
  @media (hover: none) {
    .player:global([data-controls-visible]) .chrome { opacity: 1; pointer-events: auto; }
  }
  .player-header {
    top: 0;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding-block: max(0.7rem, env(safe-area-inset-top)) 1.2rem;
    padding-inline: max(0.55rem, env(safe-area-inset-left)) max(0.55rem, env(safe-area-inset-right));
    background: linear-gradient(#000e, #0008 48%, #0000);
  }
  .title { min-width: 0; text-shadow: 0 1px 8px #000b; }
  h1 {
    margin: 0;
    font-size: clamp(1.02rem, 2.3vw, 1.45rem);
    line-height: 1.25;
    font-weight: 650;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .title p { margin: 0.22rem 0 0; font-size: 0.79rem; color: #dddde5; }
  .player-footer {
    bottom: 0;
    padding-bottom: env(safe-area-inset-bottom);
  }
  @media (hover: hover) {
    .player:not(:fullscreen) .player-footer { bottom: 24px; }
    .player:not(:fullscreen) .seek-slider { border-bottom: 1px solid var(--timeline-edge); }
    .player-footer:has(.timeline:hover) .transport { visibility: hidden; }
    .timeline:hover .chapter-hint { bottom: calc(100% + 0.4rem); }
  }
  .transport, .transport-group, .jump-buttons, .subtitle-stepper { display: flex; align-items: center; }
  .transport {
    justify-content: space-between;
    gap: 0.3rem;
    color: #fff;
    padding-inline: max(0.4rem, env(safe-area-inset-left)) max(0.4rem, env(safe-area-inset-right));
  }
  .transport-group { gap: clamp(0.1rem, 0.55vw, 0.5rem); }
  .transport .control > :is(media-icon, svg, span), .transport .volume-slider {
    filter: drop-shadow(0 1px 2px #000) drop-shadow(0 0 2px #000);
  }
  .tools { margin-inline-start: auto; }
  .control {
    box-sizing: border-box;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: var(--transport-height);
    height: var(--transport-height);
    padding: 0;
    border: 0;
    border-radius: 0.65rem;
    color: inherit;
    background: transparent;
    cursor: pointer;
    font: inherit;
  }
  .control:hover:not(:disabled), .control[aria-expanded="true"] { background: #ffffff22; }
  .control:global([aria-disabled="true"]) { cursor: default; opacity: 0.45; }
  .playlist-step:disabled { cursor: default; opacity: 1; }
  .control:focus-visible, .center-play:focus-visible, .settings-link:focus-visible,
  .choice:has(:focus-visible), .seek-slider:has(.seek-input:focus-visible), .volume-slider:has(.slider-thumb:focus-visible) {
    outline: 2px solid var(--player-accent);
    outline-offset: 1px;
  }
  media-icon { display: inline-flex; width: 1em; height: 1em; flex: none; font-size: 1.25rem; }
  .control-icon {
    width: 1.25rem;
    height: 1.25rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }
  .back-button media-icon { transform: rotate(180deg); }
  .back-button { border-radius: 50%; background: #15151bbd; }
  .play-button media-icon { font-size: 1.45rem; }
  .center-play, .buffering, .playback-error { z-index: 1; }
  .center-play {
    display: grid;
    place-items: center;
    width: clamp(3.6rem, 8vw, 5rem);
    aspect-ratio: 1;
    padding: 0;
    border-radius: 50%;
    border: 1px solid #ffffff4d;
    background: #111117e6;
    color: white;
    box-shadow: 0 6px 24px #0006;
  }
  .center-play:hover:not(:disabled) { background: #2b2b36; }
  .center-play media-icon { transform: scale(1.5); }
  .buffering { pointer-events: none; }
  .spinner {
    display: block;
    width: 2.4rem;
    height: 2.4rem;
    border-radius: 50%;
    border: 2px solid #ffffff55;
    border-top-color: white;
    animation: spin 0.85s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .playback-error {
    text-align: center;
    max-width: min(28rem, calc(100vw - 2rem));
    padding: 1.4rem;
    border: 1px solid #ffffff28;
    border-radius: 1rem;
    background: var(--panel-bg);
  }
  .playback-error p { color: var(--label-muted); margin: 0.5rem 0 1rem; }
  .jump { font-size: 0.85rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .previous media-icon { transform: rotate(180deg); }
  .mute-icon, .fullscreen-exit,
  media-mute-button:global([data-muted]) .volume-icon,
  media-fullscreen-button:global([data-fullscreen]) .fullscreen-enter { display: none; }
  media-mute-button:global([data-muted]) .mute-icon,
  media-fullscreen-button:global([data-fullscreen]) .fullscreen-exit { display: inline-flex; }
  .seek-slider, .volume-slider {
    position: relative;
    display: grid;
    align-items: center;
    height: 1.65rem;
    cursor: pointer;
    touch-action: none;
  }
  .seek-slider {
    --timeline-edge: #ffffff23;
    height: clamp(1.85rem, 4.25vh, 2.65rem);
    border-top: 1px solid var(--timeline-edge);
    background: #000;
  }
  .seek-input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    opacity: 0;
    cursor: inherit;
    touch-action: none;
    appearance: none;
  }
  .seek-input::-webkit-slider-thumb {
    width: 1px;
    height: 100%;
    appearance: none;
  }
  .seek-input::-moz-range-thumb { width: 1px; border: 0; }
  .time-elapsed, .time-remaining {
    position: absolute;
    font-size: 0.8rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    text-shadow: 0 1px 2px #000;
    pointer-events: none;
  }
  .time-elapsed { inset-inline-start: max(0.65rem, env(safe-area-inset-left)); }
  .time-remaining { inset-inline-end: max(0.65rem, env(safe-area-inset-right)); }

  .timeline { position: relative; }
  .chapter-range {
    position: absolute;
    inset-block: 0;
    pointer-events: none;
  }
  .chapter-marker {
    --marker-width: 1.5rem;
    position: absolute;
    z-index: 1;
    top: 0;
    left: clamp(var(--marker-width) / 2, var(--chapter-position), 100% - var(--marker-width) / 2);
    transform: translate(-50%, -50%);
    display: grid;
    place-items: center;
    width: var(--marker-width);
    height: 1.6rem;
    padding: 0;
    background: transparent;
    border-radius: 0.25rem;
  }
  .chapter-marker:hover:not(:disabled), .chapter-marker:active:not(:disabled) {
    background: transparent;
    transform: translate(-50%, -50%);
  }
  .chapter-marker::after {
    content: '';
    width: 0.46rem;
    height: 0.46rem;
    transform: rotate(45deg);
    background: #e8e9ed;
    border: 1px solid #000;
  }
  .chapter-marker:hover::after, .chapter-marker:focus-visible::after {
    background: white;
    transform: rotate(45deg) scale(1.35);
  }
  .chapter-hint {
    position: absolute;
    z-index: 2;
    bottom: calc(100% + var(--transport-height));
    width: max-content;
    max-width: min(18rem, calc(100% - var(--chapter-position) - 0.7rem));
    left: max(0.45rem, calc(var(--chapter-position) - 0.6rem));
    pointer-events: none;
  }
  .chapter-hint.align-right {
    left: auto;
    right: max(0.45rem, calc(100% - var(--chapter-position) - 0.6rem));
    max-width: min(18rem, calc(var(--chapter-position) - 0.7rem));
  }
  .seek-slider:has(.seek-preview) ~ .chapter-hint { visibility: hidden; }
  .chapter-title { color: var(--chapter-color, inherit); }
  .seek-slider:has(.seek-input:disabled) { opacity: 0.5; cursor: default; }
  .volume-slider { width: clamp(3.25rem, 7vw, 5.25rem); }
  .slider-track { position: relative; display: block; height: 4px; border-radius: 5px; background: #ffffff4a; }
  .slider-fill { position: absolute; display: block; inset: 0 auto 0 0; border-radius: inherit; }
  .slider-fill { width: var(--media-slider-fill, 0%); background: var(--player-accent); }
  .slider-thumb {
    position: absolute;
    left: var(--media-slider-fill, 0%);
    width: 0.67rem;
    height: 0.67rem;
    border-radius: 50%;
    transform: translateX(-50%);
    background: #f9f8ff;
    box-shadow: 0 1px 5px #0009;
  }
  .seek-slider .slider-thumb {
    width: 2px;
    height: 100%;
    border-radius: 0;
    background: #fff;
    pointer-events: none;
  }
  .seek-slider:is(:hover, .scrubbing, :focus-within) .slider-thumb { width: 3px; }
  .seek-preview {
    position: absolute;
    bottom: calc(100% + 0.4rem);
    left: calc(var(--preview-ratio) * 100%);
    transform: translateX(calc(var(--preview-ratio) * -100%));
    max-width: min(18rem, 100%);
    pointer-events: none;
  }
  .timeline-tip {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    color: #fff;
    text-align: center;
  }
  .timeline-tip-title, .timeline-tip-time {
    background: #000;
    border-radius: 0.25rem;
    padding: 0.3rem 0.55rem;
  }
  .timeline-tip-title {
    max-width: 100%;
    box-sizing: border-box;
    overflow-wrap: anywhere;
    font-size: 1.05rem;
    font-weight: 650;
  }
  .timeline-tip-time {
    font-size: 0.78rem;
    font-weight: 600;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .control-panel {
    position: absolute;
    z-index: 3;
    --gutter-left: max(var(--edge), env(safe-area-inset-left));
    --gutter-right: max(var(--edge), env(safe-area-inset-right));
    --panel-width: min(23rem, calc(100% - var(--gutter-left) - var(--gutter-right)));
    left: clamp(calc(var(--gutter-left) + var(--panel-width) / 2), var(--anchor-x, 50%),
      calc(100% - var(--gutter-right) - var(--panel-width) / 2));
    transform: translateX(-50%);
    bottom: calc(100% + 0.4rem);
    width: var(--panel-width);
    max-height: min(33rem, calc(100dvh - 8rem));
    overflow: auto;
    overscroll-behavior: contain;
    border: 1px solid #ffffff26;
    border-radius: 1rem;
    background: var(--panel-bg);
    box-shadow: 0 10px 35px #000a;
  }
  .control-panel:has(.track-groups) {
    --panel-width: min(35rem, calc(100% - var(--gutter-left) - var(--gutter-right)));
  }
  .panel-header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.45rem 0.6rem 0.45rem 1rem;
    border-bottom: 1px solid #ffffff16;
    background: var(--panel-bg);
  }
  h2 { margin: 0; font-size: 1.025rem; font-weight: 650; }
  .panel-header h2:focus { outline: none; }
  .panel-header .back-button { margin-inline-start: -0.5rem; background: transparent; }
  .panel-close { margin-inline-start: auto; color: var(--label-muted); }
  .panel-body { margin: 0; padding: 0.6rem; }
  fieldset { min-width: 0; margin: 0; border: 0; }
  .track-groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.6rem; }
  .track-groups fieldset { padding: 0; }
  legend { padding: 0.45rem 0.6rem; color: var(--label-muted); font-size: 0.82rem; font-weight: 600; }
  .choice, .settings-link {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-height: 2.7rem;
    padding: 0.42rem 0.6rem;
    border-radius: 0.55rem;
    font-size: 0.87rem;
    font-weight: 600;
    cursor: pointer;
  }
  .choice input { position: absolute; inset-inline-start: 0.65rem; opacity: 0; pointer-events: none; }
  @media (hover: hover) {
    .choice:hover, .settings-link:hover:not(:disabled) { background: #ffffff13; }
  }
  .choice.selected, .queue-entry[aria-current="true"] { background: #ffffff18; }
  .choice-copy { min-width: 0; display: grid; gap: 0.14rem; overflow-wrap: anywhere; }
  .choice-copy small, .panel-note { color: var(--label-muted); font-size: 0.76rem; }
  .panel-note { margin: 0.55rem 0.6rem; }
  .check { margin-inline-start: auto; color: var(--player-accent); font-size: 1rem; }
  .settings-link { width: 100%; background: transparent; text-align: start; color: inherit; }
  .settings-link .forward { color: var(--label-muted); margin-inline-start: auto; font-size: 0.9rem; }
  .setting-value { margin-inline-start: auto; color: var(--label-muted); text-align: end; font-size: 0.79rem; }
  .setting-value + .forward { margin-inline-start: 0; }
  .speed-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 0.2rem; }
  .subtitle-adjustments {
    margin-top: 0.5rem;
    padding: 0.35rem 0.6rem 0;
    border-top: 1px solid #ffffff16;
  }
  .subtitle-adjustment {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.45rem;
    font-size: 0.85rem;
  }
  .subtitle-stepper { gap: 0.2rem; }
  .subtitle-stepper .control { width: 2rem; height: 2.15rem; }
  .subtitle-stepper .adjustment-value {
    width: 5.9rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .subtitle-notice {
    position: absolute;
    inset-inline-start: max(var(--edge), env(safe-area-inset-left));
    bottom: calc(100% + 0.4rem);
    max-width: min(24rem, calc(100vw - 2 * var(--edge)));
    margin: 0;
    padding: 0.5rem 0.7rem;
    border-radius: 0.5rem;
    color: white;
    background: var(--panel-bg);
    font-size: 0.83rem;
  }
  .shortcuts {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: baseline;
    gap: 0.55rem 0.85rem;
    padding: 1rem;
    font-size: 0.83rem;
  }
  .shortcuts dd { margin: 0; color: var(--label-muted); }
  kbd { padding: 0.1rem 0.27rem; border-radius: 0.25rem; background: #ffffff16; }
  @media (max-width: 740px) {
    .jump-buttons { display: none; }
  }
  @media (max-width: 460px) {
    .volume-slider { display: none; }
    .track-groups { grid-template-columns: minmax(0, 1fr); }
    .control-panel { max-height: min(33rem, calc(100dvh - 7rem)); }

  }
  @media (max-width: 370px) {
    .player { --transport-height: 2.75rem; }
    .transport-group { gap: 0; }
    .mute-button { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .chrome { transition: none; } }
</style>
