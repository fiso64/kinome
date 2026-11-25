import { withPage } from './cdp'
// stress.ts <itemId> <mode> <mbit>: seek repeatedly while segments are still downloading.
const [item, mode, mbit = '8'] = process.argv.slice(2)
console.log(JSON.stringify(await withPage(async (evaluate, _logs, send) => {
  await send('Network.enable')
  await send('Network.emulateNetworkConditions', { offline: false, latency: 5, downloadThroughput: +mbit * 125000, uploadThroughput: 5 * 125000 })
  return evaluate(`
  const token = localStorage.getItem('auth_token')
  const module = await import('/assets/' + ${JSON.stringify(process.env.HLS_CHUNK ?? '')})
  const Hls = Object.values(module).find(v => typeof v === 'function' && v.isSupported)
  const video = document.createElement('video'); video.muted = true; document.body.append(video)
  const hls = new Hls({ progressive: ${JSON.stringify(process.env.PROG !== '0')}, maxBufferLength: 12, maxMaxBufferLength: 30, startFragPrefetch: true })
  const errors = {}
  hls.on(Hls.Events.ERROR, (_e, d) => { errors[d.details + (d.fatal ? '!' : '')] = (errors[d.details + (d.fatal ? '!' : '')] ?? 0) + 1 })
  let resets = 0
  if (${JSON.stringify(process.env.GUARD === '1')}) video.addEventListener('seeking', () => {
    const { frag } = hls.inFlightFragments.main
    const target = video.currentTime, tolerance = hls.config.maxFragLookUpTolerance
    if (frag && frag.stats.chunkCount && !frag.stats.buffering.end && (target < frag.start - tolerance || target > frag.end + tolerance)) { resets++; hls.startLoad(target, true) }
  })
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => null)])
  hls.loadSource('/api/hls/${item}/${mode}/master.m3u8?web=1&audio=1&token=' + token); hls.attachMedia(video)
  hls.on(Hls.Events.MANIFEST_PARSED, () => video.play())
  await within(new Promise(r => video.addEventListener('playing', r, { once: true })), 30000)
  const fragments = () => hls.levels[0].details.fragments
  let seed = 7; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const results = []
  for (let i = 0; i < 24; i++) {
    const list = fragments()
    const current = list.findIndex(f => video.currentTime >= f.start && video.currentTime < f.start + f.duration)
    const kind = i % 3
    // 0: far jump. 1: into the next segment while this one may still be loading. 2: back a little inside the same segment.
    const target = kind === 0 ? video.duration * (0.05 + 0.9 * random())
      : kind === 1 ? (list[Math.min(list.length - 1, current + 1)].start + 0.3) : Math.max(0, video.currentTime - 1.5)
    const t0 = performance.now()
    video.currentTime = target
    // Interrupt half of the seeks early, while their segment is in flight.
    if (i % 2) { await sleep(250); results.push('interrupted'); continue }
    const shown = await within(new Promise(resolve => { const check = () => (!video.seeking && video.readyState >= 3 && Math.abs(video.currentTime - target) < 3) ? resolve(true) : setTimeout(check, 30); check() }), 45000)
    results.push(shown ? Math.round(performance.now() - t0) : 'STUCK@' + target.toFixed(1) + ' rs' + video.readyState)
    await sleep(400)
  }
  const from = video.currentTime; await sleep(6000)
  await sleep(${JSON.stringify(+(process.env.SETTLE ?? 0))}); const from2 = video.currentTime; await sleep(5000); return { resets, settledPlay: +(video.currentTime - from2).toFixed(2), rs: video.readyState, results: results.filter(r => r !== 'interrupted'), playedAfter: +(video.currentTime - from).toFixed(2), errors, mediaError: video.error?.message }
  `)
})))
