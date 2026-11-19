import { ENTITY_SCALAR_METADATA_FIELDS } from '@shared/metadata-fields'

export const EFFECTIVE_METADATA = 'media_item_metadata_read'

export const ITEM_METADATA_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS media_item_metadata (
    item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
    tmdb_id INTEGER,
    media_type TEXT,
    title TEXT,
    original_title TEXT,
    overview TEXT,
    release_date TEXT,
    year INTEGER,
    tmdb_runtime INTEGER,
    season_number INTEGER,
    episode_number REAL,
    poster_path TEXT,
    backdrop_path TEXT,
    logo_path TEXT,
    locked_fields_json TEXT,
    last_refreshed_at INTEGER,
    version INTEGER DEFAULT 0,
    genres_json TEXT
);
`
 
const numericColumns = new Set(['tmdb_id', 'year', 'tmdb_runtime', 'season_number', 'episode_number', 'last_refreshed_at', 'version'])
const fields = ENTITY_SCALAR_METADATA_FIELDS.map(({ column }) => {
  const value = `CASE WHEN m.item_id IS NULL THEN e.${column} ELSE m.${column} END`
  const expression = numericColumns.has(column) ? `CAST(${value} AS NUMERIC)` : value
  return `${expression} AS ${column}`
})

// Keep one row per item so readers can use an inner join. SQLite can then
// apply their item predicates before looking up item metadata and provider facts.
export const EFFECTIVE_METADATA_VIEW_SQL = `
CREATE VIEW IF NOT EXISTS ${EFFECTIVE_METADATA} AS
SELECT i.id AS item_id,
       CASE WHEN e.id IS NOT NULL OR m.item_id IS NOT NULL THEN i.id END AS metadata_item_id,
       e.id, e.parent_entity_id,
       ${fields.join(',\n       ')},
       COALESCE(m.genres_json, (
           SELECT json_group_array(g.name)
           FROM entity_genres eg JOIN genres g ON g.id = eg.genre_id
           WHERE eg.entity_id = e.id
       )) AS genres_json
FROM media_items i
LEFT JOIN media_entities e ON e.id = i.entity_id
LEFT JOIN media_item_metadata m ON m.item_id = i.id;
`

export const ITEM_METADATA_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS media_items_entities_media_kind_ai AFTER INSERT ON media_entities
BEGIN
  UPDATE media_items SET media_kind = new.media_type WHERE entity_id = new.id AND id NOT IN (SELECT item_id FROM media_item_metadata);
END;

CREATE TRIGGER IF NOT EXISTS media_items_entities_media_kind_au AFTER UPDATE OF media_type ON media_entities
BEGIN
  UPDATE media_items SET media_kind = new.media_type WHERE entity_id = new.id AND id NOT IN (SELECT item_id FROM media_item_metadata);
END;

CREATE TRIGGER IF NOT EXISTS media_items_fts_ai AFTER INSERT ON media_items BEGIN
  INSERT INTO media_items_fts (id, name, title, original_title, overview)
  VALUES (
    new.id,
    new.name,
    (SELECT title FROM media_item_metadata_read WHERE item_id = new.id),
    (SELECT original_title FROM media_item_metadata_read WHERE item_id = new.id),
    (SELECT overview FROM media_item_metadata_read WHERE item_id = new.id)
  );
END;

CREATE TRIGGER IF NOT EXISTS media_items_fts_ad AFTER DELETE ON media_items BEGIN
  DELETE FROM media_items_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS media_items_fts_au AFTER UPDATE OF name, entity_id ON media_items
FOR EACH ROW
WHEN (OLD.name IS NOT NEW.name OR OLD.entity_id IS NOT NEW.entity_id)
BEGIN
  UPDATE media_items_fts SET
    name = new.name,
    title = (SELECT title FROM media_item_metadata_read WHERE item_id = new.id),
    original_title = (SELECT original_title FROM media_item_metadata_read WHERE item_id = new.id),
    overview = (SELECT overview FROM media_item_metadata_read WHERE item_id = new.id)
  WHERE id = new.id;
END;

CREATE TRIGGER IF NOT EXISTS media_items_fts_entities_ai AFTER INSERT ON media_entities BEGIN
  UPDATE media_items_fts SET
    title = new.title,
    original_title = new.original_title,
    overview = new.overview
  WHERE id IN (SELECT id FROM media_items WHERE entity_id = new.id AND id NOT IN (SELECT item_id FROM media_item_metadata));
END;

CREATE TRIGGER IF NOT EXISTS media_items_fts_entities_au AFTER UPDATE OF title, original_title, overview ON media_entities
FOR EACH ROW
WHEN (
    OLD.title IS NOT NEW.title OR
    OLD.original_title IS NOT NEW.original_title OR
    OLD.overview IS NOT NEW.overview
)
BEGIN
  UPDATE media_items_fts SET
    title = new.title,
    original_title = new.original_title,
    overview = new.overview
  WHERE id IN (SELECT id FROM media_items WHERE entity_id = new.id AND id NOT IN (SELECT item_id FROM media_item_metadata));
END;

CREATE TRIGGER IF NOT EXISTS media_items_fts_entities_ad AFTER DELETE ON media_entities BEGIN
  UPDATE media_items_fts SET title = NULL, original_title = NULL, overview = NULL
  WHERE id IN (SELECT id FROM media_items WHERE entity_id = old.id AND id NOT IN (SELECT item_id FROM media_item_metadata));
END;

CREATE TRIGGER IF NOT EXISTS media_item_metadata_ai AFTER INSERT ON media_item_metadata BEGIN
  UPDATE media_items SET media_kind = new.media_type WHERE id = new.item_id;
  UPDATE media_items_fts SET title = new.title, original_title = new.original_title, overview = new.overview
  WHERE id = new.item_id;
END;

CREATE TRIGGER IF NOT EXISTS media_item_metadata_au
AFTER UPDATE OF media_type, title, original_title, overview ON media_item_metadata
WHEN old.media_type IS NOT new.media_type OR old.title IS NOT new.title
  OR old.original_title IS NOT new.original_title OR old.overview IS NOT new.overview
BEGIN
  UPDATE media_items SET media_kind = new.media_type WHERE id = new.item_id;
  UPDATE media_items_fts SET title = new.title, original_title = new.original_title, overview = new.overview
  WHERE id = new.item_id;
END;
`
