import hlsSource from 'hls.js/dist/hls.light.min.js' with { type: 'text' }
import { availablePlaybackQualities, canConvertPlaybackAudio } from '@shared/playback-quality'
import { readSettings } from '../settings.service'

/**
 * Most browsers cannot play an HLS playlist they open directly, and download it instead. When
 * a browser opens a playlist link as a page, it gets this page, which plays the same stream.
 * Players such as VLC and mpv, and the page's own requests, still receive the playlist.
 */
export function isPageRequest(request: Request): boolean {
  return request.method === 'GET' && request.headers.get('sec-fetch-dest') === 'document'
}

/**
 * The page plays what Kinome's web player would: the browser version of the stream. A remux
 * keeps audio that browsers may not decode, such as AC-3, so it plays with converted audio
 * when the server allows that, as the player does.
 */
async function browserSource(request: Request, quality: string): Promise<string> {
  const url = new URL(request.url)
  url.searchParams.set('web', '1')
  const settings = await readSettings()
  if (quality === 'remux' && canConvertPlaybackAudio(availablePlaybackQualities(settings), settings.playbackConversion)) {
    url.pathname = url.pathname.replace(/\/remux\/master\.m3u8$/, '/audio/master.m3u8')
  }
  return url.pathname + url.search
}

// The hls.js build contains no closing script tag, so it can be inlined as is.
const page = (source: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kinome stream</title>
<style>
html, body { margin: 0; height: 100%; background: #000; color: #eee; font: 16px system-ui, sans-serif; }
video { display: block; width: 100%; height: 100%; }
p { position: fixed; inset: auto 1rem 1rem; margin: 0; }
p:empty { display: none; }
</style>
</head>
<body>
<video controls autoplay playsinline></video>
<p role="alert"></p>
<script>${hlsSource}</script>
<script>
const video = document.querySelector('video')
const source = ${JSON.stringify(source).replaceAll('<', '\\u003c')}
if (window.Hls && Hls.isSupported()) {
  const hls = new Hls()
  hls.loadSource(source)
  hls.attachMedia(video)
  hls.on(Hls.Events.ERROR, (_, data) => {
    if (data.fatal) document.querySelector('p').textContent =
      'This browser cannot play this stream (' + data.details + '). Copy the link for a lower quality, or open it in a player such as VLC or mpv.'
  })
} else {
  video.src = source
}
</script>
</body>
</html>
`

export async function streamPage(request: Request, quality: string): Promise<Response> {
  return new Response(page(await browserSource(request, quality)), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Sec-Fetch-Dest' }
  })
}
