import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Stats } from 'node:fs'
import { runTransaction } from '../database/client'
import * as locations from '../database/repositories/filesystem.repo'
import { parseEpisodeInfo, parseSeasonFolder } from '../utils/tv-parser'

export interface DiscoveredLocation {
  relativePath: string
  name: string
  type: 'file' | 'folder'
  stats: Stats
  ignored: boolean
  contentFingerprint?: string
  shadow?: { itemId: string; locationId: string }
  emptySeasonItemId?: string
}

type LocationMatch = {
  itemId: string
  rule: 'exact-location' | 'inode-device' | 'shadow' | 'empty-season' | 'same-relative-path' | 'content-fingerprint' | 'parsed-media'
  moveLocationId?: string
}

export type SourceHistory = Map<string, Set<string>>
type LocationEvidence = {
  scannedPaths: SourceHistory
  probedMissingPaths: SourceHistory
}

function fingerprint(inode: number | null, device: number | null): string | null {
  return inode && device != null ? `${device}:${inode}` : null
}

function matchEpisode(
  entry: DiscoveredLocation,
  priorSources: SourceHistory,
): LocationMatch | 'ambiguous' | undefined {
  const { relativePath, contentFingerprint } = entry
  const parsed = parseEpisodeInfo(path.posix.basename(relativePath))
  if (!parsed) return

  const parentPath = path.posix.dirname(relativePath)
  const parentSeason = parseSeasonFolder(path.posix.basename(parentPath))
  const seasonNumber = parsed.season ?? parentSeason
  const showRootPath = parentSeason === null ? parentPath : path.posix.dirname(parentPath)
  if (seasonNumber == null || showRootPath === '.') return

  const candidates = locations.findEpisodeMoveCandidates({
    sourceIds: priorSources.keys(),
    showRootPath,
    seasonNumber,
    episodeNumber: parsed.episode,
  }).filter(({ sourceId, path }) => {
    const discovered = priorSources.get(sourceId)
    return discovered && !discovered.has(path) && !discovered.has(showRootPath)
  })
  const ids = new Set(candidates.map(({ itemId }) => itemId))
  if (ids.size > 1 || candidates.some((candidate) =>
    contentFingerprint && candidate.contentFingerprint && candidate.contentFingerprint !== contentFingerprint
  )) return 'ambiguous'
  if (ids.size === 1) {
    return { itemId: candidates[0].itemId, rule: 'parsed-media' }
  }
}

export function buildReconciliationPlan(
  sourceId: string,
  discovered: DiscoveredLocation[],
  previous: ReturnType<typeof locations.getScanLocations>,
  foundLocationPaths: Set<string>,
  scanSucceeded: boolean,
  evidence: LocationEvidence,
  diagnose: (message: string) => void,
) {
  const byPath = new Map(previous.map((location) => [location.path, location]))
  const missingByFingerprint = new Map<string, typeof previous>()
  const fingerprintCounts = new Map<string, number>()
  const contentCounts = new Map<string, number>()
  const sourceIds = [...new Set([...evidence.scannedPaths.keys(), ...evidence.probedMissingPaths.keys()])]
  const isProvenAbsent = (id: string, relativePath: string) => {
    const paths = evidence.scannedPaths.get(id)
    return paths ? !paths.has(relativePath) : evidence.probedMissingPaths.get(id)?.has(relativePath) === true
  }

  for (const entry of discovered) {
    const key = fingerprint(entry.stats.ino, entry.stats.dev)
    if (key) fingerprintCounts.set(key, (fingerprintCounts.get(key) ?? 0) + 1)
    const content = entry.contentFingerprint
    if (content) contentCounts.set(content, (contentCounts.get(content) ?? 0) + 1)
  }
  if (scanSucceeded) {
    for (const old of previous) {
      const key = fingerprint(old.inode, old.deviceId)
      if (!key || foundLocationPaths.has(old.path)) continue
      const candidates = missingByFingerprint.get(key) ?? []
      candidates.push(old)
      missingByFingerprint.set(key, candidates)
    }
  }

  const matchLocation = (entry: DiscoveredLocation): LocationMatch | undefined => {
    const { relativePath, stats, type, shadow, contentFingerprint } = entry
    const decline = (reason: string) => {
      diagnose(`Keeping ${sourceId}/${relativePath} separate (${reason})`)
      return undefined
    }
    const exact = byPath.get(relativePath)
    if (shadow) return { itemId: shadow.itemId, rule: 'shadow' }
    if (exact) return { itemId: exact.id, rule: 'exact-location' }
    if (entry.emptySeasonItemId) return { itemId: entry.emptySeasonItemId, rule: 'empty-season' }

    const key = fingerprint(stats.ino, stats.dev)
    if (key && fingerprintCounts.get(key) === 1) {
      const candidates = missingByFingerprint.get(key) ?? []
      if (candidates.length > 1) return decline('multiple prior inode/device matches')
      const match = candidates[0]
      if (match?.type === type && (!match.birthtime || match.birthtime === Math.floor(stats.birthtimeMs))) {
        return { itemId: match.id, rule: 'inode-device', moveLocationId: match.locationId }
      }
    }

    const knownAbsentSourceIds = sourceIds.filter((id) => isProvenAbsent(id, relativePath))
    const alternate = locations.matchAlternateLocation({
      sourceId, relativePath, type, inode: stats.ino, deviceId: stats.dev, knownAbsentSourceIds, contentFingerprint
    })
    if (alternate === 'ambiguous') return decline('conflicting alternate locations')
    if (alternate) return alternate

    if (contentFingerprint && contentCounts.get(contentFingerprint) === 1) {
      const candidates = locations.findContentFingerprintCandidates(contentFingerprint)
      const absent = candidates.filter((candidate) => {
        if (foundLocationPaths.has(candidate.path)) return false
        if (candidate.sourceId === sourceId) {
          return scanSucceeded && byPath.has(candidate.path)
        }
        return !candidate.present || isProvenAbsent(candidate.sourceId, candidate.path)
      })
      if (absent.length > 0) {
        if (new Set(candidates.map(({ itemId }) => itemId)).size > 1) {
          return decline('multiple content fingerprint matches')
        }
        const old = absent.find((candidate) => candidate.sourceId === sourceId) ?? absent[0]
        return {
          itemId: old.itemId,
          rule: 'content-fingerprint',
          moveLocationId: old.sourceId === sourceId ? old.locationId : undefined,
        }
      }
    }
    if (type === 'file') {
      const match = matchEpisode(entry, evidence.scannedPaths)
      return match === 'ambiguous' ? decline('conflicting parsed episode matches') : match
    }
  }

  const matches = discovered.map(matchLocation)
  const claimed = new Map<string, number>()
  for (const match of matches) {
    if (match && match.rule !== 'exact-location' && match.rule !== 'shadow') {
      claimed.set(match.itemId, (claimed.get(match.itemId) ?? 0) + 1)
    }
  }

  const itemIds = new Map<string, string>()
  return discovered.map((entry, index) => {
    let match = matches[index]
    if (match && (claimed.get(match.itemId) ?? 0) > 1 &&
      match.rule !== 'exact-location' && match.rule !== 'shadow') {
      diagnose(`Keeping ${sourceId}/${entry.relativePath} separate (multiple claims on ${match.itemId})`)
      match = undefined
    }
    const itemId = match?.itemId ?? locations.generateItemId()
    const parentPath = path.posix.dirname(entry.relativePath)
    const parentId = entry.relativePath === '.'
      ? locations.LIBRARY_ROOT_ID
      : itemIds.get(parentPath) ?? locations.getItemIdBySourcePath(sourceId, parentPath)
    itemIds.set(entry.relativePath, itemId)
    return { entry, itemId, parentId, match }
  })
}

export function applyReconciliationPlan(
  sourceId: string,
  plan: ReturnType<typeof buildReconciliationPlan>,
  diagnose: (message: string) => void,
): Set<string> {
  runTransaction(() => {
    for (const { entry, match } of plan) {
      if (match?.moveLocationId) {
        locations.moveLocationPath(match.moveLocationId, entry.relativePath)
      }
    }
    locations.upsertLibraryItems(plan.map(({ entry, itemId, parentId }) => ({
      '@id': itemId,
      '@locationId': randomUUID(),
      '@parentId': parentId,
      '@path': entry.relativePath,
      '@name': entry.name,
      '@type': entry.type,
      '@sourceId': sourceId,
      '@size': entry.stats.size,
      '@mtime': Math.floor(entry.stats.mtimeMs),
      '@birthtime': Math.floor(entry.stats.birthtimeMs),
      '@inode': entry.stats.ino,
      '@deviceId': entry.stats.dev,
      '@locationFingerprint': entry.contentFingerprint ?? null,
      '@isIgnored': entry.ignored ? 1 : 0,
      '@isShadowed': entry.shadow ? 1 : 0,
      '@shadowedByLocationId': entry.shadow?.locationId ?? null,
    })))
  })

  for (const { entry, itemId, match } of plan) {
    if (match && match.rule !== 'exact-location') {
      diagnose(`Reconciled ${sourceId}/${entry.relativePath} as ${itemId} (${match.rule})`)
    }
  }
  return new Set(plan.map(({ itemId }) => itemId))
}
