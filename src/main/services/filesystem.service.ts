import { EFFECTIVE_METADATA } from '../database/item-metadata.sql'
import path from 'path'
import fs from 'fs/promises'
import type { Dirent } from 'node:fs'
import * as itemsRepo from '../database/repositories/filesystem.repo'
import * as settingsRepo from '../database/repositories/settings.repo'
import * as metadataRepo from '../database/repositories/metadata.repo'
import * as searchRepo from '../database/repositories/search.repo'
import { runTransaction } from '../database/client'
import * as pathsService from './paths.service'
import { GlobalTaskQueue } from '../utils/concurrency'
import type { MediaFolder, MediaSource } from '@shared/types'
import { getTransport } from '../transport.registry'
import * as repositoryService from './repository.service'
import { ITEM_READ_MODEL } from '../database/query-builder'
import { SPECIAL_FOLDER_NAMES_FOR_TV, isSupportedVideoFile, parseSeasonForFilesystem } from '../utils/tv-parser'
import {
  applyReconciliationPlan, buildReconciliationPlan, type DiscoveredLocation, type SourceHistory,
} from './scan-reconciliation.service'
import { fileFingerprint, fingerprintFolders } from './scan-fingerprint'
import { markDirty } from './account-filter.service'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Filesystem Service] ${message}`)
}

interface SyncDiskResult {
  foundItemIds: Set<string>
  foundLocationPaths: Set<string>
  foundNonEmptyFolderPaths: Set<string>
  scanSucceeded: boolean
}

/**
 * Throttled progress broadcaster for the UI.
 */
class ProgressBroadcaster {
  private lastBroadcast = 0
  private lastPath = ''
  private foundCount = 0

  update(currentPath: string) {
    this.foundCount++
    this.lastPath = currentPath

    const now = Date.now()
    if (now - this.lastBroadcast > 100) {
      this.broadcast()
      this.lastBroadcast = now
    }
  }

  broadcast() {
    getTransport().broadcast('SCANNER_PROGRESS', {
      path: this.lastPath,
      count: this.foundCount
    })
  }
}

async function probeMissingLocations(
  sourceId: string,
  discovered: DiscoveredLocation[],
  knownPaths: ReadonlySet<string>,
  priorSources: SourceHistory,
  sourcePaths?: ReadonlyMap<string, string>,
): Promise<SourceHistory> {
  const missing: SourceHistory = new Map()
  if (!sourcePaths || sourcePaths.size < 2) return missing

  const unscannedSources = new Map([...sourcePaths].filter(([id, root]) =>
    id !== sourceId && !priorSources.has(id) && !pathsService.isRemotePath(root)
  ))
  if (unscannedSources.size === 0) return missing

  const candidates: SourceHistory = new Map()
  for (const entry of discovered) {
    if (entry.shadow || knownPaths.has(entry.relativePath)) continue
    for (const match of itemsRepo.findPresentMoveCandidates(sourceId, entry.relativePath, entry.contentFingerprint)) {
      if (!unscannedSources.has(match.sourceId)) continue
      const paths = candidates.get(match.sourceId) ?? new Set<string>()
      paths.add(match.path)
      candidates.set(match.sourceId, paths)
    }
  }

  for (const [id, paths] of candidates) {
    const root = unscannedSources.get(id)!
    try {
      await fs.access(root)
    } catch {
      continue
    }
    for (const relativePath of paths) {
      const absolutePath = pathsService.securePathJoin(root, relativePath)
      if (!absolutePath) continue
      try {
        await fs.stat(absolutePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
        const absent = missing.get(id) ?? new Set<string>()
        absent.add(relativePath)
        missing.set(id, absent)
      }
    }
  }
  return missing
}

function getSeasonNumberForShadowing(name: string): number | null {
  return SPECIAL_FOLDER_NAMES_FOR_TV.includes(name.toLowerCase()) ? null : parseSeasonForFilesystem(name)
}

function getHigherPrioritySeasons(folderPaths?: ReadonlySet<string>): Map<string, Set<number>> {
  const seasonsByFolder = new Map<string, Set<number>>()
  if (!folderPaths) return seasonsByFolder

  for (const folderPath of folderPaths) {
    const season = getSeasonNumberForShadowing(path.posix.basename(folderPath))
    if (season === null) continue
    const parent = path.posix.dirname(folderPath)
    const seasons = seasonsByFolder.get(parent)
    if (seasons) seasons.add(season)
    else seasonsByFolder.set(parent, new Set([season]))
  }
  return seasonsByFolder
}

async function syncDiskToDatabase(
  rootAbsPath: string,
  source: { id: string; absolutePath: string },
  higherPriorityPaths?: Set<string>,
  shadowMinDepth: number = 1,
  cleanupMissing: boolean = true,
  priorSources: SourceHistory = new Map(),
  sourcePaths?: ReadonlyMap<string, string>,
  refetchRemoteMetadataOnFileChange = true
): Promise<SyncDiskResult> {
  const discovered: DiscoveredLocation[] = []
  const foundLocationPaths = new Set<string>()
  const foundNonEmptyFolderPaths = new Set<string>()
  const skippedBranches = new Set<string>()
  const higherPrioritySeasons = getHigherPrioritySeasons(higherPriorityPaths)
  const foldersFromShadowedShows = new Set<string>()
  const progress = new ProgressBroadcaster()
  const rootRelPath = itemsRepo.relativePathFromAbsolute(source.absolutePath, rootAbsPath)
  const previous = itemsRepo.getScanLocations(source.id, rootRelPath)
  const previousByPath = new Map(previous.map((location) => [location.path, location]))
  const hiddenPaths = new Set(previous.filter(({ hidden }) => hidden).map(({ path }) => path))
  let scanSucceeded = true

  const remember = (entry: DiscoveredLocation) => {
    discovered.push(entry)
    foundLocationPaths.add(entry.relativePath)
    progress.update(entry.relativePath)
  }

  const queue = new GlobalTaskQueue<string>(1, async (absolutePath) => {
    const relativePath = itemsRepo.relativePathFromAbsolute(source.absolutePath, absolutePath)
    try {
      const stats = await fs.stat(absolutePath)
      const shadowCandidate =
        relativePath !== rootRelPath &&
        relativePath.split('/').length >= shadowMinDepth &&
        higherPriorityPaths?.has(relativePath)
          ? itemsRepo.findPresentLocationByRelativePath(relativePath, source.id) ?? undefined
          : undefined
      const exact = previousByPath.get(relativePath)
      const shadow = shadowCandidate && (!exact || exact.id === shadowCandidate.itemId)
        ? shadowCandidate
        : undefined
      let emptyFolderItemId: string | undefined
      if (!exact && foldersFromShadowedShows.has(relativePath)) {
        const matchingFolders = new Set<string>()
        for (const [priorSourceId, paths] of priorSources) {
          if (!paths.has(relativePath)) continue
          const itemId = itemsRepo.getItemIdBySourcePath(priorSourceId, relativePath)
          if (itemId) matchingFolders.add(itemId)
        }
        if (matchingFolders.size === 1) [emptyFolderItemId] = matchingFolders
      }
      const entry: DiscoveredLocation = {
        relativePath,
        name: path.basename(absolutePath) || 'Library',
        type: 'folder',
        stats,
        ignored: false,
        shadow,
        emptyFolderItemId,
      }
      remember(entry)
      const existingSeasons = shadow ? higherPrioritySeasons.get(relativePath) : undefined
      if ((shadow && !existingSeasons) || hiddenPaths.has(relativePath)) {
        skippedBranches.add(relativePath)
        return
      }

      const children: Dirent[] = await fs.readdir(absolutePath, { withFileTypes: true })
      entry.ignored = children.some(({ name }) => name === '.ignore')
      if (entry.ignored) {
        skippedBranches.add(relativePath)
        return
      }
      if (existingSeasons) {
        // Keep unique folders browseable even if they have no recognized season number.
        for (const child of children) {
          const season = child.isDirectory() ? getSeasonNumberForShadowing(child.name) : null
          const childPath = path.posix.join(relativePath, child.name)
          if (child.isDirectory() && !higherPriorityPaths?.has(childPath) &&
              (season === null || !existingSeasons.has(season))) {
            foldersFromShadowedShows.add(childPath)
            queue.push(path.join(absolutePath, child.name))
          } else {
            skippedBranches.add(childPath)
          }
        }
        return
      }
      if (children.some((child) => child.isDirectory() || isSupportedVideoFile(child.name))) {
        foundNonEmptyFolderPaths.add(relativePath)
      }

      const files: Dirent[] = []
      for (const child of children) {
        if (child.isDirectory()) queue.push(path.join(absolutePath, child.name))
        else if (isSupportedVideoFile(child.name)) files.push(child)
      }
      const batchSize = 50
      for (let start = 0; start < files.length; start += batchSize) {
        const entries = await Promise.all(files.slice(start, start + batchSize).map(async ({ name }) => {
          const filePath = path.join(absolutePath, name)
          try {
            const stats = await fs.stat(filePath)
            if (!stats.isFile()) return
            const relativePath = itemsRepo.relativePathFromAbsolute(source.absolutePath, filePath)
            const prior = previousByPath.get(relativePath)
            const cached = prior?.contentFingerprint?.startsWith('file:v1:') &&
              prior.size === stats.size && prior.mtime === Math.floor(stats.mtimeMs) &&
              prior.birthtime === Math.floor(stats.birthtimeMs) && prior.inode === stats.ino &&
              prior.deviceId === stats.dev
            return {
              relativePath,
              name,
              type: 'file' as const,
              stats,
              ignored: false,
              contentFingerprint: cached
                ? prior?.contentFingerprint ?? undefined
                : await fileFingerprint(filePath, stats),
            }
          } catch {
            log(`Failed to stat: ${filePath}`)
            scanSucceeded = false
          }
        }))
        for (const file of entries) if (file) remember(file)
      }
    } catch {
      log(`Failed to read directory: ${absolutePath}`)
      scanSucceeded = false
    }
  })

  queue.push(rootAbsPath)
  await queue.waitForIdle()
  if (scanSucceeded) fingerprintFolders(discovered)
  progress.broadcast()
  const probedMissingPaths = await probeMissingLocations(
    source.id, discovered, new Set(previousByPath.keys()), priorSources, sourcePaths
  )

  const foundItemIds = runTransaction(() => {
    const currentLocations = itemsRepo.getScanLocations(source.id, rootRelPath)
    for (const location of currentLocations) {
      let relativePath = location.path
      while (relativePath !== '.') {
        if (skippedBranches.has(relativePath)) {
          foundLocationPaths.add(location.path)
          break
        }
        relativePath = path.posix.dirname(relativePath)
      }
    }
    const plan = buildReconciliationPlan(
      source.id, discovered, currentLocations, foundLocationPaths, scanSucceeded,
      { scannedPaths: priorSources, probedMissingPaths }, log, refetchRemoteMetadataOnFileChange
    )
    const ids = applyReconciliationPlan(source.id, plan, log)
    if (refetchRemoteMetadataOnFileChange) {
      const updatedFiles: string[] = []
      for (const { itemId, fileUpdated } of plan) {
        if (fileUpdated) updatedFiles.push(itemId)
      }
      for (const itemId of metadataRepo.markMetadataStaleForFiles(updatedFiles)) ids.add(itemId)
    }
    if (cleanupMissing) cleanupMissingForSource(source.id, rootRelPath, foundLocationPaths, scanSucceeded)
    return ids
  })
  markDirty()
  return { foundItemIds, foundLocationPaths, foundNonEmptyFolderPaths, scanSucceeded }
}

export function cleanupMissingForSource(sourceId: string, pathPrefix: string, foundLocationPaths: Set<string>, scanSucceeded: boolean): void {
  const normalizedPrefix = itemsRepo.normalizeRelativePath(pathPrefix)
  const scopePath = normalizedPrefix === '.' ? '' : normalizedPrefix
  if (!scanSucceeded) {
    log(`[Phase 1] Cleanup skipped for source ${sourceId} in scope "${scopePath}" because the scan did not complete successfully.`)
    return
  }
  const missingItems = itemsRepo.getScanLocations(sourceId, scopePath).filter((item) => item.present && !foundLocationPaths.has(item.path))

  log(
    `[Phase 1] Reconciliation: Checking ${missingItems.length} missing items for cleanup in scope: "${scopePath}"`
  )
  runTransaction(() => {
    for (const item of missingItems) {
      log(`[Phase 1] Marking location missing: ${item.path}`)
      itemsRepo.markLocationAsMissing(item.locationId)
    }
  })
  if (missingItems.length > 0) markDirty()
}

export async function scanDirectory(
  source: MediaSource,
  resolvedAbsPath: string,
  options: {
    skipMetadata?: boolean
    initialFolderSettings?: Record<string, any>
    higherPriorityPaths?: Set<string>
    shadowMinDepth?: number
    cleanupMissing?: boolean
    refetchRemoteMetadataOnFileChange?: boolean
    sameRelativePathRescueSources?: Map<string, Set<string>>
    sourcePaths?: ReadonlyMap<string, string>
    onFoundItems?: (foundItemIds: Set<string>) => void
    onFoundLocationPaths?: (foundLocationPaths: Set<string>) => void
    onFoundNonEmptyFolderPaths?: (foundFolderPaths: Set<string>) => void
    onScanSucceeded?: (scanSucceeded: boolean) => void
  } = {}
): Promise<MediaFolder | null> {
  log(`Starting Phase 1 (Filesystem Sync) for source ${source.id}: ${resolvedAbsPath}`)

  repositoryService.ensureSourceRoot(source, resolvedAbsPath)

  await syncDiskToDatabase(
    resolvedAbsPath,
    { id: source.id, absolutePath: resolvedAbsPath },
    options.higherPriorityPaths,
    options.shadowMinDepth,
    options.cleanupMissing ?? true,
    options.sameRelativePathRescueSources,
    options.sourcePaths,
    options.refetchRemoteMetadataOnFileChange
  )
    .then((result) => {
      options.onFoundItems?.(result.foundItemIds)
      options.onFoundLocationPaths?.(result.foundLocationPaths)
      options.onFoundNonEmptyFolderPaths?.(result.foundNonEmptyFolderPaths)
      options.onScanSucceeded?.(result.scanSucceeded)
    })

  if (options.initialFolderSettings) {
    for (const [relPath, settings] of Object.entries(options.initialFolderSettings)) {
      const normalizedRelPath = itemsRepo.normalizeRelativePath(relPath)
      const id = itemsRepo.getItemIdBySourcePath(source.id, normalizedRelPath)
      if (!id) continue
      settingsRepo.mergeSettings(id, { folderSettings: {
        retrieveChildrenMetadata: !!settings.retrieve_children_metadata,
        childrenTypeHint: settings.children_type_hint ?? null,
        processTvChildren: settings.process_tv_children !== false,
      } })
    }
  }

  return repositoryService.getRoot()
}

export async function syncWithDisk(node: MediaFolder, source: { id: string; absolutePath: string }, userId?: string | null): Promise<void> {
  const location = itemsRepo.getPresentFolderLocation(node.id, userId)
  if (!location) {
    log(`Cannot sync subtree without a present folder location: ${node.name}`)
    return
  }
  if (location.sourceId !== source.id) {
    log(`Cannot sync subtree from source ${source.id}; selected folder location is in source ${location.sourceId}`)
    return
  }

  const rootAbsPath = path.join(source.absolutePath, location.relativePath)

  log(`Syncing subtree: ${location.relativePath}`)

  await syncDiskToDatabase(rootAbsPath, source)
}

export function getFolderPathsForSource(sourceId: string): Set<string> {
  return itemsRepo.getAllFolderPathsInSource(sourceId)
}

export function getNonEmptyFolderPathsForSource(sourceId: string): Set<string> {
  return itemsRepo.getNonEmptyFolderPathsInSource(sourceId)
}

export async function verifyImagePaths(imagesDir: string): Promise<void> {
  const rows = searchRepo.executeSearchSql(
    `SELECT i.id AS item_id, e.poster_path, e.backdrop_path, e.logo_path
     FROM ${ITEM_READ_MODEL} i
     JOIN ${EFFECTIVE_METADATA} e ON i.id = e.item_id
     WHERE e.poster_path IS NOT NULL OR e.backdrop_path IS NOT NULL OR e.logo_path IS NOT NULL`,
    []
  ) as { item_id: string; poster_path: string | null; backdrop_path: string | null; logo_path: string | null }[]

  for (const row of rows) {
    const images = {
      poster: row.poster_path,
      backdrop: row.backdrop_path,
      logo: row.logo_path
    }
    let changed = false

    if (images.poster) {
      try {
        await fs.access(path.join(imagesDir, images.poster))
      } catch {
        images.poster = null
        changed = true
      }
    }
    if (images.backdrop) {
      try {
        await fs.access(path.join(imagesDir, images.backdrop))
      } catch {
        images.backdrop = null
        changed = true
      }
    }
    if (images.logo) {
      try {
        await fs.access(path.join(imagesDir, images.logo))
      } catch {
        images.logo = null
        changed = true
      }
    }

    if (changed) {
      metadataRepo.updateMetadataImages(row.item_id, images)
    }
  }
}

export function initializeRoot(
  source: MediaSource,
  resolvedAbsPath: string,
  initialFolderSettings?: Record<string, any>
): void {
  const rootId = itemsRepo.generateId(source.id, '.')
  const rootName = path.basename(resolvedAbsPath) || 'Library'
  const rootSettings = initialFolderSettings ? initialFolderSettings['.'] : undefined

  runTransaction(() => {
    itemsRepo.ensureLibraryVirtualRoot()
    itemsRepo.upsertRootItem(rootId, rootName, source.id)
    if (rootSettings) {
      settingsRepo.mergeSettings(rootId, { folderSettings: {
        retrieveChildrenMetadata: !!rootSettings.retrieve_children_metadata,
        childrenTypeHint: rootSettings.children_type_hint ?? null,
        processTvChildren: rootSettings.process_tv_children !== false,
      } })
    }
  })
}
