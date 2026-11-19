export const SOURCE_PRIORITIES_SQL = `
CREATE TABLE IF NOT EXISTS media_source_priority (
  source_id TEXT PRIMARY KEY,
  priority INTEGER NOT NULL
);
`

export const ACCOUNT_EXCLUDED_LOCATIONS_SQL = `
CREATE TABLE IF NOT EXISTS account_excluded_locations (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES media_locations(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, location_id)
);
`

function selectMediaItems(options: { source?: string; account?: string } = {}): string {
  const locationConstraint = options.source
    ? `AND ml.source_id = ${options.source}`
    : options.account
      ? `AND NOT EXISTS (
        SELECT 1 FROM account_excluded_locations excluded
        WHERE excluded.account_id = ${options.account} AND excluded.location_id = ml.id
      )`
      : ''
  const parentId = options.source
    ? `COALESCE((
      SELECT parent.item_id FROM media_locations parent
      WHERE parent.source_id = sl.source_id AND parent.relative_path = CASE
        WHEN instr(sl.relative_path, '/') = 0 THEN '.'
        ELSE substr(sl.relative_path, 1, length(sl.relative_path) - length(sl.name) - 1)
      END AND parent.id != sl.id
    ), mi.parent_item_id)`
    : 'mi.parent_item_id'
  return `
SELECT
  mi.id,
  ${parentId} AS parent_id,
  CASE
    WHEN mi.is_virtual = 1 THEN 'virtual://' || mi.id
    ELSE sl.relative_path
  END AS path,
  mi.name,
  CASE
    WHEN mi.is_virtual = 1 THEN 'folder'
    WHEN mi.physical_kind IN ('file', 'folder') THEN COALESCE(sl.type, mi.physical_kind)
    ELSE COALESCE(sl.type, 'folder')
  END AS type,
  sl.source_id,
  sl.size,
  sl.mtime,
  sl.birthtime,
  sl.inode,
  sl.device_id,
  mi.entity_id,
  CASE WHEN mi.is_hidden = 1 OR COALESCE(sl.is_hidden, 0) = 1 THEN 1 ELSE 0 END AS is_hidden,
  COALESCE(sl.is_ignored, 0) AS is_ignored,
  CASE
    WHEN mi.is_virtual = 1 THEN mi.logical_missing
    WHEN sl.id IS NULL THEN 1
    WHEN COALESCE(sl.is_present, 0) = 0 THEN 1
    ELSE 0
  END AS is_missing,
  mi.is_virtual,
  mi.virtual_type,
  mi.filter_json,
  mi.owner_id,
  mi.created_at AS added_at,
  mi.physical_kind,
  mi.media_kind,
  mi.logical_missing,
  mi.preferred_location_id,
  sl.id AS selected_location_id,
  sl.location_fingerprint,
  sl.is_present AS location_is_present,
  sl.is_shadowed AS location_is_shadowed,
  sl.shadowed_by_location_id,
  sl.first_seen_at,
  sl.last_seen_at,
  sl.missing_since
FROM media_items mi
-- Select from this item's indexed locations. Ranking every location up front
-- would scan the entire library even for a single item or folder.
LEFT JOIN media_locations sl ON sl.id = (
  SELECT ml.id
  FROM media_locations ml
  JOIN media_items owner ON owner.id = ml.item_id
  LEFT JOIN media_source_priority sp ON sp.source_id = ml.source_id
  WHERE ml.item_id = mi.id ${locationConstraint}
  ORDER BY
    ml.is_present DESC,
    (ml.is_hidden OR ml.is_ignored),
    CASE WHEN ml.id = owner.preferred_location_id THEN 0 ELSE 1 END,
    sp.priority IS NULL,
    sp.priority,
    ml.is_shadowed,
    ml.last_seen_at DESC,
    ml.source_id COLLATE NOCASE,
    ml.relative_path COLLATE NOCASE,
    ml.id
  LIMIT 1
)
`
}

export const MEDIA_ITEMS_READ_MODEL_SQL =
  `CREATE VIEW IF NOT EXISTS media_items_read AS ${selectMediaItems()}`

export function withSourceLocations(query: string): string {
  return `WITH media_items_read AS (${selectMediaItems({ source: '?' })}) ${query}`
}

export function withAccountLocations(query: string, accountParameter: string): string {
  return `WITH media_items_read AS (${selectMediaItems({ account: accountParameter })}) ${query}`
}
