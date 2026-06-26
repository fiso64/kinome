export const MEDIA_ITEMS_READ_MODEL_SQL = `
CREATE VIEW IF NOT EXISTS media_items_read AS
WITH ranked_locations AS (
  SELECT
    ml.*,
    row_number() OVER (
      PARTITION BY ml.item_id
      ORDER BY
        CASE WHEN mi.preferred_location_id IS NOT NULL AND ml.id = mi.preferred_location_id THEN 0 ELSE 1 END,
        CASE
          WHEN ml.is_present = 1 AND ml.is_shadowed = 0 THEN 0
          WHEN ml.is_present = 1 THEN 1
          ELSE 2
        END,
        ml.last_seen_at DESC,
        ml.source_id COLLATE NOCASE,
        ml.relative_path COLLATE NOCASE
    ) AS location_rank
  FROM media_locations ml
  JOIN media_items mi ON mi.id = ml.item_id
),
selected_locations AS (
  SELECT * FROM ranked_locations WHERE location_rank = 1
)
SELECT
  mi.id,
  mi.parent_item_id AS parent_id,
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
LEFT JOIN selected_locations sl ON sl.item_id = mi.id
`
