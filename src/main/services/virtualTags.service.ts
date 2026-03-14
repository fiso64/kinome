import * as metadataRepo from '../database/repositories/metadata.repo'
import type { LibraryFilter, LibraryCondition, LibraryItem, Settings, VirtualTagConfig } from '@shared/types'

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
 * Used during item updates to avoid an extra DB roundtrip for change detection.
 */
export function evaluateVirtualTagsForItem(
  item: LibraryItem,
  settings: Settings
): Record<string, string> {
  const result: Record<string, string> = {}
  if (!settings.virtualTags || settings.virtualTags.length === 0) return result
  if (!item.parentId) return result

  for (const tag of settings.virtualTags) {
    let matched = false
    for (const vtCase of tag.cases) {
      if (matchesFilter(item, vtCase.filter)) {
        result[tag.name] = vtCase.result
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

function matchesFilter(item: LibraryItem, filter: LibraryFilter): boolean {
  if (filter.scope?.parentId && item.parentId !== filter.scope.parentId) return false
  for (const cond of filter.conditions ?? []) {
    if (!matchesCondition(item, cond)) return false
  }
  return true
}

function matchesCondition(item: LibraryItem, cond: LibraryCondition): boolean {
  const { field, op, value } = cond

  // Computed field
  if (field === 'addedDaysAgo') {
    const days = Math.floor((Date.now() - ((item as any).addedAt ?? 0)) / 86400000)
    return compareValues(days, op, Number(value))
  }

  // Genre
  if (field === 'genre' || field === 'genres') {
    if (!Array.isArray(item.genres)) return false
    const target = String(value)
    if (op === 'contains') return item.genres.some((g) => String(g).toLowerCase().includes(target.toLowerCase()))
    if (op === 'eq') return item.genres.some((g) => String(g) === target)
    return false
  }

  // Manual tags
  if (field.startsWith('tags.')) {
    const itemValue = item.tags?.[field.slice(5)]
    return itemValue !== undefined && compareValues(itemValue, op, value)
  }

  // Virtual tags
  if (field.startsWith('vt.') || field.startsWith('virtualTags.')) {
    const key = field.split('.')[1]
    const itemValue = (item as any).virtualTags?.[key]
    return itemValue !== undefined && compareValues(itemValue, op, value)
  }

  // title falls back to name
  const itemValue = field === 'title'
    ? (item.title ?? item.name)
    : (item as any)[field]

  if (itemValue === undefined || itemValue === null) return op === 'eq' && value === null
  return compareValues(itemValue, op, value)
}

function compareValues(itemValue: any, op: string, value: any): boolean {
  switch (op) {
    case 'eq':       return String(itemValue) === String(value)
    case 'ne':       return String(itemValue) !== String(value)
    case 'contains': return String(itemValue).toLowerCase().includes(String(value).toLowerCase())
    case 'gt':       return Number(itemValue) > Number(value)
    case 'lt':       return Number(itemValue) < Number(value)
    default:         return false
  }
}
