/**
 * Server events for Jellyfin clients' sockets: LibraryChanged when items are
 * added, changed or removed, including titles an edit hid from the account, and UserDataChanged when an account's played,
 * progress or favourite state changes. Kinome's item notifications are
 * collected for a second and sent once, checked against each account's
 * visibility, so a scan does not flood clients.
 */
import type { LibraryItem } from '@shared/types'
import type { ITransport } from '../transport/transport.interface'
import { runWithAccount, runWithoutAccount } from '../request-context'
import { accountToJellyfinId, toJellyfinId } from './ids'
import { findItems, relate, toDto, type Item } from './items'
import type { JellyfinRequest } from './request'
import { connectedSockets, socketMessage } from './sessions'

const FLUSH_MS = 1000
// Clients refresh their views on any change, so a large batch is cut rather than listed in full.
const MAX_ITEMS = 500

let updated = new Set<string>()
let removed = new Set<string>()
let userData = new Map<string, Set<string>>()
let timer: ReturnType<typeof setTimeout> | undefined

function schedule() {
  timer ??= setTimeout(() => {
    flushEvents().catch((error) => console.error('[Jellyfin] Could not send server events', { error }))
  }, FLUSH_MS)
}

function add(target: Set<string>, ids: Iterable<string>) {
  for (const id of ids) if (target.size < MAX_ITEMS) target.add(id)
}

/** Records items whose library data changed for everyone. */
export function itemsChanged(ids: Iterable<string>): void {
  if (!connectedSockets().length) return
  add(updated, ids)
  schedule()
}

/** Records items whose played, progress or favourite state changed for one account. */
export function userDataChanged(accountId: string, ids: Iterable<string>): void {
  if (!connectedSockets().some((entry) => entry.session.accountId === accountId)) return
  const pending = userData.get(accountId) ?? new Set<string>()
  add(pending, ids)
  userData.set(accountId, pending)
  schedule()
}

export function itemRemoved(id: string): void {
  if (!connectedSockets().length) return
  add(removed, [id])
  schedule()
}

/** The titles Jellyfin clients know for changed items: a movie folder's files report as the movie. */
function titles(ids: string[]): Item[] {
  if (!ids.length) return []
  const items = findItems({ where: { id: ids } })
  const parents = [...new Set(items.flatMap((item) => !item.mediaType && item.parentId ? [item.parentId] : []))]
  const movies = parents.length ? findItems({ where: { id: parents, mediaKind: 'movie' } }) : []
  return [...new Map([...items.filter((item) => item.mediaType), ...movies].map((item) => [item.id, item])).values()]
}

/** Sends what has been collected. Runs a second after the first change, or at once in tests. */
export async function flushEvents(): Promise<void> {
  clearTimeout(timer)
  timer = undefined
  const [changedIds, removedIds, personal] = [[...updated], [...removed], userData]
  updated = new Set()
  removed = new Set()
  userData = new Map()
  const accounts = Map.groupBy(connectedSockets(), (entry) => entry.session.accountId)
  // An edit such as removing a tag can hide a title from an account. Clients drop it only when told it was removed.
  const changedTitles = changedIds.length ? runWithoutAccount(() => titles(changedIds)).map((item) => toJellyfinId(item.id)) : []
  for (const [accountId, entries] of accounts) {
    const session = entries[0].session
    const request = { session } as JellyfinRequest
    const messages = await runWithAccount(accountId, async () => {
      const out: string[] = []
      const visible = titles(changedIds).map((item) => toJellyfinId(item.id))
      const shown = new Set(visible)
      const gone = [...removedIds.map(toJellyfinId), ...changedTitles.filter((id) => !shown.has(id))]
      if (visible.length || gone.length) {
        out.push(socketMessage('LibraryChanged', {
          ItemsAdded: [], ItemsUpdated: visible, ItemsRemoved: gone,
          FoldersAddedTo: [], FoldersRemovedFrom: [], CollectionFolders: [], IsEmpty: false
        }))
      }
      const own = titles([...personal.get(accountId) ?? []])
      if (own.length) {
        const related = await relate(own, request, { progress: true })
        const list = own.map((item) => toDto(item, related, { fields: new Set(), userData: true }).UserData)
        out.push(socketMessage('UserDataChanged', { UserId: accountToJellyfinId(accountId), UserDataList: list }))
      }
      return out
    })
    for (const text of messages) for (const { socket } of entries) socket.send(text)
  }
}

/** Passes Kinome's item notifications to Jellyfin clients as well. */
export function withJellyfinEvents(transport: ITransport): ITransport {
  return new Proxy(transport, {
    get(target, property, receiver) {
      if (property === 'notifyLibraryItemsUpdated') {
        return (items: LibraryItem[], accountId?: string) => {
          target.notifyLibraryItemsUpdated(items, accountId)
          const ids = items.map((item) => item.id)
          if (accountId) userDataChanged(accountId, ids)
          else itemsChanged(ids)
        }
      }
      if (property === 'notifyLibraryItemDeleted') {
        return (id: string) => {
          target.notifyLibraryItemDeleted(id)
          itemRemoved(id)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
