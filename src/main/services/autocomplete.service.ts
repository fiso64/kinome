import * as metadataRepo from '../database/repositories/metadata.repo'
import * as settingsRepo from '../database/repositories/settings.repo'
import * as settingsService from './settings.service'
import type { AutocompleteSuggestions } from '@shared/types'
import * as repositoryService from './repository.service'

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

export const getAutocompleteValues = async (
  key: string,
  query: string = '',
  limit: number = 20
): Promise<string[]> => {
  // Specialized high-performance path for persons
  if (key === 'person') {
    return searchPersons(query, limit)
  }

  let values: string[] = []

  if (key === 'mediaType') {
    values = metadataRepo.getDistinctMetadataValues('media_type')
  } else if (key === 'genre') {
    values = metadataRepo.getDistinctGenreNames()
  } else if (key === 'year') {
    values = metadataRepo.getDistinctMetadataValues('year')
  } else {
    // Check tags first, then virtual tags
    const tagMatch = metadataRepo.getDistinctTagEntries('entity_tags', key)

    if (tagMatch.length > 0) {
      values = tagMatch.map((r: any) => r.value)
    } else {
      values = metadataRepo
        .getDistinctTagEntries('entity_virtual_tags', key)
        .map((r: any) => r.value)
    }
  }

  const uniqueValues = Array.from(new Set(values.filter(Boolean))).sort()
  return fuzzyFilterAndSort(uniqueValues, query, limit)
}

export const getGroupByKeys = async () => {
  const settings = await settingsService.readSettings()

  const tagKeys = metadataRepo
    .getDistinctTagEntries('entity_tags')
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

export const getAutocompleteSuggestions = async (): Promise<AutocompleteSuggestions> => {
  const settings = await settingsService.readSettings()

  const mediaTypes = metadataRepo.getDistinctMetadataValues('media_type')
  const genres = metadataRepo.getDistinctGenreNames()

  const tagEntries = metadataRepo.getDistinctTagEntries('entity_tags')
  const virtualTagEntries = metadataRepo.getDistinctTagEntries('entity_virtual_tags')

  const tags: Record<string, string[]> = {}
  for (const entry of tagEntries) {
    if (!tags[entry.key]) tags[entry.key] = []
    if (entry.value) tags[entry.key].push(entry.value)
  }

  const virtualTags: Record<string, string[]> = {}
  for (const entry of virtualTagEntries) {
    if (!virtualTags[entry.key]) virtualTags[entry.key] = []
    if (entry.value) virtualTags[entry.key].push(entry.value)
  }

  // Ensure all defined virtual tags are present in the keys, even if empty
  if (settings.virtualTags) {
    for (const vt of settings.virtualTags) {
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
