import { getDb } from '../client'

export interface MediaItemRow {
  id: string
  parent_item_id: string | null
  physical_kind: 'file' | 'folder' | 'virtual'
  media_kind: string | null
  name: string
  entity_id: string | null
  is_virtual: number
  virtual_type: string | null
  filter_json: string | null
  owner_id: string | null
  is_hidden: number
  logical_missing: number
  preferred_location_id: string | null
  created_at: number
  updated_at: number
}

export function fetchMediaItemById(id: string): MediaItemRow | null {
  const db = getDb()
  return (db.prepare('SELECT * FROM media_items WHERE id = ?').get(id) as MediaItemRow | undefined) ?? null
}

export function fetchMediaChildren(parentItemId: string): MediaItemRow[] {
  const db = getDb()
  return db
    .prepare('SELECT * FROM media_items WHERE parent_item_id = ? ORDER BY name COLLATE NOCASE')
    .all(parentItemId) as MediaItemRow[]
}

export function mediaItemExists(id: string): boolean {
  const db = getDb()
  return !!db.prepare('SELECT 1 FROM media_items WHERE id = ?').get(id)
}
