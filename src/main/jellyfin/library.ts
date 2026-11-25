/**
 * Library structure and change notifications for integrations such as Seerr,
 * Sonarr and Radarr.
 */
import path from 'node:path'
import * as libraryService from '../services/library.service'
import { userViews, views } from './items'
import { field, forbidden, json, route, type JellyfinRequest } from './request'

function requireScan(request: JellyfinRequest) {
  if (!request.session!.capabilities.has('triggerLibraryScan')) throw forbidden()
}

/**
 * Sonarr and Radarr report the paths this API gave them. Each path is scanned
 * on its own. A path that is gone scans its folder, and one outside the
 * media sources falls back to a full scan.
 */
async function mediaUpdated(request: JellyfinRequest) {
  requireScan(request)
  const updates = field<{ Path?: string; path?: string }[]>(await request.body(), 'Updates') ?? []
  const paths = [...new Set(updates.map((update) => update.Path ?? update.path).filter((value): value is string => !!value))]
  let full = paths.length === 0
  for (const changed of paths) {
    const scanned = await libraryService.performScan(undefined, { path: changed })
      .catch(() => libraryService.performScan(undefined, { path: path.dirname(changed) }))
      .catch((error) => {
        if (!(error instanceof libraryService.ScanScopeError)) throw error
        return undefined
      })
    if (!scanned) full = true
  }
  if (full) await libraryService.performScan()
  console.info('[Jellyfin] Library update requested', { client: request.device.client, paths: paths.length, fullScan: full })
  return undefined
}

async function refresh(request: JellyfinRequest) {
  requireScan(request)
  await libraryService.performScan()
  return undefined
}

export const libraryRoutes = [
  route('GET', '/Library/MediaFolders', userViews),
  route('GET', '/Library/VirtualFolders', (request) => json(request, views(request).filter((view) => view.type === 'movies' || view.type === 'tvshows').map((view) => ({
    Name: view.name, Locations: [], CollectionType: view.type, ItemId: view.id, RefreshStatus: 'Idle'
  })))),
  route('POST', '/Library/Media/Updated', mediaUpdated),
  route('POST', '/Library/Refresh', refresh),
]
