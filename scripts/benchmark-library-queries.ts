// Run separately from bun test: bun scripts/benchmark-library-queries.ts [item count]
import { Database } from 'bun:sqlite'
import { _clearDbForTesting, _setDbForTesting } from '../src/main/database/client'
import { runMigrations } from '../src/main/database/migrations'
import { replaceVirtualTags } from '../src/main/database/repositories/metadata.repo'
import { findByFtsQuery, findByShortQuery, findByTagsOnly } from '../src/main/database/repositories/search.repo'
import { SCHEMA_SQL } from '../src/main/database/schema'
import { runWithAccount } from '../src/main/request-context'
import { ensureUpToDate } from '../src/main/services/account-filter.service'
import { getAutocompleteValues } from '../src/main/services/autocomplete.service'
import type { VirtualTagConfig } from '../src/shared/types'

const items = Number(process.argv[2] ?? 100_000)
if (!Number.isSafeInteger(items) || items < 1) throw new Error('Item count must be a positive integer')

const db = new Database(':memory:')
_setDbForTesting(db)

try {
  db.exec(SCHEMA_SQL)
  runMigrations(db)
  db.exec('CREATE TEMP TABLE numbers (n INTEGER PRIMARY KEY)')
  db.query(`
    INSERT INTO numbers WITH RECURSIVE sequence(n) AS (
      VALUES (1) UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
    ) SELECT n FROM sequence
  `).run(items)
  db.transaction(() => db.exec(`
    INSERT INTO accounts (id, username, password_hash, created_at)
    VALUES ('viewer', 'viewer', 'unused', 1);

    INSERT INTO media_entities (id, media_type, title, year, tmdb_original_language)
    SELECT 'entity:' || n, 'movie',
      CASE WHEN n = 1 THEN 'Rare Beacon' ELSE 'Feature ' || n END,
      1960 + n % 60, CASE WHEN n % 8 = 0 THEN 'ja' ELSE 'en' END
    FROM numbers;

    INSERT INTO media_items (id, physical_kind, name, created_at, updated_at)
    VALUES ('root', 'folder', 'Library', 1, 1);

    INSERT INTO media_items (id, parent_item_id, physical_kind, media_kind, name, entity_id, created_at, updated_at)
    SELECT 'item:' || n, 'root', 'file', 'movie', n || '.mkv', 'entity:' || n, 1, 1 FROM numbers;

    INSERT INTO media_locations (id, item_id, source_id, relative_path, name, type, first_seen_at, last_seen_at)
    SELECT 'file:' || n, 'item:' || n, 'source', n || '.mkv', n || '.mkv', 'file', 1, 1 FROM numbers;

    INSERT INTO local_media (location_id, container, video_height, failures)
    SELECT 'file:' || n, CASE WHEN n % 10 = 0 THEN 'mp4' ELSE 'matroska' END,
      CASE WHEN n = 2 THEN 4320 WHEN n % 7 = 0 THEN 2160 ELSE 1080 END, 0 FROM numbers;

    INSERT INTO local_media_tracks (location_id, stream_index, kind, codec, language, is_default, forced, hearing_impaired)
    SELECT 'file:' || n, 0, 'audio', 'aac', CASE WHEN n % 8 = 0 THEN 'jpn' ELSE 'eng' END, 1, 0, 0 FROM numbers;

    INSERT INTO tmdb_entity_values (entity_id, field, value)
    SELECT 'entity:' || n, 'studios', 'Studio ' || (n % 2500) FROM numbers;
    INSERT INTO tmdb_entity_values (entity_id, field, value)
    SELECT 'entity:' || n, 'studios', 'Common Studio ' || (n % 10) FROM numbers;

    INSERT INTO item_tags (item_id, key, value)
    SELECT 'item:' || n, 'edition', 'Standard' FROM numbers;

    INSERT INTO people (id, name)
    SELECT n, CASE WHEN n = 1 THEN 'Rare Person' ELSE 'Cast Member ' || n END
    FROM numbers WHERE n <= 10000;

    INSERT INTO credits (entity_id, person_id, credit_type)
    SELECT 'entity:' || n, (n - 1) % 10000 + 1, 'cast' FROM numbers;

    INSERT INTO item_virtual_tags (item_id, key, value)
    VALUES ('item:1', 'spotlight', 'Featured');

    INSERT INTO account_filter_rules (account_id, mode, filter_json)
    VALUES ('viewer', 'allow', '{"conditions":[{"field":"year","op":"eq","value":"2000"}]}');
  `))()
  ensureUpToDate('viewer')

  const container = [{ key: 'file.container', value: 'matroska' }]
  const virtualTag: VirtualTagConfig = {
    id: 'container',
    name: 'container',
    cases: [{ filter: { conditions: [{ field: 'file.container', op: 'eq', value: 'matroska' }] }, result: 'MKV' }]
  }
  const restricted = (field: string) => runWithAccount('viewer', () => getAutocompleteValues(field))
  const measurements = [
    ['Container suggestions', () => getAutocompleteValues('file.container')],
    ['Restricted track suggestions', () => restricted('file.audioLanguage')],
    ['Restricted studio suggestions', () => restricted('tmdb.studios')],
    ['Media type suggestions', () => getAutocompleteValues('mediaType')],
    ['Year suggestions', () => getAutocompleteValues('year')],
    ['Year suggestions with no match', () => getAutocompleteValues('year', '202')],
    ['Selective text and file search', () => findByFtsQuery('"Rare Beacon"', container, 50)],
    ['Broad text and file search', () => findByFtsQuery('Feature', container, 50)],
    ['Broad text with rare file match', () => findByFtsQuery('Feature', [{ key: 'file.videoHeight', value: '4320' }], 50)],
    ['Broad text with no file match', () => findByFtsQuery('Feature', [{ key: 'file.videoHeight', value: '1' }], 50)],
    ['Short text search', () => findByShortQuery('Ra', [], 50)],
    ['File tag search', () => findByTagsOnly(container, 50)],
    ['Person tag search', () => findByTagsOnly([{ key: 'person', value: 'Rare Person' }], 50)],
    ['Virtual tag search', () => findByTagsOnly([{ key: 'spotlight', value: 'Featured' }], 50)],
    ['One-item virtual tag evaluation', () => replaceVirtualTags([virtualTag], ['item:1'])],
    ['Initial full virtual tag evaluation', () => replaceVirtualTags([virtualTag]),
      () => db.exec('DELETE FROM item_virtual_tags')],
    ['Unchanged full virtual tag evaluation', () => replaceVirtualTags([virtualTag])]
  ] as const
  const results = []
  for (const [query, run, prepare] of measurements) {
    const samples = []
    let count = 0
    for (let pass = 0; pass < 3; pass++) {
      if (prepare) prepare()
      const start = performance.now()
      const result = await run()
      samples.push(performance.now() - start)
      count = typeof result === 'number' ? result : result.length
    }
    samples.sort((a, b) => a - b)
    results.push({ query, 'median ms': Number(samples[1].toFixed(2)), 'results or writes': count })
  }
  console.log(`Library items: ${items.toLocaleString()}`)
  console.table(results)
} finally {
  _clearDbForTesting()
  db.close()
}
