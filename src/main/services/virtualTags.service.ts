import * as metadataRepo from '../database/repositories/metadata.repo'
import type { VirtualTagConfig, VirtualTagCondition, LibraryItem, Settings } from '@shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [VirtualTags] ${message}`)
}

function escapeString(str: string): string {
  return str.replace(/'/g, "''")
}

function buildConditionSql(condition: VirtualTagCondition): string {
  let column = ''

  switch (condition.target) {
    case 'year':
      column = 'media_entities.year'
      break
    case 'title':
      column = 'media_entities.title'
      break
    case 'mediaType':
      column = 'media_entities.media_type'
      break
    case 'path':
      // Correlated subquery to get path from items table
      column = '(SELECT path FROM items WHERE entity_id = media_entities.id LIMIT 1)'
      break
    case 'genre':
      if (condition.operator === 'contains') {
        return `EXISTS (
          SELECT 1 FROM json_each(media_entities.genres_json) 
          WHERE value LIKE '%${escapeString(String(condition.value))}%'
        )`
      }
      // For equals/others on array, we check exact match in array
      return `EXISTS (
          SELECT 1 FROM json_each(media_entities.genres_json) 
          WHERE value = '${escapeString(String(condition.value))}'
        )`
    case 'tag':
      if (!condition.targetKey) return '0' // False
      column = `json_extract(media_entities.tags_json, '$.${escapeString(condition.targetKey)}')`
      break
    default:
      return '0'
  }

  const valStr = escapeString(String(condition.value))
  const valQuoted = `'${valStr}'`

  switch (condition.operator) {
    case 'equals':
      return `${column} = ${valQuoted}`
    case 'contains':
      return `${column} LIKE '%${valStr}%'`
    case 'greaterThan':
      return `CAST(${column} AS NUMERIC) > CAST(${valQuoted} AS NUMERIC)`
    case 'lessThan':
      return `CAST(${column} AS NUMERIC) < CAST(${valQuoted} AS NUMERIC)`
    default:
      return '0'
  }
}

function generateCaseSql(tag: VirtualTagConfig): string {
  const conditionsSql = tag.conditions
    .map((cond) => {
      const whenSql = buildConditionSql(cond)
      return `WHEN ${whenSql} THEN '${escapeString(cond.result)}'`
    })
    .join(' ')

  const defaultSql = tag.defaultResult ? `ELSE '${escapeString(tag.defaultResult)}'` : 'ELSE NULL'

  return `CASE ${conditionsSql} ${defaultSql} END`
}

/**
 * Applies virtual tags to the metadata table.
 * If itemIds is provided, only updates those items.
 */
export function applyVirtualTags(tags: VirtualTagConfig[] | undefined, itemIds?: string[]): void {
  if (!tags || tags.length === 0) {
    metadataRepo.clearVirtualTags(itemIds)
    return
  }

  // Build JSON object construction SQL
  const args: string[] = []
  for (const tag of tags) {
    args.push(`'${escapeString(tag.name)}'`)
    args.push(generateCaseSql(tag))
  }

  const jsonBuildSql = `json_object(${args.join(', ')})`

  try {
    const changes = metadataRepo.applyVirtualTagsUpdate(jsonBuildSql, itemIds)
    if (itemIds && itemIds.length > 0) {
      log(`Applied virtual tags to ${changes} metadata rows using SQL.`)
    } else {
      log(`Applied virtual tags to ${changes} metadata rows (full update) using SQL.`)
    }
  } catch (e) {
    console.error('[VirtualTags] Failed to apply tags SQL:', e)
  }
}

/**
 * Evaluates virtual tags for a single item in-memory.
 */
export function evaluateVirtualTagsForItem(
  item: LibraryItem,
  settings: Settings
): Record<string, string> {
  const result: Record<string, string> = {}
  if (!settings.virtualTags || settings.virtualTags.length === 0) return result
  if (!item.parentId) return result // Root items don't have virtual tags

  for (const tag of settings.virtualTags) {
    let matched = false
    for (const condition of tag.conditions) {
      if (evaluateCondition(item, condition)) {
        result[tag.name] = String(condition.result)
        matched = true
        break
      }
    }
    if (!matched && tag.defaultResult) {
      result[tag.name] = tag.defaultResult
    }
  }

  // if (Object.keys(result).length > 0) {
  //   log(`In-memory eval for "${item.name}": ${JSON.stringify(result)}`)
  // }

  return result
}

function evaluateCondition(item: LibraryItem, condition: VirtualTagCondition): boolean {
  let itemValue: any = undefined

  switch (condition.target) {
    case 'year':
      itemValue = item.year
      break
    case 'title':
      itemValue = item.title ?? item.name
      break
    case 'mediaType':
      itemValue = item.mediaType
      break
    case 'path':
      itemValue = item.path
      break
    case 'genre':
      if (Array.isArray(item.genres)) {
        if (condition.operator === 'contains') {
          return item.genres.some((g) =>
            String(g).toLowerCase().includes(String(condition.value).toLowerCase())
          )
        }
        return item.genres.some((g) => String(g) === String(condition.value))
      }
      return false
    case 'tag':
      if (condition.targetKey && item.tags) {
        itemValue = item.tags[condition.targetKey]
      }
      break
    default:
      return false
  }

  if (itemValue === undefined || itemValue === null) return false

  const valStr = String(condition.value)
  const itemStr = String(itemValue)

  switch (condition.operator) {
    case 'equals':
      return itemStr === valStr
    case 'contains':
      return itemStr.toLowerCase().includes(valStr.toLowerCase())
    case 'greaterThan':
      return Number(itemValue) > Number(condition.value)
    case 'lessThan':
      return Number(itemValue) < Number(condition.value)
    default:
      return false
  }
}
