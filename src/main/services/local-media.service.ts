import { stat } from 'node:fs/promises'
import { findProbeCandidates, saveProbeResult, type ProbeCandidate } from '../database/repositories/local-media.repo'
import { processInChunks, SerializedQueue } from '../utils/concurrency'
import { getTransport } from '../transport.registry'
import { securePathJoin } from './paths.service'
import { probeMedia } from './probe-media'
import type { LocalMedia } from '@shared/local-media'

const DEFAULT_PROBE_CONCURRENCY = 1
const STABILITY_WINDOW_MS = 60_000
const batches = new SerializedQueue()

async function matchesScan(filePath: string, file: ProbeCandidate): Promise<boolean> {
  const stats = await stat(filePath)
  return stats.isFile() && stats.size === file.size && Math.floor(stats.mtimeMs) === file.mtime
    && Math.floor(stats.birthtimeMs) === file.birthtime && stats.ino === file.inode && stats.dev === file.device
}

export function refreshLocalMedia(
  sourcePaths: ReadonlyMap<string, string>,
  { concurrency = DEFAULT_PROBE_CONCURRENCY, onChanged }: {
    concurrency?: number
    onChanged?: () => Promise<void>
  } = {}
): Promise<boolean> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Probe concurrency must be a positive integer')
  return batches.run(async () => {
    if (!sourcePaths.size) return false
    const executable = Bun.which('ffprobe')
    if (!executable) {
      console.warn('[Local media] Skipping file metadata extraction because ffprobe was not found on PATH')
      return false
    }
    const candidates = findProbeCandidates([...sourcePaths.keys()], Date.now())
    if (!candidates.length) return false

    const batch = crypto.randomUUID()
    const started = performance.now()
    let saved = 0
    let failed = 0
    let removed = 0
    console.info('[Local media] Probing files', { batch, files: candidates.length })
    getTransport().notifyScanStatusChanged({ isProbingLocalMedia: true })
    try {
      await processInChunks(candidates, concurrency, async (file) => {
        const filePath = securePathJoin(sourcePaths.get(file.sourceId)!, file.relativePath)
        if (!filePath) return
        try {
          if (!await matchesScan(filePath, file)) return
          let media: LocalMedia | null = null
          let retryAt: number | null = null
          try {
            media = await probeMedia(executable, filePath)
            // Recheck recently written files once even if the container header was readable.
            if (file.mtime + STABILITY_WINDOW_MS > Date.now()) retryAt = file.mtime + STABILITY_WINDOW_MS
          } catch (error) {
            retryAt = Date.now() + Math.min(60, 2 ** Math.min(file.failures, 6)) * STABILITY_WINDOW_MS
            console.debug('[Local media] Probe failed', { batch, locationId: file.id, error })
          }
          if (await matchesScan(filePath, file) && saveProbeResult(file, media, retryAt)) {
            if (media) saved++
            else {
              failed++
              removed += file.hadMetadata
            }
          }
        } catch (error) {
          failed++
          console.debug('[Local media] Could not refresh file', { batch, locationId: file.id, error })
        }
      })
      console.info('[Local media] Probe complete', { batch, saved, failed, removed, durationMs: Math.round(performance.now() - started) })
      const changed = saved > 0 || removed > 0
      if (changed) await onChanged?.()
      return changed
    } finally {
      getTransport().notifyScanStatusChanged({ isProbingLocalMedia: false })
    }
  })
}
