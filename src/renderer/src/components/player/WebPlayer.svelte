<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import type HlsType from 'hls.js'
  import type { ErrorData } from 'hls.js'
  import '@videojs/html/video/player'
  import '@videojs/html/ui/container'
  import '@videojs/html/ui/fullscreen-button'
  import '@videojs/html/ui/mute-button'
  import '@videojs/html/ui/play-button'
  import '@videojs/html/ui/slider-track'
  import '@videojs/html/ui/slider-buffer'
  import '@videojs/html/ui/slider-fill'
  import '@videojs/html/ui/slider-thumb'
  import '@videojs/html/ui/time-slider'
  import '@videojs/html/ui/volume-slider'
  import '@videojs/html/ui/time'
  import '@videojs/html/icons/element'
  import NotificationContainer from '@ui/NotificationContainer.svelte'
  import { authStore } from '@lib/auth-store.svelte'
  import { clientSettingsStore } from '@lib/client-settings-store.svelte'
  import { BUILTIN_WEB_PLAYER, playerLauncherService, resolveClientPlayers, resolvePlaybackQuality } from '@lib/services/player-launcher.service'
  import {
    automaticQualities, browserPlaybackUrl, getWebPlaybackInfo, hlsMime, languageName,
    matchesLanguage, preferredSubtitle, storePlaybackPosition
  } from '@lib/services/web-playback.service'
  import { webQualityLabel, type WebPlaybackInfo, type WebPlaybackQuality, type WebQualityChoice } from '@shared/web-playback'
  import type { MediaFile, Settings } from '@shared/types'
  import { openSubtitle, type SubtitleRenderer } from './subtitles'

  let { item, settings, initialQuality, onClose }: {
    item: MediaFile
    settings: Settings | null
    initialQuality?: WebQualityChoice
    onClose: () => void
  } = $props()

  let dialog: HTMLDialogElement
  let video: HTMLVideoElement
  let surface: HTMLDivElement
  let fullscreenButton: HTMLElement

  let info = $state<WebPlaybackInfo>()
  let quality = $state<WebQualityChoice>('auto')
  let activeQuality = $state<WebPlaybackQuality>()
  let audioIndex = $state<number>()
  let subtitleId = $state('')
  let lastSubtitle = ''
  let delay = $state(0)
  let speed = $state(1)
  let paused = $state(true)
  let loading = $state(true)
  let mediaReady = $state(false)
  let error = $state('')
  let subtitleReady = $state(false)
  let subtitleNotice = $state('')
  let showOptions = $state(false)
  let showKeys = $state(false)
  let playBlocked = $state(false)
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
  let audioCapability = $derived(info?.media?.tracks.filter((track) => track.kind === 'audio') ?? [])
  let defaultAudio = $derived(audioCapability.find((track) => track.default) ?? audioCapability[0])
  let availablePlayers = $derived(resolveClientPlayers(settings?.playerCommands ?? [], clientSettingsStore.settings.enabledPlayerIds)
    .filter((player) => player.id !== BUILTIN_WEB_PLAYER.id))
  const speeds = [0.25, 0.5, 0.75, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
  const title = $derived(item.title || item.name)

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
      if (lastSaved === position) lastSaved = -1
    })
  }

  function clearSource() {
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
          resumeAt = video.currentTime
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
      listen('loadedmetadata', () => {
        if (!video.videoWidth && info?.media?.tracks.some((track) => track.kind === 'video')) {
          failed('The browser could decode the audio but could not decode the video.')
          return
        }
        if (resumeAt > 0 && Number.isFinite(video.duration)) {
          video.currentTime = Math.min(resumeAt, Math.max(0, video.duration - 0.1))
        }
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
        paused = false
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
      listen('timeupdate', () => persist())
      listen('ended', () => {
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

  function selectAudio(value: string) {
    audioIndex = value ? Number(value) : undefined
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

  function seek(seconds: number) {
    if (mediaReady && Number.isFinite(video.duration)) {
      video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + seconds))
    }
  }

  function setSpeed(rate: number) {
    speed = rate
    video.playbackRate = rate
    video.defaultPlaybackRate = rate
  }

  function togglePlayback() {
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

  function handleKey(event: KeyboardEvent) {
    event.stopPropagation()
    if (event.defaultPrevented) return
    if (event.key === 'Escape') {
      if (document.fullscreenElement) return
      event.preventDefault()
      if (showKeys) showKeys = false
      else if (showOptions) showOptions = false
      else onClose()
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const target = event.target
    if (target instanceof Element && target.closest('input, select, textarea, [contenteditable], [role="slider"]')) return
    const key = event.key.toLowerCase()
    if ((key === ' ' || key === 'enter') && target instanceof Element && target.closest('button, [role="button"]')) return
    switch (key) {
      case ' ': case 'k': togglePlayback(); break
      case 'arrowleft': seek(event.shiftKey ? -30 : -5); break
      case 'arrowright': seek(event.shiftKey ? 30 : 5); break
      case 'arrowup': video.volume = Math.min(1, video.volume + 0.05); break
      case 'arrowdown': video.volume = Math.max(0, video.volume - 0.05); break
      case 'm': video.muted = !video.muted; break
      case 'f': fullscreenButton.click(); break
      case '[': stepSpeed(-1); break
      case ']': stepSpeed(1); break
      case 'v': toggleSubtitle(); break
      case 'j': {
        const tracks = ['', ...(info?.subtitles.map((track) => track.id) ?? [])]
        setSubtitle(tracks[(tracks.indexOf(subtitleId) + 1) % tracks.length])
        break
      }
      case 'z': changeDelay(-0.1); break
      case 'x': changeDelay(0.1); break
      case '?': showKeys = !showKeys; break
      default: return
    }
    event.preventDefault()
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

  async function initialize(signal: AbortSignal) {
    loading = true
    error = ''
    try {
      const result = await getWebPlaybackInfo(item.id, signal)
      if (signal.aborted) return
      info = result
      const preferences = clientSettingsStore.settings
      const preferredQuality = initialQuality ?? preferences.webQuality
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
    void initialize(lifecycle.signal)
    return () => {
      persist(true)
      lifecycle.abort()
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
    const slow = setTimeout(() => { subtitleNotice = 'Loading subtitle track…' }, 500)
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
      renderer?.setDelay(delay)
    }).catch(onError)
    return () => { clearTimeout(slow); controller.abort(); renderer = undefined }
  })

  $effect(() => { renderer?.setDelay(delay) })
</script>

<dialog bind:this={dialog} class="player-dialog" aria-label={title} onkeydown={handleKey}
  oncancel={(event) => { event.preventDefault(); onClose() }}>
  <video-player>
    <media-container class="player" class:options-visible={showOptions || showKeys} aria-label={title}>
      <header class="player-header">
        <button type="button" class="icon-button back-button" title="Close player (Esc)" aria-label="Close player" onclick={onClose}>
          <span aria-hidden="true">‹</span>
        </button>
        <div class="title">
          <h1>{title}</h1>
          {#if streamDescription}
            <span>{streamDescription}{width && height ? ` · ${width}×${height}` : ''}</span>
          {/if}
        </div>
      </header>

      <div class="video-surface" class:media-ready={mediaReady} bind:this={surface}>
        <video bind:this={video} playsinline preload="auto" onclick={togglePlayback} onvolumechange={saveVolume}></video>
        {#if error}
          <div class="player-message" role="alert">
            <p>{error}</p>
            <button class="secondary" onclick={() => info ? loadSource(false) : initialize(lifecycle.signal)}>Retry</button>
          </div>
        {:else if loading}
          <div class="player-message loading" role="status" aria-label="Loading video"><span></span></div>
        {:else if playBlocked || paused}
          <button class="center-play" onclick={togglePlayback} aria-label="Play video" title="Play video">
            <media-icon name="play"></media-icon>
          </button>
        {/if}
      </div>

      <div class="player-footer">
        {#if subtitleNotice}<p class="subtitle-notice" role="status">{subtitleNotice}</p>{/if}
        {#if showOptions || showKeys}
          <section class="player-options" aria-label={showKeys ? 'Keyboard shortcuts' : 'Playback options'}>
            {#if showKeys}
              <h2>Keyboard shortcuts</h2>
              <dl class="shortcuts">
                <dt><kbd>Space</kbd> / <kbd>K</kbd></dt><dd>Play or pause</dd>
                <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Seek 5s (Shift for 30s)</dd>
                <dt><kbd>↑</kbd> <kbd>↓</kbd> / <kbd>M</kbd></dt><dd>Volume or mute</dd>
                <dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Playback speed</dd>
                <dt><kbd>J</kbd> / <kbd>V</kbd></dt><dd>Cycle or toggle subtitles</dd>
                <dt><kbd>Z</kbd> <kbd>X</kbd></dt><dd>Subtitle delay</dd>
                <dt><kbd>F</kbd> / <kbd>Esc</kbd></dt><dd>Fullscreen or close</dd>
              </dl>
            {:else}
              <label>Quality
                <select aria-label="Playback quality" value={quality} disabled={!info}
                  onchange={(event) => selectQuality(event.currentTarget.value as WebQualityChoice)}>
                  <option value="auto">{webQualityLabel('auto')}</option>
                  {#each info?.qualities ?? [] as entry (entry)}
                    <option value={entry}>{webQualityLabel(entry)}</option>
                  {/each}
                  {#if info?.audioConversion}<option value="audio">{webQualityLabel('audio')}</option>{/if}
                </select>
              </label>
              {#if audioCapability.length}
                <label>Audio
                  <select aria-label="Audio track" value={audioIndex ?? ''} disabled={audioCapability.length < 2 || info?.qualities.length === 1}
                    onchange={(event) => selectAudio(event.currentTarget.value)}>
                    {#each audioCapability as track (track.index)}
                      <option value={track.index}>
                        {track.title || languageName(track.language)}{track.codec ? ` · ${track.codec.toUpperCase()}` : ''}{track.channels ? ` · ${track.channels}ch` : ''}
                      </option>
                    {/each}
                  </select>
                </label>
              {/if}
              <label>Subtitles
                <select aria-label="Subtitle track" value={subtitleId} disabled={!info?.subtitles.length}
                  onchange={(event) => setSubtitle(event.currentTarget.value)}>
                  <option value="">{info?.subtitles.length ? 'Off' : 'No tracks available'}</option>
                  {#each info?.subtitles ?? [] as track (track.id)}
                    <option value={track.id}>
                      {track.title || languageName(track.language)} · {track.format === 'text' ? 'Text' : track.format.toUpperCase()}{track.forced ? ' · Forced' : ''}{track.hearingImpaired ? ' · SDH' : ''}
                    </option>
                  {/each}
                </select>
              </label>
              {#if subtitleId}
                <label>Subtitle delay
                  <span class="delay-control">
                    <button type="button" aria-label="Show subtitles earlier" onclick={() => changeDelay(-0.1)}>−</button>
                    <output>{delay > 0 ? '+' : ''}{delay.toFixed(1)} s</output>
                    <button type="button" aria-label="Show subtitles later" onclick={() => changeDelay(0.1)}>+</button>
                    <button type="button" aria-label="Reset subtitle delay" onclick={() => (delay = 0)}>Reset</button>
                  </span>
                </label>
              {/if}
              <label>Speed
                <select aria-label="Playback speed" value={speed} onchange={(event) => setSpeed(Number(event.currentTarget.value))}>
                  {#each speeds as rate (rate)}<option value={rate}>{rate}×</option>{/each}
                </select>
              </label>
              {#if availablePlayers.length}
                <label>Play with
                  <select aria-label="External player" value=""
                    onchange={(event) => {
                      const player = availablePlayers.find((candidate) => candidate.id === event.currentTarget.value)
                      if (player) {
                        const selected = quality === 'auto' || quality === 'audio' ? resolvePlaybackQuality(settings) : quality
                        void playerLauncherService.launchExternal(item, player, selected)
                        event.currentTarget.value = ''
                      }
                    }}>
                    <option value="">Choose a player</option>
                    {#each availablePlayers as player (player.id)}<option value={player.id}>{player.name}</option>{/each}
                  </select>
                </label>
              {/if}
            {/if}
          </section>
        {/if}
        <media-time-slider class="seek-slider">
          <media-slider-track class="slider-track">
            <media-slider-buffer class="slider-buffer"></media-slider-buffer>
            <media-slider-fill class="slider-fill"></media-slider-fill>
          </media-slider-track>
          <media-slider-thumb class="slider-thumb"></media-slider-thumb>
        </media-time-slider>
        <div class="transport">
          <media-play-button class="icon-button" title="Play or pause (Space)">
            <media-icon name="play" class="play-icon"></media-icon>
            <media-icon name="pause" class="pause-icon"></media-icon>
          </media-play-button>
          <media-mute-button class="icon-button" title="Mute (M)">
            <media-icon name="volume-high" class="volume-icon"></media-icon>
            <media-icon name="volume-off" class="mute-icon"></media-icon>
          </media-mute-button>
          <media-volume-slider class="volume-slider">
            <media-slider-track class="slider-track">
              <media-slider-fill class="slider-fill"></media-slider-fill>
            </media-slider-track>
            <media-slider-thumb class="slider-thumb"></media-slider-thumb>
          </media-volume-slider>
          <div class="time"><media-time type="current"></media-time><span>/</span><media-time type="duration"></media-time></div>
          <div class="tools">
            {#if info?.subtitles.length}
              <button type="button" class="icon-button" aria-label="Toggle subtitles" title="Toggle subtitles (V)"
                aria-pressed={Boolean(subtitleId)} onclick={toggleSubtitle}>
                <media-icon name={subtitleId ? 'captions-on' : 'captions-off'}></media-icon>
              </button>
            {/if}
            <button type="button" class="icon-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"
              aria-expanded={showKeys} onclick={() => { showOptions = false; showKeys = !showKeys }}>?</button>
            <button type="button" class="icon-button" aria-label="Playback options" title="Playback options"
              aria-expanded={showOptions} onclick={() => { showKeys = false; showOptions = !showOptions }}>
              <media-icon name="gear"></media-icon>
            </button>
            <media-fullscreen-button class="icon-button" title="Fullscreen (F)" bind:this={fullscreenButton}>
              <media-icon name="fullscreen-enter" class="fullscreen-enter"></media-icon>
              <media-icon name="fullscreen-exit" class="fullscreen-exit"></media-icon>
            </media-fullscreen-button>
          </div>
        </div>
      </div>
      <NotificationContainer />
    </media-container>
  </video-player>
</dialog>

<style>
  .player-dialog {
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    color: var(--color-text, #eee);
    background: #090909;
  }
  video-player, .player { display: block; width: 100%; height: 100%; }
  .player {
    position: relative;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    color: #eee;
    background: #090909;
    --player-accent: var(--color-primary, #b4c1e4);
  }
  .player-header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.65rem;
    min-width: 0;
    padding: max(0.5rem, env(safe-area-inset-top)) max(0.9rem, env(safe-area-inset-right)) 0.5rem max(0.65rem, env(safe-area-inset-left));
    z-index: 2;
  }
  .title { min-width: 0; }
  h1 { margin: 0; font-size: clamp(0.95rem, 2vw, 1.2rem); line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title span { font-size: 0.8rem; color: #a8a8a8; }
  .back-button span { font-size: 2rem; line-height: 1; margin-top: -0.25rem; }
  .video-surface { position: relative; display: grid; place-items: center; min-height: 0; overflow: hidden; }
  video { display: block; width: 100%; height: 100%; object-fit: contain; position: absolute; inset: 0; }
  .video-surface:not(.media-ready) :global(.subtitle-canvas) { visibility: hidden; }
  .video-surface :global(.subtitle-canvas) { pointer-events: none; position: absolute; }
  .player-message { position: relative; margin: 1rem; max-width: 28rem; padding: 1.25rem; text-align: center; border-radius: 0.6rem; background: #1b1b1b; }
  .player-message p { margin: 0 0 0.85rem; }
  .player-message.loading { pointer-events: none; padding: 0; background: none; }
  .loading span { display: block; width: 2rem; height: 2rem; border-radius: 50%; border: 2px solid #ffffff50; border-top-color: white; animation: rotate 0.8s linear infinite; }
  @keyframes rotate { to { transform: rotate(360deg); } }
  .center-play { z-index: 1; display: grid; place-items: center; border-radius: 50%; border: 1px solid #ffffff45; background: #151515bd; color: white; width: 3.5rem; height: 3.5rem; padding: 0; }
  .center-play media-icon { font-size: 1.5rem; }
  .player-footer { position: relative; z-index: 2; padding: 0 max(0.95rem, env(safe-area-inset-right)) max(0.5rem, env(safe-area-inset-bottom)) max(0.95rem, env(safe-area-inset-left)); }
  .transport, .tools, .time { display: flex; align-items: center; gap: 0.4rem; }
  .tools { margin-left: auto; }
  .time { font-size: 0.83rem; font-variant-numeric: tabular-nums; white-space: nowrap; color: #ccc; }
  .icon-button { flex: none; display: grid; place-items: center; width: 2.5rem; height: 2.5rem; border-radius: 0.35rem; border: 0; background: transparent; color: inherit; padding: 0; cursor: pointer; font-size: 1.1rem; }
  .icon-button:hover, .icon-button[aria-expanded="true"] { background: #ffffff18; }
  .icon-button[aria-pressed="true"] { color: var(--player-accent); }
  .icon-button:focus-visible, .seek-slider:focus-visible, .volume-slider:focus-visible { outline: 2px solid var(--player-accent); outline-offset: 1px; }
  media-icon { display: inline-flex; width: 1em; height: 1em; font-size: 1.3rem; }
  .play-icon, .mute-icon, .fullscreen-exit,
  media-play-button:global([data-paused]) .pause-icon,
  media-mute-button:global([data-muted]) .volume-icon,
  media-fullscreen-button:global([data-fullscreen]) .fullscreen-enter { display: none; }
  media-play-button:global([data-paused]) .play-icon,
  media-mute-button:global([data-muted]) .mute-icon,
  media-fullscreen-button:global([data-fullscreen]) .fullscreen-exit { display: inline-flex; }
  .seek-slider, .volume-slider { display: grid; position: relative; align-items: center; cursor: pointer; touch-action: none; padding: 0; }
  .seek-slider { height: 1.35rem; }
  .volume-slider { height: 1.4rem; width: clamp(2.75rem, 9vw, 6rem); margin-right: 0.55rem; }
  .slider-track { display: block; position: relative; height: 4px; border-radius: 9px; background: #ffffff35; }
  .slider-fill, .slider-buffer { display: block; position: absolute; inset: 0 auto 0 0; width: var(--media-slider-fill, 0%); border-radius: inherit; background: var(--player-accent); }
  .slider-buffer { width: var(--media-slider-buffer, 0%); background: #ffffff45; }
  .slider-thumb { position: absolute; left: var(--media-slider-fill, 0%); width: 11px; height: 11px; transform: translateX(-50%); border-radius: 50%; background: var(--player-accent); }
  .player-options { box-sizing: border-box; position: absolute; right: max(0.95rem, env(safe-area-inset-right)); bottom: calc(100% + 0.4rem); width: min(25rem, calc(100vw - 1.9rem)); max-height: min(70dvh, 28rem); overflow: auto; padding: 0.8rem; border: 1px solid #ffffff24; border-radius: 0.65rem; background: var(--color-surface, #1a1a1a); box-shadow: 0 6px 28px #0009; }
  .player-options label { display: grid; grid-template-columns: 7rem minmax(0, 1fr); align-items: center; gap: 0.5rem; padding: 0.3rem; font-size: 0.87rem; }
  .player-options select { width: 100%; min-width: 0; }
  .delay-control { display: flex; align-items: center; justify-content: space-between; gap: 0.25rem; }
  .delay-control output { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .delay-control button { padding: 0.3rem 0.55rem; }
  .subtitle-notice { position: absolute; bottom: 100%; margin: 0.45rem 0; padding: 0.55rem 0.75rem; background: #222e; border-radius: 0.35rem; font-size: 0.875rem; }
  h2 { margin: 0 0 0.7rem; font-size: 1rem; }
  .shortcuts { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 0.75rem; margin: 0; font-size: 0.85rem; }
  .shortcuts dd { margin: 0; }
  kbd { background: #ffffff14; padding: 0.1rem 0.25rem; border-radius: 0.2rem; }
  .player:fullscreen .video-surface { position: absolute; inset: 0; }
  .player:fullscreen .player-header,
  .player:fullscreen .player-footer {
    position: absolute;
    inset-inline: 0;
    transition: opacity 160ms ease;
  }
  .player:fullscreen .player-header { top: 0; background: linear-gradient(#000c, transparent); }
  .player:fullscreen .player-footer { bottom: 0; background: linear-gradient(transparent, #000c); }
  .player:fullscreen:not(.options-visible):not(:global([data-controls-visible])):not(:has(:focus-visible)) .player-header,
  .player:fullscreen:not(.options-visible):not(:global([data-controls-visible])):not(:has(:focus-visible)) .player-footer {
    opacity: 0;
    pointer-events: none;
  }
  @media (max-width: 420px) {
    .transport, .tools { gap: 0.15rem; }
    .icon-button { width: 2rem; }
    .volume-slider { display: none; }
  }
</style>
