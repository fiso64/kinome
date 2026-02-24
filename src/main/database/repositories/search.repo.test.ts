import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import * as searchRepo from './search.repo'
import { getDb, initializeDatabase, closeDatabase } from '../client'
import fs from 'fs'
import path from 'path'

// --- SETUP TEARDOWN ---
// Use a base dir for tests
const TEST_BASE_DIR = path.resolve('./temp/test-runs')

// Use absolute path to ensure we catch all imports
const PATHS_SERVICE_PATH = path.resolve(__dirname, '../../services/paths.service.ts')

let currentTestDir: string = ''

// Setup global mocks BEFORE imports
mock.module(PATHS_SERVICE_PATH, () => ({
    getLibraryDataPath: () => currentTestDir,
    resolveLibraryPath: (p: string) => path.join(currentTestDir, p),
    isRemoteLibrary: () => false,
    isRemotePath: () => false,
}))

describe('Search Repository (Integration)', () => {
    let db: any

    beforeEach(() => {
        // Create a TRULY unique directory for this specific test case
        // This avoids ANY Windows file locking or state contamination issues.
        currentTestDir = path.join(TEST_BASE_DIR, Math.random().toString(36).substring(7))
        fs.mkdirSync(currentTestDir, { recursive: true })

        // Initialize real SQLite DB in this unique folder
        initializeDatabase()
        db = getDb()

        // Seed Data: Create entities first, then items linked to them
        db.prepare(`INSERT INTO media_entities (id, title, media_type, genres_json, tags_json) VALUES 
            ('e1', 'The Matrix', 'movie', '["Sci-Fi", "Action"]', '{"quality": "4K"}'),
            ('e2', 'The Matrix Reloaded', 'movie', '["Sci-Fi", "Action"]', '{"quality": "1080p"}'),
            ('e3', 'Hidden Movie', 'movie', '["Drama"]', '{}'),
            ('e4', 'Ignored Movie', 'movie', '["Action"]', '{}'),
            ('e5', 'Spirited Away', 'movie', '["Animation", "Fantasy"]', '{"studio": "Ghibli"}'),
            ('e6', 'D', 'movie', '["Short"]', '{"is_animated": "Animation"}')
        `).run()

        db.prepare(`INSERT INTO items (id, path, name, type, is_ignored, is_hidden, entity_id) VALUES 
            ('1', 'movie1.mkv', 'The Matrix', 'file', 0, 0, 'e1'),
            ('2', 'movie2.mkv', 'The Matrix Reloaded', 'file', 0, 0, 'e2'),
            ('3', 'movie3.mkv', 'Hidden Movie', 'file', 0, 1, 'e3'),
            ('4', 'movie4.mkv', 'Ignored Movie', 'file', 1, 0, 'e4'),
            ('5', 'anime1.mkv', 'Spirited Away', 'file', 0, 0, 'e5'),
            ('6', 'short.mkv', 'D', 'file', 0, 0, 'e6')
        `).run()

        // Important: Rebuild FTS for the tests
        searchRepo.rebuildFtsIndex()
    })

    afterEach(() => {
        closeDatabase()
        // We don't even need to RM here, we can clean up the whole test-runs dir later or let it be.
        // This makes tests much more stable on Windows.
    })

    describe('findByShortQuery (LIKE)', () => {
        it('finds items by partial title match', () => {
            const results = searchRepo.findByShortQuery('Mat', [], 10)
            expect(results.length).toBe(2)
            expect(results.map((r: any) => r.title)).toContain('The Matrix')
        })

        it('filters out hidden items', () => {
            const results = searchRepo.findByShortQuery('Hidden', [], 10)
            expect(results.length).toBe(0)
        })

        it('filters out ignored items', () => {
            const results = searchRepo.findByShortQuery('Ignored', [], 10)
            expect(results.length).toBe(0)
        })

        it('appends tag filters (AND logic)', () => {
            const tags = [{ key: 'genre', value: 'Action' }]
            const results = searchRepo.findByShortQuery('Mat', tags, 10)
            // Both Matrix 1 and 2 have Sci-Fi and Action
            expect(results.length).toBe(2)
        })

        it('matches short query with tag filter (User Bug Repro)', () => {
            const tags = [{ key: 'is_animated', value: 'Animation' }]
            const results = searchRepo.findByShortQuery('D', tags, 10)
            expect(results.length).toBe(1)
            expect(results[0].title).toBe('D')
        })
    })

    describe('findByFtsQuery (Full Text)', () => {
        it('finds items by exact word match', () => {
            const query = '{title name} : "Matrix"'
            const results = searchRepo.findByFtsQuery(query, [], 10)
            expect(results.length).toBe(2)
        })

        it('applies complex tag filters', () => {
            const query = '{title name} : "Matrix"'
            const tags = [
                { key: 'genre', value: 'Sci-Fi' },
                { key: 'quality', value: '4K' }
            ]
            const results = searchRepo.findByFtsQuery(query, tags, 10)
            expect(results.length).toBe(1)
            expect(results[0].title).toBe('The Matrix')
        })
    })

    describe('findByTagsOnly', () => {
        it('finds items by genre', () => {
            const tags = [{ key: 'genre', value: 'Animation' }]
            const results = searchRepo.findByTagsOnly(tags, 10)
            expect(results.length).toBe(1)
            expect(results[0].title).toBe('Spirited Away')
        })

        it('respects hidden/ignored flags', () => {
            const tags = [{ key: 'genre', value: 'Drama' }] // Hidden Movie has Drama
            const results = searchRepo.findByTagsOnly(tags, 10)
            expect(results.length).toBe(0)
        })
    })
})
