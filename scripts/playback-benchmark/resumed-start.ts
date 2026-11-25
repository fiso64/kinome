// resumed-start.ts <origin> <itemId> <quality>: resumed start with the start hint; also compares initialization bytes.
const [origin, item, quality] = process.argv.slice(2)
const { token } = await fetch(origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'q' }) }).then(r => r.json()) as any
async function open(start: number) {
  const master = new URL(`/api/hls/${item}/${quality}/master.m3u8?web=1&audio=1&token=${token}${start ? '&start=' + start : ''}`, origin)
  const lines = (await fetch(master).then(r => r.text())).split('\n')
  const segments = lines.filter(l => l.startsWith('segment-'))
  const durations = lines.filter(l => l.startsWith('#EXTINF:')).map(l => parseFloat(l.slice(8)))
  return { master, segments, durations, init: lines.find(l => l.startsWith('#EXT-X-MAP'))!.split('"')[1] }
}
const probe = await open(0)
const mid = Math.floor(probe.segments.length / 2)
const startSeconds = probe.durations.slice(0, mid).reduce((a, b) => a + b, 0) + 0.5
const hash = (b: ArrayBuffer) => Bun.hash(new Uint8Array(b)).toString(36)
const zeroInit = hash(await fetch(new URL(probe.init, probe.master)).then(r => r.arrayBuffer()))
for (let i = 0; i < 4; i++) {
  const hinted = await open(startSeconds)
  const t0 = performance.now()
  const init = await fetch(new URL(hinted.init, hinted.master)).then(r => r.arrayBuffer())
  const initMs = Math.round(performance.now() - t0)
  const r = await fetch(new URL(hinted.segments[mid], hinted.master)); await r.arrayBuffer()
  console.log(quality, 'hinted start', { first: hinted.init.match(/first=(\d+)/)?.[1], mid, initMs, totalMs: Math.round(performance.now() - t0), status: r.status, sameInit: hash(init) === zeroInit })
}
