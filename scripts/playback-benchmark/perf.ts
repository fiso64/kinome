import { withPage } from './cdp'
// perf.ts <itemId> <quality> <resumeFraction> <mbit|0>
const [item, quality = 'source', resume = '0', mbit = '0'] = process.argv.slice(2)
const result = await withPage(async (evaluate, logs, send) => {
  await evaluate(`
    localStorage.setItem('kinome:client-settings', JSON.stringify({ webQuality: ${JSON.stringify(quality)}, playerMuted: true }))
    const token = localStorage.getItem('auth_token')
    const info = await fetch('/api/playback/${item}/info', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json())
    await fetch('/api/playback/${item}/progress', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: Math.round(info.media.durationSeconds * ${resume}), completed: false }) })
    setTimeout(() => { location.href = '/?item=${item}' }, 0)
  `)
  await Bun.sleep(2000)
  if (+mbit) {
    await send('Network.enable')
    await send('Network.emulateNetworkConditions', { offline: false, latency: 5, downloadThroughput: +mbit * 125000, uploadThroughput: 5 * 125000 })
  }
  const value = await evaluate(`
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const label = b => (b.getAttribute('aria-label') || b.title || b.textContent || '').trim()
    const play = [...document.querySelectorAll('button')].find(b => /^Play$/.test(label(b)))
    if (!play) return { error: 'no play button', buttons: [...document.querySelectorAll('button')].map(label) }
    const t0 = performance.now()
    play.click()
    let video
    while (!(video = document.querySelector('video-player video')) && performance.now() - t0 < 10000) await sleep(5)
    // The old build can replace the element while it opens a source.
    const frame = () => new Promise(resolve => { const tick = () => { const current = document.querySelector('video-player video'); if (current !== video) video = current; video.requestVideoFrameCallback((now, meta) => resolve(meta)) }; tick(); const watch = setInterval(() => { if (document.querySelector('video-player video') !== video) tick() }, 50); setTimeout(() => clearInterval(watch), 30000) })
    const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => null)])
    const first = await within(frame(), 30000)
    const start = Math.round(performance.now() - t0)
    if (!first) return { error: 'no first frame', text: document.querySelector('.playback-error')?.textContent }
    if (${JSON.stringify(process.env.TRACE ?? '')}) return { start, requests: performance.getEntriesByType('resource').filter(e => e.startTime >= t0 - 5).map(e => new URL(e.name).pathname.replace(/[0-9a-f-]{20,}/, 'ID').replace('/api/', '') + ' ' + Math.round(e.startTime - t0) + '-' + Math.round(e.responseEnd - t0)).join(' | ') }
    const startPosition = +first.mediaTime.toFixed(2)
    video = document.querySelector('video-player video')
    while (!Number.isFinite(video.duration) && performance.now() - t0 < 10000) await sleep(10)
    const ahead = () => { const b = video.buffered; for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 0.1 && b.end(i) >= video.currentTime) return b.end(i) - video.currentTime; return 0 }
    let fill10
    while (performance.now() - t0 < 4000) { if (ahead() >= 10) { fill10 = Math.round(performance.now() - t0); break } await sleep(20) }
    const description = [...document.querySelectorAll('.player *')].map(e => e.childElementCount ? '' : e.textContent.trim()).find(t => /Direct play|Remuxing|Converting|Transcoding/.test(t))
    const seeks = []
    for (const fraction of [0.72, 0.16, 0.89, 0.41, 0.63]) {
      const target = video.duration * fraction
      const s0 = performance.now()
      const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }))
      video.currentTime = target
      const done = await within(seeked.then(frame), 30000)
      seeks.push(done ? Math.round(performance.now() - s0) : -1)
      await sleep(800)
    }
    const from = video.currentTime, q0 = video.getVideoPlaybackQuality()
    await sleep(5000)
    const q = video.getVideoPlaybackQuality()
    return { description, start, startPosition, fill10, seeks, played: +(video.currentTime - from).toFixed(2), dropped: q.droppedVideoFrames - q0.droppedVideoFrames,
      aheadEnd: +ahead().toFixed(1), error: document.querySelector('.playback-error')?.textContent }
  `)
  return { ...value, warnings: logs.filter(l => /^(warning|error).*Kinome player/.test(l)).map(l => l.slice(0, 160)) }
})
console.log(JSON.stringify(result))
