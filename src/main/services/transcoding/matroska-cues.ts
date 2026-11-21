import { open, type FileHandle } from 'node:fs/promises'
import { inflate } from 'node:zlib'
import { promisify } from 'node:util'
import type { LocalMediaTrack } from '@shared/local-media'

const id = {
  segment: 0x18538067, seekHead: 0x114d9b74, seek: 0x4dbb, seekId: 0x53ab, seekPosition: 0x53ac,
  info: 0x1549a966, timestampScale: 0x2ad7b1, tracks: 0x1654ae6b, trackEntry: 0xae,
  trackNumber: 0xd7, trackType: 0x83, cues: 0x1c53bb6b, cuePoint: 0xbb,
  cueTime: 0xb3, cueTrackPositions: 0xb7, cueTrack: 0xf7, cluster: 0x1f43b675,
  writingApp: 0x5741, codecId: 0x86, codecPrivate: 0x63a2, contentEncodings: 0x6d80,
  trackTimestampScale: 0x23314f, trackOffset: 0x537f, codecDelay: 0x56aa,
  cueClusterPosition: 0xf1, cueRelativePosition: 0xf0, cueDuration: 0xb2, cueCodecState: 0xea,
  simpleBlock: 0xa3, blockGroup: 0xa0, block: 0xa1, codecState: 0xa4
}

const maxMetadataSize = 32 * 1024 * 1024

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

function fields(data: Buffer): Map<number, Buffer> {
  return new Map(Array.from(elements(data), (field) => [field.id, field.data]))
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

const fileHeader = async (file: FileHandle, start: number, end: number) =>
  header(await read(file, start, Math.min(12, end - start)), 0, start, end)

async function readSegment(file: FileHandle) {
  const { size } = await file.stat()
  let segment = await fileHeader(file, 0, size)
  if (segment.id !== id.segment) segment = await fileHeader(file, segment.end, size)
  return segment.id === id.segment ? segment : undefined
}

export async function matroskaWriter(filePath: string) {
  const file = await open(filePath, 'r')
  try {
    const segment = await readSegment(file)
    if (!segment) return
    for (let offset = segment.start; offset < segment.end;) {
      const element = await fileHeader(file, offset, segment.end)
      if (element.id === id.cluster) return
      if (element.id === id.info) {
        if (element.end - element.start > maxMetadataSize) return
        return fields(await read(file, element.start, element.end - element.start)).get(id.writingApp)?.toString()
      }
      offset = element.end
    }
  } finally {
    await file.close()
  }
}

async function readMatroskaIndex(filePath: string) {
  const file = await open(filePath, 'r')
  try {
    const readHeader = (start: number, end: number) => fileHeader(file, start, end)
    const readMetadata = async (element: Element) => {
      const length = element.end - element.start
      if (length > maxMetadataSize) throw new Error('Matroska index is too large')
      return read(file, element.start, length)
    }

    const segment = await readSegment(file)
    if (!segment) return

    const metadata = new Map<number, Element>()
    const seekPositions = new Map<number, number>()
    const readSeekHead = async (element: Element) => {
      for (const entry of elements(await readMetadata(element))) {
        if (entry.id !== id.seek) continue
        const seek = fields(entry.data)
        const identifier = uint(seek.get(id.seekId))
        const position = uint(seek.get(id.seekPosition))
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
    if (!info || !tracks || !cues) return
    const infoFields = fields(await readMetadata(info))
    const scale = uint(infoFields.get(id.timestampScale)) ?? 1_000_000
    if (!scale) return
    return {
      segment, scale, writingApp: infoFields.get(id.writingApp)?.toString(),
      tracks: Array.from(elements(await readMetadata(tracks))).filter((track) => track.id === id.trackEntry)
        .map((track) => fields(track.data)),
      cues: await readMetadata(cues)
    }
  } finally {
    await file.close()
  }
}

function* cuePositions(data: Buffer) {
  for (const cue of elements(data)) {
    if (cue.id !== id.cuePoint) continue
    const children = Array.from(elements(cue.data))
    const time = uint(children.find((field) => field.id === id.cueTime)?.data)
    if (time === undefined) continue
    for (const child of children) {
      if (child.id === id.cueTrackPositions) yield { time, position: fields(child.data) }
    }
  }
}

/** Read the container's index without walking any media packets. */
export async function readMatroskaCueTimes(filePath: string): Promise<number[]> {
  const index = await readMatroskaIndex(filePath)
  if (!index) return []
  const videoTrack = uint(index.tracks.find((track) => uint(track.get(id.trackType)) === 1)?.get(id.trackNumber))
  if (!videoTrack) return []
  const times = new Set<number>()
  for (const { time, position } of cuePositions(index.cues)) {
    if (uint(position.get(id.cueTrack)) === videoTrack) times.add(time * index.scale / 1_000_000_000)
  }
  return [...times].sort((a, b) => a - b)
}

interface SubtitleCue {
  start: number
  end: number
  cluster: number
  relative: number
}

interface CueIndex {
  track: number
  segmentEnd: number
  cues: SubtitleCue[]
}

interface AssIndex extends CueIndex {
  format: 'ass'
  header: string
  footer: string
}

interface PgsIndex extends CueIndex {
  format: 'pgs'
  compressed: boolean
}

export type MatroskaSubtitleIndex = AssIndex | PgsIndex

// mkvmerge commonly zlib-compresses each bitmap block. Other encodings
// (including header stripping) stay on the FFmpeg extraction path.
function isZlibEncoding(data: Buffer): boolean {
  const entries = [...elements(data)]
  if (entries.length !== 1 || entries[0].id !== 0x6240) return false
  const encoding = fields(entries[0].data)
  const compression = encoding.get(0x5034)
  if (!compression || encoding.has(0x5035) || (uint(encoding.get(0x5032)) ?? 1) !== 1 ||
      (uint(encoding.get(0x5033)) ?? 0) !== 0) return false
  const options = fields(compression)
  return (uint(options.get(0x4254)) ?? 0) === 0 && !options.get(0x4255)?.length
}

export async function readMatroskaSubtitleIndexes(filePath: string, streams: LocalMediaTrack[]) {
  const result = new Map<number, MatroskaSubtitleIndex>()
  const index = await readMatroskaIndex(filePath)
  if (!index?.writingApp?.startsWith('mkvmerge ')) return result
  const trackKind = { video: 1, audio: 2, subtitle: 17 }
  if (index.tracks.length !== streams.length ||
      streams.some((stream, i) => stream.index !== i || uint(index.tracks[i].get(id.trackType)) !== trackKind[stream.kind])) {
    return result
  }

  const candidates = new Map<number, MatroskaSubtitleIndex>()
  for (const stream of streams) {
    const entry = index.tracks[stream.index]
    const track = uint(entry.get(id.trackNumber))
    if (!track || entry.has(id.trackTimestampScale) || entry.has(id.trackOffset) || uint(entry.get(id.codecDelay))) continue
    const codec = entry.get(id.codecId)?.toString()
    const encoding = entry.get(id.contentEncodings)
    const base = { track, segmentEnd: index.segment.end, cues: [] }
    if (stream.codec === 'hdmv_pgs_subtitle' && codec === 'S_HDMV/PGS' && stream.packetCount &&
        (!encoding || isZlibEncoding(encoding))) {
      candidates.set(track, { ...base, format: 'pgs', compressed: !!encoding })
    } else if (stream.codec === 'ass' && codec === 'S_TEXT/ASS' && !encoding) {
      const script = entry.get(id.codecPrivate)?.toString()
      const events = script && /^\[Events\][ \t]*\r?$/mi.exec(script)
      if (!script || !events) continue
      const header = script.slice(0, events.index).trimEnd() +
        '\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
      const afterEvents = script.slice(events.index + events[0].length)
      const nextSection = afterEvents.search(/^\[/m)
      candidates.set(track, { ...base, format: 'ass', header, footer: nextSection === -1 ? '' : afterEvents.slice(nextSection) })
    }
  }
  if (!candidates.size) return result

  const firstVideoTrack = uint(index.tracks[streams.findIndex((stream) => stream.kind === 'video')]?.get(id.trackNumber))
  let startsAtZero = false
  for (const { time, position } of cuePositions(index.cues)) {
    const track = uint(position.get(id.cueTrack))
    if (track === firstVideoTrack && time === 0) startsAtZero = true
    const candidate = track === undefined ? undefined : candidates.get(track)
    if (!candidate) continue
    const duration = uint(position.get(id.cueDuration))
    const cluster = uint(position.get(id.cueClusterPosition))
    const relative = uint(position.get(id.cueRelativePosition))
    if ((candidate.format === 'ass' && duration === undefined) || cluster === undefined || relative === undefined ||
        position.has(id.cueCodecState) || cluster >= index.segment.end - index.segment.start) {
      candidates.delete(candidate.track)
      continue
    }
    candidate.cues.push({
      start: time * index.scale / 1_000_000,
      end: (time + (duration ?? 0)) * index.scale / 1_000_000,
      cluster: index.segment.start + cluster, relative
    })
  }
  if (!startsAtZero) return result
  for (const stream of streams) {
    const candidate = candidates.get(uint(index.tracks[stream.index].get(id.trackNumber))!)
    if (!candidate?.cues.length) continue
    // Partial bitmap indexes can omit palette updates and clears.
    if (candidate.format === 'pgs' && candidate.cues.length !== stream.packetCount) continue
    candidate.cues.sort((a, b) => a.cluster - b.cluster || a.relative - b.relative)
    if (candidate.format === 'pgs' && candidate.cues.some((cue, i, cues) => i && cue.start < cues[i - 1].start)) continue
    result.set(stream.index, candidate)
  }
  return result
}

function cueReader(file: FileHandle, index: CueIndex, signal: AbortSignal) {
  let cluster: Element | undefined
  let position: number | undefined
  return async (cue: SubtitleCue) => {
    signal.throwIfAborted()
    if (!cluster || position !== cue.cluster) {
      position = cue.cluster
      cluster = await fileHeader(file, position, index.segmentEnd)
      if (cluster.id !== id.cluster) throw new Error('Invalid Matroska subtitle cue cluster')
    }
    const element = await fileHeader(file, cluster.start + cue.relative, cluster.end)
    if (element.end - element.start > maxMetadataSize) throw new Error('Matroska subtitle block is too large')
    let block = await read(file, element.start, element.end - element.start)
    if (element.id === id.blockGroup) {
      const group = fields(block)
      if (group.has(id.codecState)) throw new Error('Unsupported Matroska subtitle codec state')
      block = group.get(id.block) ?? Buffer.alloc(0)
    } else if (element.id !== id.simpleBlock) throw new Error('Invalid Matroska subtitle block')
    const track = readVint(block, 0, false)
    if (track.value !== index.track || block.length < track.size + 4 || (block[track.size + 2] & 6)) {
      throw new Error('Unsupported Matroska subtitle packet')
    }
    return block.subarray(track.size + 3)
  }
}

const inflateBlock = promisify(inflate)

function supPacket(block: Buffer, ms: number): Buffer {
  const parts: Buffer[] = []
  const clock = Math.round(ms * 90) >>> 0
  for (let offset = 0; offset < block.length;) {
    const end = offset + 3 + block.readUInt16BE(offset + 1)
    if (end > block.length) throw new Error('Truncated PGS segment')
    const header = Buffer.allocUnsafe(10)
    header.write('PG')
    header.writeUInt32BE(clock, 2)
    header.writeUInt32BE(clock, 6)
    parts.push(header, block.subarray(offset, end))
    offset = end
  }
  return Buffer.concat(parts)
}

export async function readMatroskaPgsWindow(
  filePath: string, index: PgsIndex, startMs: number, endMs: number, signal: AbortSignal
): Promise<Buffer> {
  const cues = index.cues
  const last = cues.findLastIndex((cue) => cue.start < endMs)
  if (last < 0) return Buffer.alloc(0)
  let first = Math.max(0, cues.findLastIndex((cue) => cue.start <= startMs))
  const file = await open(filePath, 'r')
  try {
    const readCue = cueReader(file, index, signal)
    // A normal composition may reuse a bitmap or palette from an earlier
    // display set. Seek back to the last epoch start and replay that state.
    const packet = async (i: number) => {
      const block = await readCue(cues[i])
      return index.compressed ? inflateBlock(block, { maxOutputLength: maxMetadataSize }) : block
    }
    const history: Buffer[] = []
    for (;;) {
      const block = await packet(first)
      history.push(supPacket(block, cues[first].start))
      if (first === 0 || (block[0] === 0x16 && block.readUInt16BE(1) >= 11 && block[10] === 0x80)) break
      first--
    }
    const packets = history.reverse()
    for (let i = first + packets.length; i <= last; i++) packets.push(supPacket(await packet(i), cues[i].start))
    return Buffer.concat(packets)
  } finally {
    await file.close()
  }
}

function assTime(ms: number): string {
  const hundredths = Math.round(ms / 10)
  const hours = Math.floor(hundredths / 360_000)
  const minutes = String(Math.floor(hundredths / 6000) % 60).padStart(2, '0')
  const seconds = String(Math.floor(hundredths / 100) % 60).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}.${String(hundredths % 100).padStart(2, '0')}`
}

export async function readMatroskaAssWindow(
  filePath: string, index: AssIndex, startMs: number, endMs: number, signal: AbortSignal
): Promise<string> {
  const cues = index.cues.filter((cue) => cue.start < endMs && cue.end > startMs)
  if (!cues.length) return index.header + index.footer
  const file = await open(filePath, 'r')
  try {
    const events = new Map<number, string>()
    const readCue = cueReader(file, index, signal)
    for (const cue of cues) {
      const block = await readCue(cue)
      const payload = /^(\d+),(-?\d+),([^\r\n]*)$/.exec(block.toString('utf8'))
      if (!payload) throw new Error('Invalid Matroska ASS packet')
      events.set(Number(payload[1]), `Dialogue: ${payload[2]},${assTime(cue.start)},${assTime(cue.end)},${payload[3]}\n`)
    }
    return index.header + [...events].sort(([a], [b]) => a - b).map(([, event]) => event).join('') + index.footer
  } finally {
    await file.close()
  }
}
