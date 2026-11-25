/**
 * Jellyfin IDs are GUIDs written as 32 hex digits. Kinome item IDs are UUIDs or
 * 64-digit hashes. A UUID is presented without dashes and a hash by its first
 * 32 digits, which find the item again through a primary-key range scan.
 */
import { createHash } from 'node:crypto'
import * as repositoryService from '../services/repository.service'
import * as accountRepo from '../database/repositories/account.repo'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
// Objects without a Kinome item carry a reserved prefix and their kind.
const SYNTHETIC = 'ffffffff'
const enum Kind { Library = '01', Person = '02', Root = '03' }

function synthetic(kind: Kind, payload: string): string {
  return SYNTHETIC + kind + payload.padStart(22, '0')
}

function digest(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

export const ROOT_ID = synthetic(Kind.Root, '0')
export const LIBRARIES = {
  movies: { id: synthetic(Kind.Library, '1'), name: 'Movies', mediaType: 'movie' },
  tvshows: { id: synthetic(Kind.Library, '2'), name: 'TV Shows', mediaType: 'tv' }
} as const
export type LibraryKey = keyof typeof LIBRARIES
/** The views that list collections and playlists, shown while any exist. */
export const COLLECTIONS_ID = synthetic(Kind.Library, '3')
export const PLAYLISTS_ID = synthetic(Kind.Library, '4')

/** Accepts the 32-digit and the dashed GUID forms. */
export function normalizeId(value: string | undefined): string | undefined {
  const id = value?.toLowerCase().replaceAll('-', '')
  return id && /^[0-9a-f]{32}$/.test(id) ? id : undefined
}

export function toJellyfinId(itemId: string): string {
  if (UUID.test(itemId)) return itemId.replaceAll('-', '')
  if (HASH.test(itemId)) return itemId.slice(0, 32)
  return digest(`item:${itemId}`)
}

export function libraryFor(id: string | undefined): LibraryKey | undefined {
  return (Object.keys(LIBRARIES) as LibraryKey[]).find((key) => LIBRARIES[key].id === id)
}

export function personToJellyfinId(tmdbPersonId: number): string {
  return synthetic(Kind.Person, tmdbPersonId.toString(16))
}

export function personFromJellyfinId(id: string | undefined): number | undefined {
  if (!id?.startsWith(SYNTHETIC + Kind.Person)) return undefined
  const value = parseInt(id.slice(SYNTHETIC.length + 2), 16)
  return Number.isSafeInteger(value) ? value : undefined
}

export function genreToJellyfinId(name: string): string {
  return digest(`genre:${name.toLowerCase()}`)
}

/** Resolves a presented item ID. Reserved and unknown IDs resolve to nothing. */
export function resolveItemId(value: string | undefined): string | undefined {
  const id = normalizeId(value)
  if (!id || id.startsWith(SYNTHETIC)) return undefined
  return repositoryService.findItemIdByHexPrefix(id) ?? undefined
}

export function accountToJellyfinId(accountId: string): string {
  return UUID.test(accountId) ? accountId.replaceAll('-', '') : digest(`account:${accountId}`)
}

/** Kinome has few accounts, so the reverse lookup compares the presented form of each. */
export function resolveAccountId(value: string | undefined): string | undefined {
  const id = normalizeId(value)
  if (!id) return undefined
  return accountRepo.getAllAccounts().find((account) => accountToJellyfinId(account.id) === id)?.id
}
