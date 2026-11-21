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
  offset: number
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
  return { type, offset: base + offset, start, end }
}

async function* children(file: FileHandle, parent: Pick<Box, 'start' | 'end'>) {
  for (let offset = parent.start; offset < parent.end;) {
    const header = await readBytes(file, offset, Math.min(16, parent.end - offset))
    const box = boxHeader(header, 0, parent.end, offset)
    yield box
    offset = box.end
  }
}

async function fields(file: FileHandle, parent?: Box): Promise<Map<string, Box>> {
  const result = new Map<string, Box>()
  if (parent) for await (const box of children(file, parent)) result.set(box.type, box)
  return result
}

function contents(file: FileHandle, box?: Box, limit = Infinity): Promise<Buffer | undefined> {
  return box ? readBytes(file, box.start, Math.min(limit, box.end - box.start)) : Promise.resolve(undefined)
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

async function sampleTimes(file: FileHandle, movie: Box): Promise<number[]> {
  let movieHeader: Box | undefined
  const tracks: Box[] = []
  for await (const box of children(file, movie)) {
    if (box.type === 'mvhd') movieHeader = box
    if (box.type === 'trak') tracks.push(box)
  }
  if (!movieHeader) return []
  for (const track of tracks) {
    const entry = await fields(file, track)
    const media = await fields(file, entry.get('mdia'))
    const handler = await contents(file, media.get('hdlr'), 12)
    if (handler?.toString('ascii', 8, 12) !== 'vide') continue
    const minf = await fields(file, media.get('minf'))
    const samples = await fields(file, minf.get('stbl'))
    const edits = await fields(file, entry.get('edts'))
    // Chunk offsets, sample sizes, other tracks and cover art can dominate
    // moov. Only the timing tables and the sync sample numbers are needed.
    const [movieClock, header, sizes, timing, composition, sync, edit] = await Promise.all([
      contents(file, movieHeader, 24), contents(file, media.get('mdhd'), 24),
      contents(file, samples.get('stsz') ?? samples.get('stz2'), 12), contents(file, samples.get('stts')),
      contents(file, samples.get('ctts')), contents(file, samples.get('stss')), contents(file, edits.get('elst'))
    ])
    if (!movieClock || !header || !timing || !sizes) return []
    const sampleCount = sizes.readUInt32BE(8)
    if (!sampleCount) return []
    const scale = timescale(header)
    const offset = editOffset(edit, scale, timescale(movieClock))
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
    for await (const box of children(file, { start: 0, end: size })) {
      if (box.type === 'moov') return await sampleTimes(file, box)
    }
    return []
  } finally {
    await file.close()
  }
}

// FFmpeg's h264_metadata can append its user-data SEI after the IDR slice.
// A fresh decoder needs the x264 version *before* decoding that picture.
// Move the NAL inside the existing sample so sizes, offsets and PTS stay exact.
async function orderX264Metadata(file: FileHandle, fragment: Box, build: number) {
  for await (const box of children(file, fragment)) {
    if (box.type !== 'traf') continue
    const track = await fields(file, box)
    const [header, run] = await Promise.all([
      contents(file, track.get('tfhd'), 32), contents(file, track.get('trun'), 32)
    ])
    if (!header || header.readUInt32BE(4) !== 1 || !run || !run.readUInt32BE(4)) continue
    const flags = run.readUIntBE(1, 3)
    const defaults = header.readUIntBE(1, 3)
    // Our muxer writes default-base-is-moof and a data offset in each run.
    if (!(defaults & 0x020000) || !(flags & 1)) throw new Error('Missing AVC fragment data offset')
    const offset = fragment.offset + run.readInt32BE(8)
    const size = flags & 0x200
      ? run.readUInt32BE(12 + (flags & 4 ? 4 : 0) + (flags & 0x100 ? 4 : 0))
      : defaults & 0x10 ? header.readUInt32BE(8 + (defaults & 2 ? 4 : 0) + (defaults & 8 ? 4 : 0)) : 0
    if (!size) throw new Error('Missing AVC fragment sample size')
    const sample = await readBytes(file, offset, size)
    let picture: number | undefined
    for (let pos = 0; pos < sample.length;) {
      const end = pos + 4 + sample.readUInt32BE(pos)
      if (end <= pos + 4 || end > size) throw new Error('Invalid AVC sample')
      const type = sample[pos + 4] & 31
      if (type === 1 || type === 5) picture ??= pos
      if (type === 6 && sample.subarray(pos + 5, end).includes(`x264 - core ${build}`)) {
        if (picture !== undefined) {
          const sei = Buffer.from(sample.subarray(pos, end))
          sample.copyWithin(picture + sei.length, picture, pos)
          sei.copy(sample, picture)
          let written = picture
          while (written < end) {
            const result = await file.write(sample, written, end - written, offset + written)
            if (!result.bytesWritten) throw new Error('Could not write AVC sample')
            written += result.bytesWritten
          }
        }
        break
      }
      pos = end
    }
    return
  }
}

/** Separate a generated fragment from its ftyp/moov initialization prefix. */
export async function inspectMp4Segment(path: string, needsInitialization: boolean, x264Build?: number) {
  const needsVersion = x264Build !== undefined && x264Build < 151
  const file = await open(path, needsVersion ? 'r+' : 'r')
  try {
    const { size } = await file.stat()
    const first = boxHeader(await readBytes(file, 0, Math.min(16, size)), 0, size)
    if (first.type !== 'ftyp') throw new Error('Missing MP4 file type')
    const second = boxHeader(await readBytes(file, first.end, Math.min(16, size - first.end)), 0, size, first.end)
    if (second.type !== 'moov' || second.end === size) throw new Error('Missing fragmented MP4 media')
    if (needsVersion) {
      for await (const fragment of children(file, { start: second.end, end: size })) {
        if (fragment.type === 'moof') await orderX264Metadata(file, fragment, x264Build)
      }
    }
    return {
      offset: second.end,
      initialization: needsInitialization ? await readBytes(file, 0, second.end) : undefined
    }
  } finally {
    await file.close()
  }
}
