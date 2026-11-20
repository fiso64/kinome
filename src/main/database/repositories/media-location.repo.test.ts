import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { _clearDbForTesting, _setDbForTesting } from '../client'
import { SCHEMA_SQL } from '../schema'
import { findProbeCandidates, saveProbeResult, suggestLocalMediaValues } from './local-media.repo'
import { findByFtsQuery, findByTagsOnly } from './search.repo'
import { evaluateAndInsertVirtualTags, upsertMetadata } from './metadata.repo'
import { buildFindQuery, compileFilter } from '../query-builder'
import { replaceSourcePriorities, resolveSelectedLocationForItem } from './media-location.repo'

let db: Database

describe('media location repository', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    db.exec(SCHEMA_SQL)
    _setDbForTesting(db)
  })

  afterEach(() => {
    _clearDbForTesting()
    db.close()
  })

  it('resolves the preferred selected location for an item', () => {
    db.exec(`
      INSERT INTO media_items (id, physical_kind, media_kind, name, created_at, updated_at)
      VALUES ('item-1', 'file', 'movie', 'Movie.mkv', 1000, 1000);

      INSERT INTO media_locations (
        id, item_id, source_id, relative_path, name, type,
        is_present, is_hidden, is_ignored, is_shadowed, first_seen_at, last_seen_at
      )
      VALUES
        ('loc-a', 'item-1', 'source-a', 'Movies/Movie.mkv', 'Movie.mkv', 'file', 1, 0, 0, 0, 1000, 1000),
        ('loc-b', 'item-1', 'source-b', 'Films/Movie.mkv', 'Movie.mkv', 'file', 1, 0, 0, 0, 1000, 900);

      UPDATE media_items SET preferred_location_id = 'loc-b' WHERE id = 'item-1';
    `)

    const location = resolveSelectedLocationForItem('item-1', { requirePresent: true })

    expect(location?.id).toBe('loc-b')
    expect(location?.sourceId).toBe('source-b')
    expect(location?.relativePath).toBe('Films/Movie.mkv')
    expect(location?.isPresent).toBe(true)

    replaceSourcePriorities(['source-b', 'source-a'])
    db.exec("UPDATE media_items SET preferred_location_id = NULL WHERE id = 'item-1'")
    expect(resolveSelectedLocationForItem('item-1', { requirePresent: true })?.id).toBe('loc-b')
    replaceSourcePriorities(['source-a', 'source-b'])
    expect(resolveSelectedLocationForItem('item-1', { requirePresent: true })?.id).toBe('loc-a')

    db.exec(`
      UPDATE media_items SET preferred_location_id = 'loc-a' WHERE id = 'item-1';
      UPDATE media_locations SET is_present = 0 WHERE id = 'loc-a';
    `)
    expect(resolveSelectedLocationForItem('item-1', { requirePresent: true })?.id).toBe('loc-b')
  })

  it('uses the selected copy’s probe results and invalidates them when the file changes', () => {
    db.exec(`
      INSERT INTO media_items (id, physical_kind, name, created_at, updated_at)
      VALUES ('film', 'file', 'Movie', 1, 1);
      INSERT INTO media_locations
        (id,item_id,source_id,relative_path,name,type,size,mtime,birthtime,inode,device_id,first_seen_at,last_seen_at)
      VALUES
        ('a','film','source-a','Movie.mkv','Movie.mkv','file',100,1000,500,1,1,1,1),
        ('b','film','source-b','Movie.mkv','Movie.mkv','file',200,1000,500,2,1,1,1);
    `)
    const candidates = findProbeCandidates(['source-a', 'source-b'], 2000)
    const [first, second] = candidates
    const media = { container: 'matroska', durationSeconds: 120, tracks: [{
      index: 2, kind: 'video' as const, codec: 'h264', height: 1080,
      default: true, forced: false, hearingImpaired: false
    }] }
    expect(saveProbeResult(first, media, null)).toBe(true)
    expect(saveProbeResult(second, { ...media, tracks: [{ ...media.tracks[0], codec: 'hevc', height: 2160 }] }, null)).toBe(true)
    expect(findProbeCandidates(['source-a', 'source-b'], 2000)).toEqual([])

    const query = buildFindQuery({ ...compileFilter({
      conditions: [{ field: 'file.videoHeight', op: 'gte', value: '2160' }]
    }), fields: ['id', 'localMedia'] })
    const filter = () => db.query(query.query).all(...query.params) as { id: string; localMedia: string }[]
    replaceSourcePriorities(['source-a', 'source-b'])
    expect(suggestLocalMediaValues('file.videoCodec', '', 20)).toEqual(['h264'])
    expect(filter()).toEqual([])
    expect(findByTagsOnly([{ key: 'file.videoCodec', value: 'h264' }], 10)).toHaveLength(1)
    replaceSourcePriorities(['source-b', 'source-a'])
    expect(suggestLocalMediaValues('file.videoCodec', 'he', 20)).toEqual(['hevc'])
    expect(suggestLocalMediaValues('file.videoHeight', '', 20)).toEqual(['2160'])
    expect(JSON.parse(filter()[0].localMedia).tracks[0]).toMatchObject({ codec: 'hevc', index: 2, default: true })
    expect(findByTagsOnly([{ key: 'file.videoCodec', value: 'h264' }], 10)).toEqual([])

    db.exec("UPDATE media_locations SET size = 201 WHERE id = 'b'")
    expect(saveProbeResult(second, media, null)).toBe(false)
    expect(filter()).toEqual([])
    expect(suggestLocalMediaValues('file.videoCodec', '', 20)).toEqual([])
    const [changed] = findProbeCandidates(['source-b'], 2000)
    expect(saveProbeResult(changed, null, 3000)).toBe(true)
    expect(findProbeCandidates(['source-b'], 2999)).toEqual([])
    expect(findProbeCandidates(['source-b'], 3000)[0].failures).toBe(1)
    db.exec("UPDATE media_locations SET mtime = 1001 WHERE id = 'b'")
    expect(findProbeCandidates(['source-b'], 2999)[0].failures).toBe(0)
  })

  it('projects grouped file matches onto playable media titles and keeps one file witness per rule', () => {
    db.exec(`
      INSERT INTO media_items (id, parent_item_id, physical_kind, name, created_at, updated_at) VALUES
        ('root',NULL,'folder','Library',1,1),
        ('movie','root','folder','Spirited Away',1,1),
        ('movie-hd','movie','file','Feature.mkv',1,1),
        ('movie-sd','movie','file','Alternate Cut.mkv',1,1),
        ('extras','movie','folder','Extras',1,1),
        ('featurette','extras','file','Making Of.mkv',1,1),
        ('trailer','movie','file','Spirited Away - Trailer.mkv',1,1),
        ('show','root','folder','Fixture Show',1,1),
        ('season','show','folder','Season 01',1,1),
        ('episode-hd','season','file','Episode 01.mkv',1,1),
        ('episode-sd','season','file','Episode 02.mkv',1,1),
        ('standalone','root','file','Concert.mkv',1,1);
      INSERT INTO media_locations (id,item_id,source_id,relative_path,name,type,first_seen_at,last_seen_at)
      SELECT id,id,'source',id,name,physical_kind,1,1 FROM media_items;
      INSERT INTO local_media(location_id, video_height, failures) VALUES
        ('movie-hd',1080,0), ('movie-sd',720,0), ('featurette',2160,0), ('trailer',2160,0),
        ('episode-hd',1080,0), ('episode-sd',480,0), ('standalone',1080,0);
      INSERT INTO local_media_tracks (location_id, stream_index, kind, language, is_default, forced, hearing_impaired)
      VALUES ('movie-hd',1,'audio','eng',1,0,0), ('movie-sd',1,'audio','jpn',1,0,0);

      INSERT INTO accounts (id, username, password_hash, role, created_at)
      VALUES ('viewer','viewer','hash','normal',1);
      INSERT INTO account_filter_rules (account_id, mode, filter_json) VALUES ('viewer','allow','{}');
      INSERT INTO account_visible_items (account_id, item_id) VALUES ('viewer','movie'), ('viewer','movie-sd');
    `)
    upsertMetadata('movie', { mediaType: 'movie', title: 'Spirited Away' })
    upsertMetadata('show', { mediaType: 'tv' })
    upsertMetadata('season', { mediaType: 'season' })
    upsertMetadata('episode-hd', { mediaType: 'episode' })
    upsertMetadata('episode-sd', { mediaType: 'episode' })

    const hd = { key: 'file.videoHeight', value: '1080' }
    const movie = { key: 'mediaType', value: 'movie' }
    const audience = { key: 'file.audioLanguage', value: 'jpn' }
    const [match] = findByTagsOnly([movie, hd], 30)
    expect(match.id).toBe('movie')
    expect(JSON.parse(match.matching_files)).toEqual([{ id: 'movie-hd', title: 'Feature.mkv' }])
    expect(findByFtsQuery('"Spirited Away"', [movie, hd], 30).map(({ id }) => id)).toEqual(['movie'])
    expect(findByTagsOnly([movie, hd, audience], 30)).toEqual([])
    expect(findByTagsOnly([movie, { ...hd, value: '2160' }], 30)).toEqual([])
    expect(findByTagsOnly([{ ...hd, value: '2160' }], 30).map(({ id }) => id).sort())
      .toEqual(['featurette', 'trailer'])
    expect(findByTagsOnly([hd], 30).map(({ id }) => id)).toEqual(['show', 'movie', 'standalone'])
    expect(findByTagsOnly([{ key: 'mediaType', value: 'episode' }, hd], 30).map(({ id }) => id))
      .toEqual(['episode-hd'])
    expect(findByTagsOnly([movie, hd], 30, 'viewer')).toEqual([])
    expect(findByTagsOnly([movie, audience], 30, 'viewer').map(({ id }) => id)).toEqual(['movie'])

    const movieCondition = { field: 'mediaType', op: 'eq' as const, value: 'movie' }
    const height = { field: 'file.videoHeight', op: 'eq' as const, value: 1080 }
    const language = { field: 'file.audioLanguage', op: 'eq' as const, value: 'jpn' }
    evaluateAndInsertVirtualTags([{
      id: 'quality', name: 'quality', cases: [
        { filter: { conditions: [movieCondition, height], requiredConditions: [language] }, result: 'Japanese HD' },
        { filter: { conditions: [movieCondition, height] }, result: 'HD' }
      ]
    }])
    expect(db.query("SELECT item_id, value FROM item_virtual_tags WHERE key = 'quality'").all())
      .toEqual([{ item_id: 'movie', value: 'HD' }])
  })

  it('does not resolve a missing location when a present location is required', () => {
    db.exec(`
      INSERT INTO media_items (id, physical_kind, media_kind, name, created_at, updated_at)
      VALUES ('item-1', 'file', 'movie', 'Movie.mkv', 1000, 1000);

      INSERT INTO media_locations (
        id, item_id, source_id, relative_path, name, type,
        is_present, is_hidden, is_ignored, is_shadowed, first_seen_at, last_seen_at, missing_since
      )
      VALUES ('loc-a', 'item-1', 'source-a', 'Movies/Movie.mkv', 'Movie.mkv', 'file', 0, 0, 0, 0, 1000, 1000, 1100);
    `)

    expect(resolveSelectedLocationForItem('item-1', { requirePresent: true })).toBeNull()
    expect(resolveSelectedLocationForItem('item-1', { requirePresent: false })?.id).toBe('loc-a')
  })

  it('can require a selected location type', () => {
    db.exec(`
      INSERT INTO media_items (id, physical_kind, media_kind, name, created_at, updated_at)
      VALUES ('item-1', 'folder', 'movie', 'Movie', 1000, 1000);

      INSERT INTO media_locations (
        id, item_id, source_id, relative_path, name, type,
        is_present, is_hidden, is_ignored, is_shadowed, first_seen_at, last_seen_at
      )
      VALUES ('loc-a', 'item-1', 'source-a', 'Movies/Movie', 'Movie', 'folder', 1, 0, 0, 0, 1000, 1000);
    `)

    expect(resolveSelectedLocationForItem('item-1', { requirePresent: true, type: 'file' })).toBeNull()
    expect(resolveSelectedLocationForItem('item-1', { requirePresent: true, type: 'folder' })?.id).toBe('loc-a')
  })

  it('respects materialized account visibility when a user is provided', () => {
    db.exec(`
      INSERT INTO accounts (id, username, password_hash, role, created_at)
      VALUES
        ('visible-account', 'visible', 'hash', 'normal', 1000),
        ('hidden-account', 'hidden', 'hash', 'normal', 1000),
        ('unfiltered-account', 'open', 'hash', 'normal', 1000);

      INSERT INTO media_items (id, physical_kind, media_kind, name, created_at, updated_at)
      VALUES ('item-1', 'file', 'movie', 'Movie.mkv', 1000, 1000);

      INSERT INTO media_locations (
        id, item_id, source_id, relative_path, name, type,
        is_present, is_hidden, is_ignored, is_shadowed, first_seen_at, last_seen_at
      )
      VALUES ('loc-a', 'item-1', 'source-a', 'Movies/Movie.mkv', 'Movie.mkv', 'file', 1, 0, 0, 0, 1000, 1000);

      INSERT INTO account_filter_rules (account_id, mode, filter_json)
      VALUES
        ('visible-account', 'allow', '{}'),
        ('hidden-account', 'allow', '{}');

      INSERT INTO account_visible_items (account_id, item_id)
      VALUES ('visible-account', 'item-1');
    `)

    expect(resolveSelectedLocationForItem('item-1', { requirePresent: true, userId: 'visible-account' })?.id).toBe('loc-a')
    expect(resolveSelectedLocationForItem('item-1', { requirePresent: true, userId: 'hidden-account' })).toBeNull()
    expect(resolveSelectedLocationForItem('item-1', { requirePresent: true, userId: 'unfiltered-account' })?.id).toBe('loc-a')
  })
})
