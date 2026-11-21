import { open } from 'node:fs/promises'
import { SUBTITLE_WINDOW_SECONDS } from '@shared/web-playback'

/** Byte ranges in an extracted Blu-ray subtitle track. Replay the previous
 * epoch because a composition can reuse its bitmaps and palette after a seek. */
export async function indexSupWindows(path: string) {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const windows: { number: number; start: number; lastEpoch: number; end: number }[] = []
    const bytes = Buffer.allocUnsafe(64 * 1024)
    let base = 0
    let available = 0
    let previousPts = -1
    let epoch = 0
    for (let position = 0; position < size;) {
      // Inspect the header and the composition state. Skip bitmap payloads.
      const needed = Math.min(21, size - position)
      if (position + needed > base + available) {
        base = position
        available = 0
        while (available < needed) {
          const { bytesRead } = await file.read(bytes, available, bytes.length - available, base + available)
          if (!bytesRead) return
          available += bytesRead
        }
      }
      const offset = position - base
      if (needed < 13 || bytes.readUInt16BE(offset) !== 0x5047) return
      const pts = bytes.readUInt32BE(offset + 2)
      const length = bytes.readUInt16BE(offset + 11)
      const end = position + 13 + length
      if (end > size || pts < previousPts) return
      previousPts = pts
      const number = Math.floor(pts / (90_000 * SUBTITLE_WINDOW_SECONDS))
      let window = windows.at(-1)
      if (window?.number !== number) {
        window = { number, start: epoch, lastEpoch: epoch, end }
        windows.push(window)
      }
      if (bytes[offset + 10] === 0x16 && length >= 11 && bytes[offset + 20] === 0x80) {
        epoch = position
        if (pts === number * 90_000 * SUBTITLE_WINDOW_SECONDS) window.start = epoch
      }
      window.lastEpoch = epoch
      window.end = end
      position = end
    }
    return (number: number): [number, number] => {
      const window = windows.findLast((entry) => entry.number <= number)
      if (!window) return [0, 0]
      return [window.number === number ? window.start : window.lastEpoch, window.end]
    }
  } finally {
    await file.close()
  }
}
