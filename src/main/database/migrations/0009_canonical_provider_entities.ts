import { columnExists, tableExists } from './sqlite-helpers'
import type { Migration } from './types'

export const migration: Migration = {
  version: 9,
  name: 'canonicalize TMDB movies and shows',
  up(db) {
    if (!tableExists(db, 'media_entities')) return
    for (const [column, type] of [['provider', 'TEXT'], ['provider_id', 'TEXT'], ['fetched_at', 'INTEGER']]) {
      if (!columnExists(db, 'media_entities', column)) {
        db.exec(`ALTER TABLE media_entities ADD COLUMN ${column} ${type}`)
      }
    }

    if (columnExists(db, 'media_entities', 'tmdb_id') && columnExists(db, 'media_entities', 'media_type')) {
      if (tableExists(db, 'entity_genres') && tableExists(db, 'genres')) {
        db.exec(`
          UPDATE media_item_metadata AS m SET genres_json = (
            SELECT json_group_array(g.name)
            FROM media_items i
            JOIN entity_genres eg ON eg.entity_id = i.entity_id
            JOIN genres g ON g.id = eg.genre_id
            WHERE i.id = m.item_id
          )
          WHERE genres_json IS NULL;
        `)
      }
      const byFreshness = columnExists(db, 'media_entities', 'last_refreshed_at')
        ? 'last_refreshed_at DESC, id'
        : 'id'
      const itemColumns = ['locked_fields_json', 'last_refreshed_at', 'version', 'poster_path', 'backdrop_path', 'logo_path']
        .filter((column) => columnExists(db, 'media_entities', column))
      const assignments = itemColumns.map((column) => `${column} = NULL`)
      if (itemColumns.includes('last_refreshed_at')) assignments.push('fetched_at = e.last_refreshed_at')
      db.exec(`
        CREATE TEMP TABLE canonical_provider_matches AS
        SELECT id, tmdb_id, media_type,
          first_value(id) OVER (PARTITION BY tmdb_id, media_type ORDER BY ${byFreshness}) AS canonical_id
        FROM media_entities
        WHERE tmdb_id > 0 AND media_type IN ('movie', 'tv') AND provider IS NULL;

        UPDATE media_entities AS e
        SET ${["provider = 'tmdb'", 'provider_id = CAST(e.tmdb_id AS TEXT)', ...assignments].join(', ')}
        WHERE e.id IN (SELECT canonical_id FROM canonical_provider_matches);

      `)
      if (db.prepare('SELECT 1 FROM canonical_provider_matches WHERE id IS NOT canonical_id LIMIT 1').get()) {
        db.exec(`
          UPDATE media_items AS i SET entity_id = m.canonical_id
          FROM canonical_provider_matches m
          WHERE i.entity_id = m.id AND m.id IS NOT m.canonical_id;
        `)
      }
      db.exec('DROP TABLE canonical_provider_matches')
    }

    if (columnExists(db, 'media_entities', 'media_type')) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_media_entities_provider_identity
        ON media_entities(provider, provider_id, media_type)
        WHERE provider IS NOT NULL AND provider_id IS NOT NULL;
      `)
    }
  }
}
