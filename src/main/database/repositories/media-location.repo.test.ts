import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { _clearDbForTesting, _setDbForTesting } from '../client'
import { SCHEMA_SQL } from '../schema'
import { resolveSelectedLocationForItem } from './media-location.repo'

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
