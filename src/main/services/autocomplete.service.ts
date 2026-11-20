import {
  getMetadataValueField, metadataSuggestionLookup,
  type BuiltinMetadataField, type LocalMediaField, type MetadataSuggestionLookup, type TmdbFilterField
} from '@shared/metadata-fields'
import { suggestLocalMediaValues } from '../database/repositories/local-media.repo'
import * as metadataRepo from '../database/repositories/metadata.repo'
import * as settingsService from './settings.service'
import type { AutocompleteSuggestions } from '@shared/types'
import { getCurrentAccountId } from '../request-context'
import { ensureUpToDate } from './account-filter.service'

const fuzzyFilterAndSort = (items: string[], query: string, limit: number): string[] => {
  const lowerQuery = query.toLowerCase().trim()
  if (!lowerQuery) return items.slice(0, limit)

  const results: { item: string; score: number }[] = []
  for (const item of items) {
    const lowerItem = item.toLowerCase()
    const index = lowerItem.indexOf(lowerQuery)
    if (index !== -1) {
      results.push({ item, score: index === 0 ? 0 : index + 1 })
    }
  }

  return results
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      return a.item.localeCompare(b.item)
    })
    .slice(0, limit)
    .map((r) => r.item)
}

function accountForSuggestions(): string | undefined {
  const accountId = getCurrentAccountId()
  if (accountId) ensureUpToDate(accountId)
  return accountId
}

const metadataLookups = {
  mediaType: (_field, query, limit) =>
    fuzzyFilterAndSort(metadataRepo.getDistinctMetadataValues('media_type').sort(), query, limit),
  genre: (_field, query, limit) =>
    fuzzyFilterAndSort(metadataRepo.getDistinctGenreNames().sort(), query, limit),
  year: (_field, query, limit) =>
    fuzzyFilterAndSort(metadataRepo.getDistinctMetadataValues('year').sort(), query, limit),
  person: (_field, query, limit) => searchPersons(query, limit),
  tmdb: (field, query, limit) =>
    metadataRepo.suggestTmdbValues(field as TmdbFilterField, query.trim(), limit, accountForSuggestions()),
  localMedia: (field, query, limit) =>
    suggestLocalMediaValues(field as LocalMediaField, query.trim(), limit, accountForSuggestions())
} satisfies Record<MetadataSuggestionLookup, (
  field: BuiltinMetadataField, query: string, limit: number
) => string[] | Promise<string[]>>

export const getAutocompleteValues = async (
  key: string,
  query: string = '',
  limit: number = 20
): Promise<string[]> => {
  const field = getMetadataValueField(key)
  if (field) {
    const lookup = metadataSuggestionLookup(field)
    return lookup ? metadataLookups[lookup](field, query, limit) : []
  }

  // Prefer a custom tag over a virtual tag with the same key.
  const tags = metadataRepo.getDistinctTagEntries('item_tags', key)
  const entries = tags.length ? tags : metadataRepo.getDistinctTagEntries('item_virtual_tags', key)
  const values = [...new Set(entries.map(({ value }) => value).filter(Boolean))].sort()
  return fuzzyFilterAndSort(values, query, limit)
}

export const getGroupByKeys = async () => {
  const settings = await settingsService.readSettings()

  const tagKeys = metadataRepo
    .getDistinctTagEntries('item_tags')
    .map((r) => r.key)

  return [
    'folder',
    'mediaType',
    'genre',
    'year',
    ...(settings.virtualTags?.map((vt) => `vt.${vt.name}`) ?? []),
    ...[...new Set(tagKeys)].sort().map((k) => `tags.${k}`)
  ]
}

export const getAutocompleteSuggestions = async (options?: {
  excludeHidden?: boolean
}): Promise<AutocompleteSuggestions> => {
  const settings = await settingsService.readSettings()

  const mediaTypes = metadataRepo.getDistinctMetadataValues('media_type')
  const genres = metadataRepo.getDistinctGenreNames()

  const tagEntries = metadataRepo.getDistinctTagEntries('item_tags')
  const virtualTagEntries = metadataRepo.getDistinctTagEntries('item_virtual_tags')

  const tags: Record<string, string[]> = {}
  for (const entry of tagEntries) {
    if (options?.excludeHidden && entry.key.startsWith('_')) continue
    if (!tags[entry.key]) tags[entry.key] = []
    if (entry.value) tags[entry.key].push(entry.value)
  }

  const virtualTags: Record<string, string[]> = {}
  for (const entry of virtualTagEntries) {
    if (options?.excludeHidden && entry.key.startsWith('_')) continue
    if (!virtualTags[entry.key]) virtualTags[entry.key] = []
    if (entry.value) virtualTags[entry.key].push(entry.value)
  }

  // Ensure all defined virtual tags are present in the keys, even if empty
  if (settings.virtualTags) {
    for (const vt of settings.virtualTags) {
      if (options?.excludeHidden && vt.name.startsWith('_')) continue
      if (!virtualTags[vt.name]) virtualTags[vt.name] = []
    }
  }

  // Sort and Deduplicate
  const sortUnique = (arr: any[]) =>
    Array.from(new Set(arr))
      .filter((v) => typeof v === 'string')
      .sort((a, b) => a.localeCompare(b))

  Object.keys(tags).forEach((k) => (tags[k] = sortUnique(tags[k])))
  Object.keys(virtualTags).forEach((k) => (virtualTags[k] = sortUnique(virtualTags[k])))

  return {
    mediaType: sortUnique(mediaTypes),
    genre: sortUnique(genres),
    person: null, // Signalling that person suggestions are server-side
    tags,
    virtualTags
  }
}

let personCache: string[] | null = null

export const searchPersons = async (query: string, limit: number = 20): Promise<string[]> => {
  if (!personCache) {
    personCache = metadataRepo.getDistinctPersonNames().sort()
  }

  return fuzzyFilterAndSort(personCache, query, limit)
}

export const invalidateCache = () => {
  personCache = null
}
