import { getDb } from '../database/client'
import type {
  VirtualTagConfig,
  VirtualTagCondition,
  LibraryItem,
  Settings
} from '../../shared/types'

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
      column = 'metadata.year'
      break
    case 'title':
      column = 'metadata.title'
      break
    case 'mediaType':
      column = 'metadata.media_type'
      break
    case 'path':
      // Correlated subquery to get path from items table
      column = '(SELECT path FROM items WHERE id = metadata.item_id)'
      break
    case 'genre':
      if (condition.operator === 'contains') {
        return `EXISTS (
          SELECT 1 FROM json_each(metadata.genres_json) 
          WHERE value LIKE '%${escapeString(String(condition.value))}%'
        )`
      }
      // For equals/others on array, we check exact match in array
      return `EXISTS (
          SELECT 1 FROM json_each(metadata.genres_json) 
          WHERE value = '${escapeString(String(condition.value))}'
        )`
    case 'tag':
      if (!condition.targetKey) return '0' // False
      column = `json_extract(metadata.tags_json, '$.${escapeString(condition.targetKey)}')`
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
  const db = getDb()

  if (!tags || tags.length === 0) {
    // Clear all virtual tags
    if (itemIds && itemIds.length > 0) {
      const placeholders = itemIds.map(() => '?').join(',')
      db.prepare(
        `UPDATE metadata SET virtual_tags_json = '{}' WHERE item_id IN (${placeholders})`
      ).run(itemIds)
    } else {
      db.prepare(`UPDATE metadata SET virtual_tags_json = '{}'`).run()
    }
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
    // Ensure every item from the items table has a row in metadata table first.
    // This allows virtual tags to be persisted even if no other metadata exists.
    if (itemIds && itemIds.length > 0) {
      db.prepare(
        `INSERT OR IGNORE INTO metadata (item_id) VALUES ${itemIds.map(() => '(?)').join(',')}`
      ).run(itemIds)
    } else {
      db.prepare(`INSERT OR IGNORE INTO metadata (item_id) SELECT id FROM items`).run()
    }

    let sql = `UPDATE metadata SET virtual_tags_json = ${jsonBuildSql}`

    if (itemIds && itemIds.length > 0) {
      const placeholders = itemIds.map(() => '?').join(',')
      sql += ` WHERE item_id IN (${placeholders})`
      const info = db.prepare(sql).run(itemIds)
      log(`Applied virtual tags to ${info.changes} metadata rows using SQL.`)
    } else {
      // Full update
      const info = db.prepare(sql).run()
      log(`Applied virtual tags to ${info.changes} metadata rows (full update) using SQL.`)
    }

    // log(`Applied ${tags.length} virtual tags to ${itemIds ? itemIds.length : 'all'} items.`)
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

  if (Object.keys(result).length > 0) {
    log(`In-memory eval for "${item.name}": ${JSON.stringify(result)}`)
  }

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
