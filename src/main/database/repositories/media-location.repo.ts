import { getDb } from '../client'
import { ITEM_READ_MODEL } from '../query-builder'

export interface MediaLocationRow {
  id: string
  item_id: string
  source_id: string
  relative_path: string
  name: string
  type: 'file' | 'folder'
  size: number | null
  mtime: number | null
  birthtime: number | null
  inode: number | null
  device_id: number | null
  location_fingerprint: string | null
  is_present: number
  is_ignored: number
  is_hidden: number
  is_shadowed: number
  shadowed_by_location_id: string | null
  first_seen_at: number
  last_seen_at: number
  missing_since: number | null
}

export interface ResolvedMediaLocation {
  id: string
  itemId: string
  sourceId: string
  relativePath: string
  name: string
  type: 'file' | 'folder'
  isPresent: boolean
  isIgnored: boolean
  isHidden: boolean
  isShadowed: boolean
}

export function migratedLocationIdForItem(itemId: string): string {
  return `location:${itemId}`
}

export function fetchLocationsForItem(itemId: string): MediaLocationRow[] {
  const db = getDb()
  return db
    .prepare(
      `
      SELECT *
      FROM media_locations
      WHERE item_id = ?
      ORDER BY is_present DESC, is_shadowed ASC, source_id ASC, relative_path ASC
    `
    )
    .all(itemId) as MediaLocationRow[]
}

export function fetchPresentLocationsForItem(itemId: string): MediaLocationRow[] {
  const db = getDb()
  return db
    .prepare(
      `
      SELECT *
      FROM media_locations
      WHERE item_id = ? AND is_present = 1
      ORDER BY is_shadowed ASC, source_id ASC, relative_path ASC
    `
    )
    .all(itemId) as MediaLocationRow[]
}

export function fetchLocationBySourcePath(
  sourceId: string,
  relativePath: string
): MediaLocationRow | null {
  const db = getDb()
  return (
    db
      .prepare('SELECT * FROM media_locations WHERE source_id = ? AND relative_path = ?')
      .get(sourceId, relativePath) as MediaLocationRow | undefined
  ) ?? null
}

export function resolveSelectedLocationForItem(
  itemId: string,
  options: { requirePresent?: boolean; type?: 'file' | 'folder'; userId?: string | null } = {}
): ResolvedMediaLocation | null {
  const db = getDb()
  const conditions = ['i.id = ?', 'i.selected_location_id IS NOT NULL', 'i.source_id IS NOT NULL']
  const params: any[] = [itemId]

  if (options.requirePresent) {
    conditions.push('i.location_is_present = 1')
  }

  if (options.type) {
    conditions.push('i.type = ?')
    params.push(options.type)
  }

  if (options.userId) {
    conditions.push(`(
      i.is_virtual = 1
      OR NOT EXISTS (SELECT 1 FROM account_filter_rules WHERE account_id = ?)
      OR EXISTS (SELECT 1 FROM account_visible_items WHERE account_id = ? AND item_id = i.id)
    )`)
    params.push(options.userId, options.userId)
  }

  const row = db
    .prepare(
      `
      SELECT
        i.selected_location_id AS id,
        i.id AS itemId,
        i.source_id AS sourceId,
        i.path AS relativePath,
        i.name,
        i.type,
        i.location_is_present AS isPresent,
        i.is_ignored AS isIgnored,
        i.is_hidden AS isHidden,
        i.location_is_shadowed AS isShadowed
      FROM ${ITEM_READ_MODEL} i
      WHERE ${conditions.join(' AND ')}
    `
    )
    .get(...params) as
    | {
        id: string
        itemId: string
        sourceId: string
        relativePath: string
        name: string
        type: 'file' | 'folder'
        isPresent: number | null
        isIgnored: number | null
        isHidden: number | null
        isShadowed: number | null
      }
    | undefined

  if (!row) return null
  return {
    id: row.id,
    itemId: row.itemId,
    sourceId: row.sourceId,
    relativePath: row.relativePath,
    name: row.name,
    type: row.type,
    isPresent: row.isPresent === 1,
    isIgnored: row.isIgnored === 1,
    isHidden: row.isHidden === 1,
    isShadowed: row.isShadowed === 1,
  }
}
