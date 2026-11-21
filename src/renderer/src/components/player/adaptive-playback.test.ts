import { expect, spyOn, test } from 'bun:test'
import Hls, { Fragment, PlaylistLevelType } from 'hls.js'
import { AdaptivePlaybackStats, createPlaybackHls, watchHlsSeeks } from './adaptive-playback'

test('delivers the first fragment whole before the playlist identifies its format', () => {
  const player = createPlaybackHls(Hls, 0)
  try {
    expect(player.config.progressive).toBe(false)
  } finally {
    player.destroy()
  }
})

test('resets progressive parsing only when a seek abandons a partially delivered fragment', () => {
  const player = createPlaybackHls(Hls, 0)
  const controller = new AbortController()
  const video = Object.assign(new EventTarget(), { currentTime: 0, seeking: true })
  const frag = new Fragment(PlaylistLevelType.MAIN, '')
  frag.start = 10
  frag.duration = 4
  player.config.progressive = true
  Object.defineProperty(player, 'inFlightFragments', { get: () => ({ main: { frag, state: 'FRAG_LOADING' } }) })
  const load = spyOn(player, 'startLoad').mockImplementation(() => {})
  try {
    watchHlsSeeks(Hls, player, video as HTMLVideoElement, controller.signal, () => {})
    const seek = (position: number) => {
      video.currentTime = position
      video.dispatchEvent(new Event('seeking'))
    }
    seek(60)
    frag.stats.chunkCount = 1
    seek(12)
    seek(9.96)
    seek(60)
    frag.stats.buffering.end = 100
    seek(70)
    expect(load.mock.calls).toEqual([[60, true]])
  } finally {
    controller.abort()
    player.destroy()
  }
})

test.each([false, true])('keeps buffered media through a temporary outage and reacts to slow delivery (offline hint %s)', (offline) => {
  const stats = new AdaptivePlaybackStats()
  const sample = (second: number, end: number) => stats.sample(
    { time: second * 1000, end, frames: second * 30, dropped: 0, offline }, second, 120, 1, false, undefined, 20)
  let end = 4
  for (let t = 0; t <= 10; t++) {
    if (t < 4 || t > 7) end += 1.5
    expect(sample(t, end)).toBeUndefined()
  }
  const decisions = []
  for (let t = 11; t <= 20; t++) {
    end += 0.6
    const direction = sample(t, end)
    if (direction) decisions.push([direction, end > t])
  }
  expect(decisions).toEqual([['lower', true]])
})

test('detects persistent dropped frames with buffered media and requires measured headroom to climb', () => {
  const stats = new AdaptivePlaybackStats()
  const higher = { index: 0, bitrate: 4_000_000 }
  const sample = (t: number, dropped: number) => stats.sample(
    { time: t * 1000, end: t + 12, frames: t * 60, dropped }, t, 200, 1, false, higher, 20)
  for (let t = 0; t < 3; t++) expect(sample(t, t * 18)).toBeUndefined()
  expect(sample(3, 54)).toBe('lower')
  for (let t = 4; t <= 30; t++) {
    stats.fragment(250000, 1, 600)
    expect(sample(t, 54)).toBeUndefined()
  }
  let decision
  for (let t = 31; t < 53 && !decision; t++) {
    stats.fragment(250000, 1, 200)
    decision = sample(t, 54)
  }
  expect(decision).toBe('higher')
})
