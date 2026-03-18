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

  // Normalize: conditionGroups takes precedence over legacy conditions
  const groups = filter.conditionGroups ?? (filter.conditions ? [filter.conditions] : [])

  // Empty groups = no constraints = match all
  if (groups.length === 0) return true

  // OR-of-AND: at least one group must fully match
  return groups.some(group => group.every(cond => matchesCondition(item, cond)))
}

/** Check if a value is "empty" — null, undefined, or empty string */
function isEmptyValue(v: any): boolean {
  return v === undefined || v === null || v === ''
}

// =================================================================
// Two-phase condition matching: resolve field value, then apply operator
// =================================================================

type ResolvedField =
  | { kind: 'scalar'; value: any }
  | { kind: 'array'; values: any[] }

/**
 * Phase 1: Extract the value for a field from the item.
 * Field-specific logic lives here (where to find the value, what shape it has).
 */
function resolveField(item: LibraryItem, field: string): ResolvedField {
  if (field === 'addedDaysAgo') {
    const days = Math.floor((Date.now() - ((item as any).addedAt ?? 0)) / 86400000)
    return { kind: 'scalar', value: days }
  }
  if (field === 'genre' || field === 'genres') {
    return { kind: 'array', values: Array.isArray(item.genres) ? item.genres : [] }
  }
  if (field.startsWith('tags.')) {
    return { kind: 'scalar', value: item.tags?.[field.slice(5)] }
  }
  if (field.startsWith('vt.') || field.startsWith('virtualTags.')) {
    return { kind: 'scalar', value: (item as any).virtualTags?.[field.split('.')[1]] }
  }
  const value = field === 'title' ? (item.title ?? item.name) : (item as any)[field]
  return { kind: 'scalar', value }
}

/**
 * Phase 2: Apply the operator against a resolved value.
 * Operator-specific logic lives here — no field-type branching.
 */
function applyOperator(resolved: ResolvedField, op: string, value: any): boolean {
  if (resolved.kind === 'array') {
    const empty = resolved.values.length === 0
    if (op === 'isNull' || op === 'isEmpty') return empty
    if (op === 'isNotNull' || op === 'isNotEmpty') return !empty
    if (empty) return false
    const target = String(value)
    if (op === 'contains') return resolved.values.some(v => String(v).toLowerCase().includes(target.toLowerCase()))
    if (op === 'eq') return resolved.values.some(v => String(v) === target)
    return false
  }

  // Scalar
  const itemValue = resolved.value
  if (op === 'isEmpty') return isEmptyValue(itemValue)
  if (op === 'isNotEmpty') return !isEmptyValue(itemValue)
  if (itemValue === undefined || itemValue === null) return op === 'isNull' || (op === 'eq' && value === null)
  if (op === 'isNull') return false
  if (op === 'isNotNull') return true
  return compareValues(itemValue, op, value)
}

function matchesCondition(item: LibraryItem, cond: LibraryCondition): boolean {
  return applyOperator(resolveField(item, cond.field), cond.op, cond.value)
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
