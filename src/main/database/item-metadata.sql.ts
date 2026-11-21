import { BUILTIN_METADATA_FIELDS, ENTITY_SCALAR_METADATA_FIELDS, TMDB_FILTER_KEYS, type TmdbFilterField } from '@shared/metadata-fields'

export const EFFECTIVE_METADATA = 'media_item_metadata_read'
export const EFFECTIVE_SUGGESTION_COLUMNS = ['media_type', 'year'] as const

export function effectiveSuggestionIndexSql(column: typeof EFFECTIVE_SUGGESTION_COLUMNS[number]): string {
  return `CREATE INDEX IF NOT EXISTS idx_media_entities_${column} ON media_entities(${column}) WHERE ${column} IS NOT NULL`
}

export const TMDB_SCALAR_FIELDS = TMDB_FILTER_KEYS
  .filter((field) => BUILTIN_METADATA_FIELDS[field].kind !== 'list')
export const TMDB_LIST_FIELDS = TMDB_FILTER_KEYS
  .filter((field) => BUILTIN_METADATA_FIELDS[field].kind === 'list')

export function tmdbColumn(field: TmdbFilterField): string {
  return `tmdb_${field.replace(/^tmdb/, '').replace(/^./, (letter) => letter.toLowerCase()).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`
}

export const TMDB_COLUMNS = [
  ['tmdb_display_json', 'TEXT'],
  ...TMDB_SCALAR_FIELDS.map((field) => [
    tmdbColumn(field),
    BUILTIN_METADATA_FIELDS[field].kind === 'number' ? (field === 'tmdbRating' ? 'REAL' : 'INTEGER') : 'TEXT COLLATE NOCASE'
  ])
]

export const TMDB_RELATIONS_SQL = `
CREATE TABLE IF NOT EXISTS tmdb_entity_values (
    entity_id TEXT NOT NULL REFERENCES media_entities(id) ON DELETE CASCADE,
    field TEXT NOT NULL,
    value TEXT COLLATE NOCASE NOT NULL,
    PRIMARY KEY (entity_id, field, value)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_tmdb_entity_values_value
    ON tmdb_entity_values(field, value, entity_id);
`

// Project the provider object only when an item detail query requests it.
const tmdbProjection = `
    CASE WHEN e.tmdb_display_json IS NOT NULL THEN
      json_patch(e.tmdb_display_json, json_object(
        ${TMDB_SCALAR_FIELDS.map((field) => `'${field}', e.${tmdbColumn(field)}`).join(',\n        ')},
        ${TMDB_LIST_FIELDS.map((field) => `'${field}', (
          SELECT json_group_array(value)
          FROM tmdb_entity_values
          WHERE entity_id = e.id AND field = '${field}'
        )`).join(',\n        ')}
      ))
    END AS tmdb_metadata_json`

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
    genres_json TEXT,
    file_change_revision TEXT
);
`
 
const numericColumns = new Set(['tmdb_id', 'year', 'tmdb_runtime', 'season_number', 'episode_number', 'last_refreshed_at', 'version'])
export function effectiveMetadataColumn(column: string): string {
  const value = `CASE WHEN m.item_id IS NULL THEN e.${column} ELSE m.${column} END`
  return numericColumns.has(column) ? `CAST(${value} AS NUMERIC)` : value
}

// The item is aliased as i, with e for provider data and m for overrides.
export const ITEM_METADATA_JOINS = `
LEFT JOIN media_entities e ON e.id = i.entity_id
LEFT JOIN media_item_metadata m ON m.item_id = i.id`

const fields = ENTITY_SCALAR_METADATA_FIELDS.map(({ column }) =>
  `${effectiveMetadataColumn(column)} AS ${column}`
)

// Keep one row per item so readers can use an inner join. SQLite can then
// apply their item predicates before looking up item metadata and provider facts.
export const EFFECTIVE_METADATA_VIEW_SQL = (includeTmdbMetadata = false) => `
CREATE VIEW IF NOT EXISTS ${EFFECTIVE_METADATA} AS
SELECT i.id AS item_id,
       CASE WHEN e.id IS NOT NULL OR m.item_id IS NOT NULL THEN i.id END AS metadata_item_id,
       e.id, e.parent_entity_id,${includeTmdbMetadata ? `
       e.tmdb_display_json,
       ${tmdbProjection},
       m.file_change_revision,` : ''}
       ${fields.join(',\n       ')},
       COALESCE(m.genres_json, (
           SELECT json_group_array(g.name)
           FROM entity_genres eg JOIN genres g ON g.id = eg.genre_id
           WHERE eg.entity_id = e.id
       )) AS genres_json
FROM media_items i
${ITEM_METADATA_JOINS};
`

export const FTS_TABLE = 'media_items_fts'
// FTS5 weights are positional. Define them in the same order as the columns.
const searchColumns = [
  { name: 'id', weight: 0.0, source: 'item', indexed: false, keyword: false },
  { name: 'title', weight: 10.0, source: 'metadata', indexed: true, keyword: true },
  { name: 'original_title', weight: 5.0, source: 'metadata', indexed: true, keyword: true },
  { name: 'name', weight: 1.0, source: 'item', indexed: true, keyword: true },
  { name: 'overview', weight: 0.1, source: 'metadata', indexed: true, keyword: false }
] as const

export const SEARCH_INDEX_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
    ${searchColumns.map(({ name, indexed }) => indexed ? name : `${name} UNINDEXED`).join(',\n    ')},
    tokenize = 'trigram'
);`
export const SEARCH_KEYWORD_COLUMNS = `{${searchColumns.filter(({ keyword }) => keyword).map(({ name }) => name).join(' ')}}`
export const SEARCH_RANK_WEIGHTS = searchColumns.map(({ weight }) => weight.toFixed(1)).join(', ')
export const SEARCH_DOCUMENT_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_items_search_document ON media_items(search_document_id)
`
const SEARCH_TEXT_COLUMNS = searchColumns.filter(({ source }) => source === 'metadata').map(({ name }) => name)
const SEARCH_TEXT_FIELDS = SEARCH_TEXT_COLUMNS.join(', ')
const SEARCH_TEXT_UPDATED = SEARCH_TEXT_COLUMNS.map((column) => `old.${column} IS NOT new.${column}`).join(' OR ')
const SEARCH_TEXT_ASSIGNMENTS = SEARCH_TEXT_COLUMNS.map((column) => `${column} = new.${column}`).join(', ')
const SEARCH_DOCUMENT_COLUMNS = `i.name, ${SEARCH_TEXT_COLUMNS.map(effectiveMetadataColumn).join(', ')}`
const SEARCH_DOCUMENT_SOURCE = `
FROM media_items i
${ITEM_METADATA_JOINS}
`
const SEARCH_DOCUMENT_SELECT = `
SELECT i.search_document_id, i.id, ${SEARCH_DOCUMENT_COLUMNS}
${SEARCH_DOCUMENT_SOURCE}
`

export const REBUILD_SEARCH_INDEX_SQL = `
DELETE FROM ${FTS_TABLE};
WITH missing AS MATERIALIZED (
    SELECT id, row_number() OVER () +
        (SELECT coalesce(max(search_document_id), 0) FROM media_items) AS document_id
    FROM media_items WHERE search_document_id IS NULL
)
UPDATE media_items SET search_document_id = missing.document_id FROM missing WHERE media_items.id = missing.id;
INSERT INTO ${FTS_TABLE} (rowid, id, name, ${SEARCH_TEXT_FIELDS})
${SEARCH_DOCUMENT_SELECT};
`

function searchDocumentsForEntity(entityId: string): string {
  return `SELECT i.search_document_id FROM media_items i
      WHERE i.entity_id = ${entityId}
        AND NOT EXISTS (SELECT 1 FROM media_item_metadata m WHERE m.item_id = i.id)`
}

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
  UPDATE media_items SET search_document_id = (
    SELECT coalesce(max(search_document_id), 0) + 1 FROM media_items
  ) WHERE id = new.id;
  INSERT INTO ${FTS_TABLE} (rowid, id, name, ${SEARCH_TEXT_FIELDS})
  ${SEARCH_DOCUMENT_SELECT} WHERE i.id = new.id;
END;

CREATE TRIGGER IF NOT EXISTS media_items_fts_ad AFTER DELETE ON media_items BEGIN
  DELETE FROM ${FTS_TABLE} WHERE rowid = old.search_document_id;
END;

CREATE TRIGGER IF NOT EXISTS media_items_fts_au AFTER UPDATE OF name, entity_id ON media_items
FOR EACH ROW
WHEN (OLD.name IS NOT NEW.name OR OLD.entity_id IS NOT NEW.entity_id)
BEGIN
  UPDATE ${FTS_TABLE}
  SET (name, ${SEARCH_TEXT_FIELDS}) = (
    SELECT ${SEARCH_DOCUMENT_COLUMNS}
    ${SEARCH_DOCUMENT_SOURCE} WHERE i.id = new.id
  ) WHERE rowid = new.search_document_id;
END;

CREATE TRIGGER IF NOT EXISTS media_items_fts_entities_ai AFTER INSERT ON media_entities BEGIN
  UPDATE ${FTS_TABLE} SET ${SEARCH_TEXT_ASSIGNMENTS}
  WHERE rowid IN (${searchDocumentsForEntity('new.id')});
END;

CREATE TRIGGER IF NOT EXISTS media_items_fts_entities_au AFTER UPDATE OF ${SEARCH_TEXT_FIELDS} ON media_entities
FOR EACH ROW
WHEN (${SEARCH_TEXT_UPDATED})
BEGIN
  UPDATE ${FTS_TABLE} SET ${SEARCH_TEXT_ASSIGNMENTS}
  WHERE rowid IN (${searchDocumentsForEntity('new.id')});
END;

CREATE TRIGGER IF NOT EXISTS media_items_fts_entities_ad AFTER DELETE ON media_entities BEGIN
  UPDATE ${FTS_TABLE} SET ${SEARCH_TEXT_COLUMNS.map(column => `${column} = NULL`).join(', ')}
  WHERE rowid IN (${searchDocumentsForEntity('old.id')});
END;

CREATE TRIGGER IF NOT EXISTS media_item_metadata_ai AFTER INSERT ON media_item_metadata BEGIN
  UPDATE media_items SET media_kind = new.media_type WHERE id = new.item_id;
  UPDATE ${FTS_TABLE} SET ${SEARCH_TEXT_ASSIGNMENTS}
  WHERE rowid = (SELECT search_document_id FROM media_items WHERE id = new.item_id);
END;

CREATE TRIGGER IF NOT EXISTS media_item_metadata_au
AFTER UPDATE OF media_type, ${SEARCH_TEXT_FIELDS} ON media_item_metadata
WHEN old.media_type IS NOT new.media_type OR ${SEARCH_TEXT_UPDATED}
BEGIN
  UPDATE media_items SET media_kind = new.media_type WHERE id = new.item_id;
  UPDATE ${FTS_TABLE} SET ${SEARCH_TEXT_ASSIGNMENTS}
  WHERE rowid = (SELECT search_document_id FROM media_items WHERE id = new.item_id);
END;
`
