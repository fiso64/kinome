import { open, type FileHandle } from 'node:fs/promises'

async function readBytes(file: FileHandle, start: number, length: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length)
  let total = 0
  while (total < length) {
    const { bytesRead } = await file.read(bytes, total, length - total, start + total)
    if (!bytesRead) throw new Error('Unexpected end of MP4 file')
    total += bytesRead
  }
  return bytes
}

interface Box {
  type: string
  start: number
  end: number
}

function boxHeader(data: Buffer, offset: number, limit: number, base = 0): Box {
  if (data.length - offset < 8) throw new Error('Truncated MP4 box')
  const length = data.readUInt32BE(offset)
  const type = data.toString('ascii', offset + 4, offset + 8)
  const wide = length === 1
  const start = base + offset + (wide ? 16 : 8)
  const end = length === 0 ? limit : base + offset + (wide ? Number(data.readBigUInt64BE(offset + 8)) : length)
  if (!Number.isSafeInteger(end) || end > limit || end < start) throw new Error('Invalid MP4 box size')
  return { type, start, end }
}

function* children(data: Buffer) {
  for (let offset = 0; offset < data.length;) {
    const box = boxHeader(data, offset, data.length)
    yield { type: box.type, data: data.subarray(box.start, box.end) }
    offset = box.end
  }
}

function child(data: Buffer | undefined, type: string): Buffer | undefined {
  if (!data) return
  for (const box of children(data)) if (box.type === type) return box.data
}

function timescale(header: Buffer): number {
  const scale = header.readUInt32BE(header[0] === 1 ? 20 : 12)
  if (!scale) throw new Error('MP4 timescale is zero')
  return scale
}

function editOffset(edit: Buffer | undefined, mediaScale: number, movieScale: number): number {
  if (!edit) return 0
  const wide = edit[0] === 1
  const width = wide ? 20 : 12
  const count = edit.readUInt32BE(4)
  let delay = 0
  for (let index = 0; index < count; index++) {
    const offset = 8 + index * width
    const duration = wide ? Number(edit.readBigUInt64BE(offset)) : edit.readUInt32BE(offset)
    const start = wide ? Number(edit.readBigInt64BE(offset + 8)) : edit.readInt32BE(offset + 4)
    if (start >= 0) return delay - start / mediaScale
    delay += duration / movieScale
  }
  return delay
}

// Walk each timing table once. A decode-time table accumulates deltas. A
// composition-time table provides the display offset for the same sample.
function timestamp(table: Buffer, composition: boolean): (sample: number) => number {
  let row = 0
  let first = 0
  let elapsed = 0
  const count = table.readUInt32BE(4)
  if (count > (table.length - 8) / 8) throw new Error('Truncated MP4 timing table')
  return (sample) => {
    while (row < count) {
      const position = 8 + row * 8
      const length = table.readUInt32BE(position)
      const value = composition && table[0] === 1 ? table.readInt32BE(position + 4) : table.readUInt32BE(position + 4)
      if (sample < first + length) return composition ? value : elapsed + (sample - first) * value
      if (!composition) elapsed += length * value
      first += length
      row++
    }
    throw new Error('MP4 sample outside timing table')
  }
}

function sampleTimes(movie: Buffer): number[] {
  const movieHeader = child(movie, 'mvhd')
  if (!movieHeader) return []
  for (const entry of children(movie)) {
    if (entry.type !== 'trak') continue
    const media = child(entry.data, 'mdia')
    if (child(media, 'hdlr')?.toString('ascii', 8, 12) !== 'vide') continue
    const samples = child(child(media, 'minf'), 'stbl')
    const header = child(media, 'mdhd')
    const timing = child(samples, 'stts')
    const sizes = child(samples, 'stsz') ?? child(samples, 'stz2')
    if (!header || !timing || !sizes) return []
    const sampleCount = sizes.readUInt32BE(8)
    if (!sampleCount) return []
    const scale = timescale(header)
    const offset = editOffset(child(child(entry.data, 'edts'), 'elst'), scale, timescale(movieHeader))
    const sync = child(samples, 'stss')
    const composition = child(samples, 'ctts')
    const decodeTime = timestamp(timing, false)
    const compositionTime = composition ? timestamp(composition, true) : () => 0
    const count = sync ? sync.readUInt32BE(4) : sampleCount
    if (sync && count > (sync.length - 8) / 4) throw new Error('Truncated MP4 sync sample table')
    const times: number[] = []
    let previousSample = -1
    for (let index = 0; index < count; index++) {
      const sample = sync ? sync.readUInt32BE(8 + index * 4) - 1 : index
      if (sample <= previousSample || sample >= sampleCount) throw new Error('Invalid MP4 sync sample')
      previousSample = sample
      const time = Math.round(((decodeTime(sample) + compositionTime(sample)) / scale + offset) * 1_000_000) / 1_000_000
      if (time >= 0) times.push(time)
    }
    return [...new Set(times)].sort((a, b) => a - b)
  }
  return []
}

/** Read sync-sample timestamps from an ordinary, unfragmented MP4 or MOV. */
export async function readMp4Keyframes(filePath: string): Promise<number[]> {
  const file = await open(filePath, 'r')
  try {
    const { size } = await file.stat()
    for (let offset = 0; offset < size;) {
      const box = boxHeader(await readBytes(file, offset, Math.min(16, size - offset)), 0, size, offset)
      if (box.type === 'moov') {
        const length = box.end - box.start
        if (length > 32 * 1024 * 1024) throw new Error('MP4 index is too large')
        return sampleTimes(await readBytes(file, box.start, length))
      }
      offset = box.end
    }
    return []
  } finally {
    await file.close()
  }
}

/** Separate a generated fragment from its ftyp/moov initialization prefix. */
export async function inspectMp4Segment(path: string, needsInitialization: boolean) {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const first = boxHeader(await readBytes(file, 0, Math.min(16, size)), 0, size)
    if (first.type !== 'ftyp') throw new Error('Missing MP4 file type')
    const second = boxHeader(await readBytes(file, first.end, Math.min(16, size - first.end)), 0, size, first.end)
    if (second.type !== 'moov' || second.end === size) throw new Error('Missing fragmented MP4 media')
    return {
      offset: second.end,
      initialization: needsInitialization ? await readBytes(file, 0, second.end) : undefined
    }
  } finally {
    await file.close()
  }
}
