import * as metadataRepo from '../database/repositories/metadata.repo'
import type { VirtualTagConfig, VirtualTagCondition, LibraryItem, Settings } from '@shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [VirtualTags] ${message}`)
}

/**
 * Applies virtual tags by evaluating SQL CASE expressions against media_entities
 * and writing results to the entity_virtual_tags table.
 */
export function applyVirtualTags(tags: VirtualTagConfig[] | undefined, itemIds?: string[]): void {
  if (!tags || tags.length === 0) {
    metadataRepo.clearVirtualTags(itemIds)
    return
  }

  metadataRepo.clearVirtualTags(itemIds)

  try {
    const totalInserted = metadataRepo.evaluateAndInsertVirtualTags(tags, itemIds)

    if (itemIds && itemIds.length > 0) {
      log(`Applied virtual tags: ${totalInserted} entries for ${itemIds.length} items.`)
    } else {
      log(`Applied virtual tags: ${totalInserted} entries (full update).`)
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
