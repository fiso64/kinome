/**
 * Playlists are folders tagged jellyfin:playlist. A virtual folder plays in its
 * sort with its arranged items, as Kinome shows it; a real folder plays the
 * movies and episodes beneath it in path order. A folder whose filter is a
 * single tag condition can be edited from apps: adding an item sets that tag
 * on it, removing clears it, and a move arranges the item after its new
 * predecessor. Other playlists are read-only.
 */
import type { LibraryFilter, LibraryItem, StoredViewSettings } from '@shared/types'
import { placeAfter } from '@shared/sort-placement'
import * as libraryService from '../services/library.service'
import * as navigationService from '../services/navigation.service'
import * as repositoryService from '../services/repository.service'
import { toJellyfinId } from './ids'
import { ITEM_FIELDS, dtoOptions, findFolder, findItems, folderContents, getItem, isPresentable, relate, toDto, type Folder, type Item } from './items'
import { JellyfinError, forbidden, json, notFound, route, type JellyfinRequest } from './request'

function requirePlaylist(request: JellyfinRequest): Folder {
  const folder = findFolder(request, request.params.playlistId, 'playlist')
  if (!folder) throw notFound()
  return folder
}

/** The tag a playlist's filter matches, when it matches one tag and nothing else. */
function playlistTag(filter: LibraryFilter | null | undefined): { key: string; value: string } | undefined {
  if (!filter || filter.scope || filter.requiredConditions?.length) return undefined
  const groups = filter.conditionGroups ?? (filter.conditions ? [filter.conditions] : [])
  const condition = groups.length === 1 && groups[0].length === 1 ? groups[0][0] : undefined
  if (condition?.op !== 'eq' || !condition.field.startsWith('tags.') || condition.value === null || condition.value === undefined) return undefined
  return { key: condition.field.slice('tags.'.length), value: String(condition.value) }
}

function requireEditable(request: JellyfinRequest, folder: Folder) {
  const tag = playlistTag(folder.item.filter)
  if (!tag) throw new JellyfinError(403, 'This playlist follows a filter. Change it in Kinome.')
  if (!request.session!.capabilities.has('editMetadata')) throw forbidden()
  return tag
}

/** A virtual folder's children in its sort and arrangement, or the movies and episodes beneath a real folder in path order. */
async function entries(folder: Folder): Promise<Item[]> {
  if (!folder.item.isVirtual) {
    return findItems({ where: { mediaKind: ['movie', 'episode'] }, compiledConditions: folderContents(folder), orderBy: [{ field: 'path', direction: 'ASC' }] })
      .filter(isPresentable)
  }
  const children = await navigationService.getChildren(folder.item.id, { fields: ITEM_FIELDS })
  return Array.isArray(children) ? (children as Item[]).filter(isPresentable) : []
}

async function playlistItems(request: JellyfinRequest) {
  const all = await entries(requirePlaylist(request))
  const start = request.query.int('startIndex') ?? 0
  const limit = request.query.int('limit')
  const page = all.slice(start, limit === undefined ? undefined : start + limit)
  const related = await relate(page, request, { progress: true })
  const options = dtoOptions(request.query)
  // Each item is in a playlist once, so its ID names its entry too.
  const items = page.map((item) => ({ ...toDto(item, related, options), PlaylistItemId: toJellyfinId(item.id) }))
  return json(request, { Items: items, TotalRecordCount: all.length, StartIndex: start })
}

async function setTags(request: JellyfinRequest, ids: string[], update: (tags: Record<string, string>) => Record<string, string>) {
  for (const id of ids) {
    const item = getItem(id, ['tags'])
    if (!item || !isPresentable(item)) continue
    await libraryService.updateItem({ id: item.id, tags: update({ ...item.tags }) } as LibraryItem, true)
  }
}

async function addItems(request: JellyfinRequest) {
  const { key, value } = requireEditable(request, requirePlaylist(request))
  await setTags(request, request.query.list('ids'), (tags) => ({ ...tags, [key]: value }))
  return undefined
}

async function removeItems(request: JellyfinRequest) {
  const { key, value } = requireEditable(request, requirePlaylist(request))
  await setTags(request, request.query.list('entryIds'), (tags) => {
    if (tags[key] === value) delete tags[key]
    return tags
  })
  return undefined
}

async function moveItem(request: JellyfinRequest) {
  const folder = requirePlaylist(request)
  requireEditable(request, folder)
  const order = (await entries(folder)).map((item) => item.id)
  const moved = order.find((id) => toJellyfinId(id) === request.params.itemId.toLowerCase().replaceAll('-', ''))
  const index = Number(request.params.newIndex)
  if (!moved || !Number.isSafeInteger(index) || index < 0) throw notFound()
  const others = order.filter((id) => id !== moved)
  const settings = (repositoryService.find({ fields: ['id', 'viewSettings'], where: { id: folder.item.id } })[0]?.viewSettings ?? {}) as StoredViewSettings
  const placement = placeAfter({ top: settings.sortTop, bottom: settings.sortBottom, after: settings.sortAfter }, moved,
    index === 0 ? null : others[Math.min(index, others.length) - 1])
  await libraryService.updateItem({
    id: folder.item.id, viewSettings: { sortTop: placement.top, sortBottom: placement.bottom, sortAfter: placement.after }
  } as LibraryItem, true)
  return undefined
}

export const playlistRoutes = [
  route('GET', '/Playlists/{playlistId}', async (request) => json(request, {
    OpenAccess: false, Shares: [], ItemIds: (await entries(requirePlaylist(request))).map((item) => toJellyfinId(item.id))
  })),
  route('GET', '/Playlists/{playlistId}/Items', playlistItems),
  route('POST', '/Playlists/{playlistId}/Items', addItems),
  route('DELETE', '/Playlists/{playlistId}/Items', removeItems),
  route('POST', '/Playlists/{playlistId}/Items/{itemId}/Move/{newIndex}', moveItem),
  route('GET', '/Playlists/{playlistId}/Users', (request) => json(request, [])),
  route('POST', '/Playlists', () => {
    throw new JellyfinError(403, 'Create a virtual folder in Kinome and tag it jellyfin:playlist.')
  })
]
