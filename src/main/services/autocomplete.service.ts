import { getDb } from '../database/client'
import * as settingsService from './settings.service'
import type { AutocompleteSuggestions } from '@shared/types'

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

  const db = getDb()
  let values: string[] = []

  if (key === 'mediaType') {
    values = db
      .prepare('SELECT DISTINCT media_type FROM metadata WHERE media_type IS NOT NULL')
      .all()
      .map((r: any) => r.media_type)
  } else if (key === 'genre') {
    values = db
      .prepare(
        'SELECT DISTINCT value FROM metadata, json_each(genres_json) WHERE genres_json IS NOT NULL AND value IS NOT NULL'
      )
      .all()
      .map((r: any) => r.value)
  } else if (key === 'year') {
    values = db
      .prepare('SELECT DISTINCT year FROM metadata WHERE year IS NOT NULL')
      .all()
      .map((r: any) => r.year.toString())
  } else {
    // Check tags first, then virtual tags
    const tagMatch = db
      .prepare(
        'SELECT DISTINCT value FROM metadata, json_each(tags_json) WHERE key = ? AND tags_json IS NOT NULL'
      )
      .all(key)

    if (tagMatch.length > 0) {
      values = tagMatch.map((r: any) => r.value)
    } else {
      values = db
        .prepare(
          'SELECT DISTINCT value FROM metadata, json_each(virtual_tags_json) WHERE key = ? AND virtual_tags_json IS NOT NULL'
        )
        .all(key)
        .map((r: any) => r.value)
    }
  }

  const list = values.filter(Boolean).sort()
  return fuzzyFilterAndSort(list, query, limit)
}

export const getGroupByKeys = async () => {
  const settings = await settingsService.readSettings()
  const db = getDb()

  const tagKeys = db
    .prepare('SELECT DISTINCT key FROM metadata, json_each(tags_json) WHERE tags_json IS NOT NULL')
    .all()
    .map((r: any) => r.key)

  return [
    'folder',
    'mediaType',
    'genre',
    'year',
    ...(settings.virtualTags?.map((vt) => `vt.${vt.name}`) ?? []),
    ...tagKeys.sort().map((k) => `tags.${k}`)
  ]
}

export const getAutocompleteSuggestions = async (): Promise<AutocompleteSuggestions> => {
  const settings = await settingsService.readSettings()
  const db = getDb()

  const mediaTypes = db
    .prepare('SELECT DISTINCT media_type FROM metadata WHERE media_type IS NOT NULL')
    .all()
    .map((r: any) => r.media_type)

  const genres = db
    .prepare(
      'SELECT DISTINCT value FROM metadata, json_each(genres_json) WHERE genres_json IS NOT NULL AND value IS NOT NULL'
    )
    .all()
    .map((r: any) => r.value)

  const tagEntries = db
    .prepare(
      'SELECT DISTINCT key, value FROM metadata, json_each(tags_json) WHERE tags_json IS NOT NULL'
    )
    .all() as { key: string; value: string }[]

  const virtualTagEntries = db
    .prepare(
      'SELECT DISTINCT key, value FROM metadata, json_each(virtual_tags_json) WHERE virtual_tags_json IS NOT NULL'
    )
    .all() as { key: string; value: string }[]

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

  // Sort all arrays - Filter out any nulls/non-strings just in case
  const sort = (arr: any[]) =>
    arr.filter((v) => typeof v === 'string').sort((a, b) => a.localeCompare(b))

  Object.keys(tags).forEach((k) => (tags[k] = sort(tags[k])))
  Object.keys(virtualTags).forEach((k) => (virtualTags[k] = sort(virtualTags[k])))

  return {
    mediaType: sort(mediaTypes),
    genre: sort(genres),
    person: null, // Signalling that person suggestions are server-side
    tags,
    virtualTags
  }
}

let personCache: string[] | null = null

export const searchPersons = async (query: string, limit: number = 20): Promise<string[]> => {
  if (!personCache) {
    const db = getDb()

    // Extract distinct person names from both cast and crew JSON arrays
    const rows = db
      .prepare(
        `
      SELECT DISTINCT json_extract(c.value, '$.name') as name
      FROM metadata, json_each(people_json, '$.cast') as c
      WHERE people_json IS NOT NULL
      UNION
      SELECT DISTINCT json_extract(c.value, '$.name') as name
      FROM metadata, json_each(people_json, '$.crew') as c
      WHERE people_json IS NOT NULL
    `
      )
      .all() as { name: string }[]

    personCache = rows
      .map((r) => r.name)
      .filter(Boolean)
      .sort()
  }

  return fuzzyFilterAndSort(personCache, query, limit)
}

export const invalidateCache = () => {
  personCache = null
}
