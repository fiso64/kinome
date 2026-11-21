import {
  DEFAULT_AUTOCOMPLETE_LIMIT, getMetadataValueField, metadataSuggestionLookup, type MetadataSuggestionLookup
} from '@shared/metadata-fields'
import * as suggestions from '../database/repositories/metadata-suggestions.repo'
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

const catalogLookups = {
  mediaType: (query, limit) =>
    fuzzyFilterAndSort(suggestions.getDistinctMetadataValues('media_type').sort(), query, limit),
  genre: (query, limit) =>
    fuzzyFilterAndSort(suggestions.getDistinctGenreNames().sort(), query, limit),
  year: (query, limit) =>
    fuzzyFilterAndSort(suggestions.getDistinctMetadataValues('year', query).sort(), query, limit),
  person: (query, limit) => searchPersons(query, limit)
} satisfies Record<Exclude<MetadataSuggestionLookup, 'stored'>, (
  query: string, limit: number
) => string[] | Promise<string[]>>

export const getAutocompleteValues = async (
  key: string,
  query: string = '',
  limit: number = DEFAULT_AUTOCOMPLETE_LIMIT
): Promise<string[]> => {
  const field = getMetadataValueField(key)
  if (field) {
    const lookup = metadataSuggestionLookup(field)
    if (lookup === 'stored') {
      return suggestions.suggestStoredMetadataValues(field, query.trim(), limit, accountForSuggestions())
    }
    return lookup ? catalogLookups[lookup](query, limit) : []
  }

  // Prefer a custom tag over a virtual tag with the same key.
  const tags = suggestions.getDistinctTagEntries('item_tags', key)
  const entries = tags.length ? tags : suggestions.getDistinctTagEntries('item_virtual_tags', key)
  const values = [...new Set(entries.map(({ value }) => value).filter(Boolean))].sort()
  return fuzzyFilterAndSort(values, query, limit)
}

export const getGroupByKeys = async () => {
  const settings = await settingsService.readSettings()

  const tagKeys = suggestions.getCustomTagKeys()

  return [
    'folder',
    'mediaType',
    'genre',
    'year',
    ...(settings.virtualTags?.map((vt) => `vt.${vt.name}`) ?? []),
    ...tagKeys.sort().map((key) => `tags.${key}`)
  ]
}

function sortedValues(values: string[]): string[] {
  return [...new Set(values)].filter((value) => typeof value === 'string').sort((a, b) => a.localeCompare(b))
}

function tagSuggestions(
  entries: { key: string; value: string }[],
  excludeHidden?: boolean,
  definedTags: readonly { name: string }[] = []
): Record<string, string[]> {
  const tags: Record<string, string[]> = Object.create(null)
  for (const { key, value } of entries) {
    if (excludeHidden && key.startsWith('_')) continue
    const values = tags[key] ??= []
    if (value) values.push(value)
  }
  for (const { name } of definedTags) {
    if (!excludeHidden || !name.startsWith('_')) tags[name] ??= []
  }
  for (const key of Object.keys(tags)) tags[key] = sortedValues(tags[key])
  return tags
}

export const getAutocompleteSuggestions = async (options?: {
  excludeHidden?: boolean
}): Promise<AutocompleteSuggestions> => {
  const settings = await settingsService.readSettings()
  const excludeHidden = options?.excludeHidden

  return {
    mediaType: sortedValues(suggestions.getDistinctMetadataValues('media_type')),
    genre: sortedValues(suggestions.getDistinctGenreNames()),
    person: null, // Person suggestions are fetched when requested.
    tags: tagSuggestions(suggestions.getDistinctTagEntries('item_tags'), excludeHidden),
    virtualTags: tagSuggestions(suggestions.getDistinctTagEntries('item_virtual_tags'), excludeHidden, settings.virtualTags)
  }
}

let personCache: string[] | null = null

export const searchPersons = async (query: string, limit: number = DEFAULT_AUTOCOMPLETE_LIMIT): Promise<string[]> => {
  if (!personCache) {
    personCache = suggestions.getDistinctPersonNames().sort()
  }

  return fuzzyFilterAndSort(personCache, query, limit)
}

export const invalidateCache = () => {
  personCache = null
}
