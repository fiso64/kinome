import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { DATABASE_MIGRATIONS, LATEST_SCHEMA_VERSION, runMigrations } from './migrations'
import { SCHEMA_SQL } from './schema'

function getColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name)
}

function getUserVersion(db: Database): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

describe('database migrations', () => {
  it('keeps migrations uniquely versioned and ordered', () => {
    const versions = DATABASE_MIGRATIONS.map((migration) => migration.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('renames existing runtime column to tmdb_runtime and preserves data', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE media_entities (
        id TEXT PRIMARY KEY,
        title TEXT,
        runtime INTEGER
      );
      INSERT INTO media_entities (id, title, runtime) VALUES ('movie-1', 'Perfect Blue', 82);
    `)

    runMigrations(db)

    const columns = getColumns(db, 'media_entities')
    expect(columns).not.toContain('runtime')
    expect(columns).toContain('tmdb_runtime')

    const row = db
      .prepare('SELECT tmdb_runtime FROM media_entities WHERE id = ?')
      .get('movie-1') as { tmdb_runtime: number }
    expect(row.tmdb_runtime).toBe(82)
    expect(getUserVersion(db)).toBe(LATEST_SCHEMA_VERSION)

    db.close()
  })

  it('marks a freshly-created canonical schema as current', () => {
    const db = new Database(':memory:')
    db.exec(SCHEMA_SQL)

    runMigrations(db)

    const columns = getColumns(db, 'media_entities')
    expect(columns).toContain('tmdb_runtime')
    expect(columns).not.toContain('runtime')
    expect(getUserVersion(db)).toBe(LATEST_SCHEMA_VERSION)

    db.close()
  })
})
