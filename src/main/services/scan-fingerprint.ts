import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'
import type { DiscoveredLocation } from './scan-reconciliation.service'

const SAMPLE_BYTES = 32 * 1024

export async function fileFingerprint(absolutePath: string, stats: Stats): Promise<string | undefined> {
  if (stats.size === 0) return
  try {
    const file = await open(absolutePath, 'r')
    try {
      const hash = createHash('sha256').update(String(stats.size)).update(':')
      const offsets = stats.size <= SAMPLE_BYTES
        ? [0]
        : [...new Set([0, Math.floor((stats.size - SAMPLE_BYTES) / 2), stats.size - SAMPLE_BYTES])]
      const sample = Buffer.allocUnsafe(Math.min(SAMPLE_BYTES, stats.size))
      for (const position of offsets) {
        const { bytesRead } = await file.read(sample, 0, sample.length, position)
        if (bytesRead !== sample.length) return
        hash.update(sample)
      }
      const after = await file.stat()
      if (after.ino === stats.ino && after.size === stats.size && after.mtimeMs === stats.mtimeMs) {
        return `file:v1:${hash.digest('hex')}`
      }
    } finally {
      await file.close()
    }
  } catch {
    // An unreadable sample does not prevent normal path and inode reconciliation.
  }
}

export function fingerprintFolders(discovered: DiscoveredLocation[]): void {
  const children = new Map<string, (string | undefined)[]>()
  for (let i = discovered.length - 1; i >= 0; i--) {
    const entry = discovered[i]
    const { relativePath } = entry
    if (relativePath === '.') continue
    if (entry.type === 'folder' && !entry.ignored && !entry.shadow) {
      const hashes = children.get(relativePath)
      if (hashes?.length && hashes.every((hash) => hash !== undefined)) {
        const hash = createHash('sha256').update(JSON.stringify(hashes.sort()))
        entry.contentFingerprint = `folder:v1:${hash.digest('hex')}`
      }
    }
    const parentPath = path.posix.dirname(relativePath)
    const siblingHashes = children.get(parentPath) ?? []
    siblingHashes.push(entry.contentFingerprint)
    children.set(parentPath, siblingHashes)
  }
}
