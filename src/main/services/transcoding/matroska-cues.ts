import { open, type FileHandle } from 'node:fs/promises'

const id = {
  segment: 0x18538067, seekHead: 0x114d9b74, seek: 0x4dbb, seekId: 0x53ab, seekPosition: 0x53ac,
  info: 0x1549a966, timestampScale: 0x2ad7b1, tracks: 0x1654ae6b, trackEntry: 0xae,
  trackNumber: 0xd7, trackType: 0x83, cues: 0x1c53bb6b, cuePoint: 0xbb,
  cueTime: 0xb3, cueTrackPositions: 0xb7, cueTrack: 0xf7, cluster: 0x1f43b675
}

interface Element {
  id: number
  start: number
  end: number
}

function readVint(bytes: Buffer, offset: number, keepMarker: boolean) {
  const first = bytes[offset]
  if (!first) throw new Error('Invalid Matroska element')
  let mask = 0x80
  let size = 1
  while (!(first & mask)) {
    mask >>= 1
    size++
  }
  if (offset + size > bytes.length || (keepMarker && size > 4)) throw new Error('Truncated Matroska element')
  let value = keepMarker ? first : first & (mask - 1)
  let unknown = !keepMarker && value === mask - 1
  for (let index = 1; index < size; index++) {
    value = value * 256 + bytes[offset + index]
    unknown &&= bytes[offset + index] === 255
  }
  if (unknown) value = Infinity
  if (value !== Infinity && !Number.isSafeInteger(value)) throw new Error('Matroska integer exceeds precision')
  return { value, size }
}

function header(bytes: Buffer, offset: number, base: number, limit: number): Element {
  const identifier = readVint(bytes, offset, true)
  const length = readVint(bytes, offset + identifier.size, false)
  const start = base + offset + identifier.size + length.size
  const end = length.value === Infinity ? limit : start + length.value
  if (!Number.isSafeInteger(end) || end > limit || start > end) throw new Error('Truncated Matroska element data')
  return { id: identifier.value, start, end }
}

function* elements(data: Buffer) {
  for (let offset = 0; offset < data.length;) {
    const element = header(data, offset, 0, data.length)
    yield { id: element.id, data: data.subarray(element.start, element.end) }
    offset = element.end
  }
}

function uint(bytes: Buffer | undefined): number | undefined {
  if (!bytes || !bytes.length || bytes.length > 8) return
  let number = 0
  for (const byte of bytes) number = number * 256 + byte
  if (Number.isSafeInteger(number)) return number
}

async function read(file: FileHandle, start: number, length: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length)
  let total = 0
  while (total < length) {
    const { bytesRead } = await file.read(bytes, total, length - total, start + total)
    if (!bytesRead) throw new Error('Unexpected end of Matroska file')
    total += bytesRead
  }
  return bytes
}

/** Read the container's index without walking any media packets. */
export async function readMatroskaCueTimes(filePath: string): Promise<number[]> {
  const file = await open(filePath, 'r')
  try {
    const { size } = await file.stat()
    const readHeader = async (start: number, end: number) =>
      header(await read(file, start, Math.min(12, end - start)), 0, start, end)
    const readMetadata = async (element: Element) => {
      const length = element.end - element.start
      if (length > 32 * 1024 * 1024) throw new Error('Matroska index is too large')
      return read(file, element.start, length)
    }

    let segment = await readHeader(0, size)
    if (segment.id !== id.segment) segment = await readHeader(segment.end, size)
    if (segment.id !== id.segment) return []

    const metadata = new Map<number, Element>()
    const seekPositions = new Map<number, number>()
    const readSeekHead = async (element: Element) => {
      for (const entry of elements(await readMetadata(element))) {
        if (entry.id !== id.seek) continue
        const fields = new Map(Array.from(elements(entry.data), (field) => [field.id, field.data]))
        const identifier = uint(fields.get(id.seekId))
        const position = uint(fields.get(id.seekPosition))
        if (identifier !== undefined && position !== undefined) seekPositions.set(identifier, position)
      }
    }
    const visitedSeekHeads = new Set<number>()
    for (let offset = segment.start; offset < segment.end;) {
      const element = await readHeader(offset, segment.end)
      if (element.id === id.cluster) break
      if (element.id === id.seekHead) {
        await readSeekHead(element)
        visitedSeekHeads.add(offset)
      } else {
        metadata.set(element.id, element)
      }
      if ([id.info, id.tracks, id.cues].every((identifier) => seekPositions.has(identifier) || metadata.has(identifier))) break
      offset = element.end
    }
    // A muxer may put Cues in a secondary SeekHead instead of its initial metadata.
    while (!seekPositions.has(id.cues) && !metadata.has(id.cues)) {
      const relative = seekPositions.get(id.seekHead)
      if (relative === undefined || relative >= segment.end - segment.start) break
      const position = segment.start + relative
      if (visitedSeekHeads.has(position)) break
      visitedSeekHeads.add(position)
      const element = await readHeader(position, segment.end)
      if (element.id !== id.seekHead) break
      await readSeekHead(element)
    }
    for (const identifier of [id.info, id.tracks, id.cues]) {
      const position = seekPositions.get(identifier)
      if (metadata.has(identifier) || position === undefined || position >= segment.end - segment.start) continue
      const element = await readHeader(segment.start + position, segment.end)
      if (element.id === identifier) metadata.set(identifier, element)
    }
    const info = metadata.get(id.info)
    const tracks = metadata.get(id.tracks)
    const cues = metadata.get(id.cues)
    if (!info || !tracks || !cues) return []

    const scale = uint(Array.from(elements(await readMetadata(info))).find((field) => field.id === id.timestampScale)?.data) ?? 1_000_000
    let videoTrack: number | undefined
    for (const track of elements(await readMetadata(tracks))) {
      if (track.id !== id.trackEntry) continue
      const fields = new Map(Array.from(elements(track.data), (field) => [field.id, field.data]))
      if (uint(fields.get(id.trackType)) !== 1) continue
      videoTrack = uint(fields.get(id.trackNumber))
      break
    }
    if (!videoTrack || !scale) return []

    const times: number[] = []
    for (const cue of elements(await readMetadata(cues))) {
      if (cue.id !== id.cuePoint) continue
      let time: number | undefined
      let isVideo = false
      for (const field of elements(cue.data)) {
        if (field.id === id.cueTime) time = uint(field.data)
        if (field.id !== id.cueTrackPositions) continue
        for (const track of elements(field.data)) {
          if (track.id === id.cueTrack && uint(track.data) === videoTrack) isVideo = true
        }
      }
      if (isVideo && time !== undefined) times.push(time * scale / 1_000_000_000)
    }
    return [...new Set(times)].sort((a, b) => a - b)
  } finally {
    await file.close()
  }
}
