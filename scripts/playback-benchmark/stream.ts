import { withPage } from './cdp'
// stream.ts <itemId> <mode> <old|new hls config> <hlsChunk> <startFraction> <mbit>
const [item, mode, config, chunk, startFraction = '0', mbit = '0'] = process.argv.slice(2)
const result = await withPage(async (evaluate, _logs, send) => {
  if (+mbit) {
    await send('Network.enable')
    await send('Network.emulateNetworkConditions', { offline: false, latency: 5, downloadThroughput: +mbit * 125000, uploadThroughput: 5 * 125000 })
  }
  return evaluate(`
  const token = localStorage.getItem('auth_token')
  const info = await fetch('/api/playback/${item}/info', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json())
  const position = info.media.durationSeconds * ${startFraction}
  const module = await import('/assets/${chunk}')
  const Hls = Object.values(module).find(v => typeof v === 'function' && v.isSupported)
  const video = document.createElement('video')
  video.muted = true
  document.body.append(video)
  let hls
  if (${JSON.stringify(config)} === 'old') {
    hls = new Hls({ progressive: true, maxBufferLength: 12, maxMaxBufferLength: 30, startPosition: position || -1 })
    const canStream = hls.config.progressive
    hls.config.progressive = false
    hls.on(Hls.Events.LEVEL_UPDATED, (_e, { details }) => { const first = details.fragments[0]; hls.config.progressive = canStream && !!first && !first.initSegment })
  } else hls = new Hls({ progressive: ${JSON.stringify(process.env.PROG === '1')}, maxBufferLength: 12, maxMaxBufferLength: 30, startPosition: position || -1, startFragPrefetch: true })
  const errors = []
  hls.on(Hls.Events.ERROR, (_e, d) => errors.push(d.details))
  const marks = []
  let t0
  const mark = (name) => marks.push(name + '@' + Math.round(performance.now() - t0))
  hls.on(Hls.Events.MANIFEST_PARSED, () => mark('manifest'))
  hls.on(Hls.Events.FRAG_LOADING, (_e, d) => marks.length < 14 && mark('loading:' + d.frag.sn))
  hls.on(Hls.Events.FRAG_LOADED, (_e, d) => marks.length < 14 && mark('loaded:' + d.frag.sn + ':' + Math.round(d.frag.stats.loaded / 1024) + 'k'))
  hls.on(Hls.Events.FRAG_BUFFERED, (_e, d) => marks.length < 14 && mark('buffered:' + d.frag.sn))
  for (const type of ['loadedmetadata', 'canplay', 'playing', 'waiting', 'seeking', 'seeked']) video.addEventListener(type, () => marks.length < 30 && mark(type + '(' + video.currentTime.toFixed(1) + ',buf ' + (video.buffered.length ? video.buffered.start(0).toFixed(1) + '-' + video.buffered.end(video.buffered.length - 1).toFixed(1) : 'none') + ')'))
  hls.on(Hls.Events.BUFFER_APPENDED, () => marks.length < 30 && mark('append(' + (video.buffered.length ? video.buffered.end(video.buffered.length - 1).toFixed(1) : 'none') + ')'))
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => null)])
  const frame = () => new Promise(resolve => video.requestVideoFrameCallback((now, meta) => resolve(meta)))
  t0 = performance.now()
  hls.loadSource('/api/hls/${item}/${mode}/master.m3u8?web=1&audio=1&token=' + token + (${JSON.stringify(config)} === 'new' && position ? '&start=' + position.toFixed(3) : ''))
  hls.attachMedia(video)
  hls.on(Hls.Events.MANIFEST_PARSED, () => video.play())
  const first = await within(frame(), 40000)
  const start = Math.round(performance.now() - t0)
  mark('frame')
  if (!first) return { error: 'no first frame', errors, marks }
  if (${JSON.stringify(process.env.MARKS ?? '')}) return { start, marks: marks.join(' '), buffered: [video.buffered.start(0), video.buffered.end(0)], first: first.mediaTime }
  const seeks = [], phases = []
  await sleep(1500)
  for (const fraction of [0.72, 0.16, 0.89, 0.41, 0.63]) {
    const s0 = performance.now()
    const phase = {}
    const note = (name) => { phase[name] ??= Math.round(performance.now() - s0) }
    const onLoading = () => note('request'), onLoaded = (_e, d) => { note('loaded'); phase.kb ??= Math.round(d.frag.stats.loaded / 1024) }, onBuffered = () => note('buffered')
    hls.on(Hls.Events.FRAG_LOADING, onLoading); hls.on(Hls.Events.FRAG_LOADED, onLoaded); hls.on(Hls.Events.FRAG_BUFFERED, onBuffered)
    const seeked = new Promise(resolve => video.addEventListener('seeked', () => { note('seeked'); resolve() }, { once: true }))
    video.currentTime = video.duration * fraction
    const done = await within(seeked.then(frame), 40000)
    hls.off(Hls.Events.FRAG_LOADING, onLoading); hls.off(Hls.Events.FRAG_LOADED, onLoaded); hls.off(Hls.Events.FRAG_BUFFERED, onBuffered)
    phase.frame = done ? Math.round(performance.now() - s0) : -1
    phases.push(phase)
    seeks.push(phase.frame)
    await sleep(1500)
  }
  const from = video.currentTime, w0 = performance.now()
  await sleep(10000)
  return { start, seeks, phases, played: +(video.currentTime - from).toFixed(2), ts: !hls.levels[0]?.details?.fragments[0]?.initSegment, errors: [...new Set(errors)] }
  `)
})
console.log(JSON.stringify(result))
