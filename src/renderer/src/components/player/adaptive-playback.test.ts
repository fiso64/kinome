import { expect, test } from 'bun:test'
import Hls from 'hls.js'
import { AdaptivePlaybackStats, createPlaybackHls } from './adaptive-playback'

test('delivers the first fragment whole before the playlist identifies its format', () => {
  const player = createPlaybackHls(Hls, 0)
  try {
    expect(player.config.progressive).toBe(false)
  } finally {
    player.destroy()
  }
})

test('keeps the buffered original through a temporary outage, but acts before sustained starvation', () => {
  const stats = new AdaptivePlaybackStats()
  const sample = (second: number, end: number) => stats.sample(
    { time: second * 1000, end, frames: second * 30, dropped: 0 }, second, 120, 1, false, undefined, 20)
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
