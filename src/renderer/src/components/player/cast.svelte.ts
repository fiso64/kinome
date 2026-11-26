/**
 * Casting from the web player to a Chromecast, through Google's Default Media
 * Receiver. The receiver fetches Kinome's stream itself, so the URL carries the
 * session token and Kinome answers it with CORS headers. Google's sender script
 * loads only when the viewer asks to cast, and only Chromium browsers can.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Google's sender framework ships without types. */

const SENDER_SCRIPT = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'

export interface CastMedia {
  url: string
  contentType: string
  /** HLS from Kinome is fragmented MP4. */
  hls: boolean
  title: string
  subtitle?: string
  poster?: string
  startTime: number
  textTrack?: { url: string; name: string; language?: string }
}

/** Chrome and other Chromium browsers include the Cast sender. */
export const castSupported = typeof navigator !== 'undefined' && /\bChrom(e|ium)\//.test(navigator.userAgent) && !/\b(Firefox|FxiOS)\//.test(navigator.userAgent)

let loading: Promise<boolean> | undefined

// Browsers with casting turned off, such as Brave by default, load the script but never report back.
const SENDER_TIMEOUT_MS = 10_000

function loadSender(): Promise<boolean> {
  return loading ??= new Promise((resolve) => {
    const settle = (available: boolean) => {
      clearTimeout(timer)
      if (!available) loading = undefined
      resolve(available)
    }
    const timer = setTimeout(() => settle(false), SENDER_TIMEOUT_MS)
    ;(window as any).__onGCastApiAvailable = settle
    const script = document.createElement('script')
    script.src = SENDER_SCRIPT
    script.onerror = () => settle(false)
    document.head.append(script)
  })
}

class CastController {
  /** The receiver's name while a session is connected. */
  device = $state<string>()
  position = $state(0)
  duration = $state(0)
  paused = $state(true)
  /** Set when the receiver played the media to its end. */
  finished = $state(false)
  private player: any
  private controller: any

  private get framework() {
    return (window as any).cast.framework
  }

  private connect() {
    if (this.controller) return
    const chrome = (window as any).chrome
    this.framework.CastContext.getInstance().setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    })
    this.player = new this.framework.RemotePlayer()
    this.controller = new this.framework.RemotePlayerController(this.player)
    this.controller.addEventListener(this.framework.RemotePlayerEventType.ANY_CHANGE, () => this.sync())
  }

  private sync() {
    const session = this.framework.CastContext.getInstance().getCurrentSession()
    this.device = this.player.isConnected ? session?.getCastDevice().friendlyName ?? 'Cast device' : undefined
    this.position = this.player.currentTime
    this.duration = this.player.duration
    this.paused = this.player.isPaused
    if (this.player.playerState === 'IDLE' && session?.getMediaSession()?.idleReason === 'FINISHED') this.finished = true
  }

  /** Opens the device picker if needed and plays the media there. Resolves false if the viewer cancels. */
  async start(media: CastMedia): Promise<boolean> {
    if (!await loadSender()) throw new Error('Casting is not available in this browser.')
    this.connect()
    const context = this.framework.CastContext.getInstance()
    if (!context.getCurrentSession()) {
      try {
        await context.requestSession()
      } catch (error) {
        if (error === 'cancel') return false
        throw new Error(`Could not connect to the cast device (${error}).`, { cause: error })
      }
    }
    const chrome = (window as any).chrome
    const info = new chrome.cast.media.MediaInfo(media.url, media.contentType)
    info.streamType = chrome.cast.media.StreamType.BUFFERED
    if (media.hls) {
      info.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat.FMP4
      info.hlsVideoSegmentFormat = chrome.cast.media.HlsVideoSegmentFormat.FMP4
    }
    info.metadata = new chrome.cast.media.GenericMediaMetadata()
    info.metadata.title = media.title
    if (media.subtitle) info.metadata.subtitle = media.subtitle
    if (media.poster) info.metadata.images = [new chrome.cast.Image(media.poster)]
    const request = new chrome.cast.media.LoadRequest(info)
    if (media.textTrack) {
      const track = new chrome.cast.media.Track(1, chrome.cast.media.TrackType.TEXT)
      track.trackContentId = media.textTrack.url
      track.trackContentType = 'text/vtt'
      track.subtype = chrome.cast.media.TextTrackType.SUBTITLES
      track.name = media.textTrack.name
      track.language = media.textTrack.language
      info.tracks = [track]
      request.activeTrackIds = [1]
    }
    request.currentTime = media.startTime
    request.autoplay = true
    this.finished = false
    const error = await context.getCurrentSession().loadMedia(request)
    if (error) throw new Error(`The cast device could not play this (${error}).`)
    this.sync()
    return true
  }

  playOrPause() {
    this.controller?.playOrPause()
  }

  seek(seconds: number) {
    if (!this.controller) return
    this.player.currentTime = Math.max(0, seconds)
    this.controller.seek()
  }

  /** Ends the session and closes the receiver on the device. */
  stop() {
    if (this.controller) this.framework.CastContext.getInstance().endCurrentSession(true)
  }
}

export const castController = new CastController()
