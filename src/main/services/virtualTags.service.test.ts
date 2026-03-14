/**
 * Virtual Tag Evaluation Tests
 *
 * Tests the pure in-memory evaluation logic for virtual tags.
 * These functions take a LibraryItem + Settings and return computed tags.
 * No database, no IO — purely deterministic.
 *
 * SPEC: virtual_tags.md §4.A — Hybrid computation (this tests the JS side)
 */
import { describe, it, expect } from 'bun:test'
import { evaluateVirtualTagsForItem } from './virtualTags.service'
import type { LibraryItem, Settings, VirtualTagConfig, VirtualTagCase } from '@shared/types'

function makeItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
    return {
        id: 'test-item',
        parentId: 'parent-1',
        name: 'test.mkv',
        path: 'Movies/test.mkv',
        type: 'file',
        ...overrides,
    } as LibraryItem
}

function makeSettings(virtualTags: VirtualTagConfig[]): Settings {
    return { virtualTags } as Settings
}

// =================================================================
// SPEC: virtual_tags.md §4.A
// Virtual Tags are computed by evaluating LibraryFilter cases against item metadata.
// Each case has a filter (LibraryFilter) and a result string.
// =================================================================

function makeCase(conditions: VirtualTagCase['filter']['conditions'], result: string): VirtualTagCase {
    return { filter: { conditions }, result }
}

describe('evaluateVirtualTagsForItem', () => {
    it('returns empty object when no virtual tags are defined', () => {
        const item = makeItem()
        const result = evaluateVirtualTagsForItem(item, makeSettings([]))
        expect(result).toEqual({})
    })

    it('returns empty object for root items (no parentId)', () => {
        const item = makeItem({ parentId: undefined })
        const settings = makeSettings([{
            id: 'tag-root',
            name: 'test',
            cases: [makeCase([{ field: 'year', op: 'eq', value: '2024' }], 'Yes')],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result).toEqual({})
    })

    // --- Genre conditions ---

    it('evaluates genre "eq" condition', () => {
        const item = makeItem({ genres: ['Animation', 'Comedy'] })
        const settings = makeSettings([{
            id: 'tag-1',
            name: 'is_anime',
            cases: [makeCase([{ field: 'genre', op: 'eq', value: 'Animation' }], 'Yes')],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.is_anime).toBe('Yes')
    })

    it('evaluates genre "contains" condition (partial match)', () => {
        const item = makeItem({ genres: ['Science Fiction'] })
        const settings = makeSettings([{
            id: 'tag-2',
            name: 'is_scifi',
            cases: [makeCase([{ field: 'genre', op: 'contains', value: 'Science' }], 'Yes')],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.is_scifi).toBe('Yes')
    })

    it('does not match when genre is absent', () => {
        const item = makeItem({ genres: ['Drama'] })
        const settings = makeSettings([{
            id: 'tag-3',
            name: 'is_anime',
            cases: [makeCase([{ field: 'genre', op: 'eq', value: 'Animation' }], 'Yes')],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.is_anime).toBeUndefined()
    })

    // --- Year conditions ---

    it('evaluates year "eq" condition', () => {
        const item = makeItem({ year: 2024 })
        const settings = makeSettings([{
            id: 'tag-4',
            name: 'decade',
            cases: [makeCase([{ field: 'year', op: 'eq', value: '2024' }], '2020s')],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.decade).toBe('2020s')
    })

    it('evaluates year "gt" condition', () => {
        const item = makeItem({ year: 2024 })
        const settings = makeSettings([{
            id: 'tag-5',
            name: 'is_recent',
            cases: [makeCase([{ field: 'year', op: 'gt', value: 2020 }], 'Yes')],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.is_recent).toBe('Yes')
    })

    it('evaluates year "lt" condition', () => {
        const item = makeItem({ year: 1990 })
        const settings = makeSettings([{
            id: 'tag-6',
            name: 'is_classic',
            cases: [makeCase([{ field: 'year', op: 'lt', value: 2000 }], 'Yes')],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.is_classic).toBe('Yes')
    })

    // --- Title and path conditions ---

    it('evaluates title "contains" condition', () => {
        const item = makeItem({ title: 'The Lord of the Rings' })
        const settings = makeSettings([{
            id: 'tag-franchise',
            name: 'franchise',
            cases: [makeCase([{ field: 'title', op: 'contains', value: 'Lord of the Rings' }], 'LotR')],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.franchise).toBe('LotR')
    })

    it('falls back to item.name when title is null', () => {
        const item = makeItem({ name: 'My Movie.mkv', title: undefined })
        const settings = makeSettings([{
            id: 'tag-test-name',
            name: 'test',
            cases: [makeCase([{ field: 'title', op: 'contains', value: 'My Movie' }], 'Yes')],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.test).toBe('Yes')
    })

    it('evaluates path "contains" condition', () => {
        const item = makeItem({ path: 'Anime/Show/Episode.mkv' })
        const settings = makeSettings([{
            id: 'tag-anime-path',
            name: 'is_anime',
            cases: [makeCase([{ field: 'path', op: 'contains', value: 'Anime' }], 'Yes')],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.is_anime).toBe('Yes')
    })

    // --- mediaType conditions ---

    it('evaluates mediaType "eq" condition', () => {
        const item = makeItem({ mediaType: 'movie' })
        const settings = makeSettings([{
            id: 'tag-content-type',
            name: 'content_type',
            cases: [makeCase([{ field: 'mediaType', op: 'eq', value: 'movie' }], 'Movie')],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.content_type).toBe('Movie')
    })

    // --- Manual tag conditions ---

    it('evaluates tags.key condition', () => {
        const item = makeItem({ tags: { resolution: '4K' } })
        const settings = makeSettings([{
            id: 'tag-quality',
            name: 'quality',
            cases: [makeCase([{ field: 'tags.resolution', op: 'eq', value: '4K' }], 'UHD')],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.quality).toBe('UHD')
    })

    // --- Default result ---

    it('applies defaultResult when no case matches', () => {
        const item = makeItem({ year: 2024 })
        const settings = makeSettings([{
            id: 'tag-era-1',
            name: 'era',
            cases: [makeCase([{ field: 'year', op: 'lt', value: 2000 }], 'Classic')],
            defaultResult: 'Modern',
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.era).toBe('Modern')
    })

    it('does not set tag when no match and no defaultResult', () => {
        const item = makeItem({ year: 2024 })
        const settings = makeSettings([{
            id: 'tag-era-2',
            name: 'era',
            cases: [makeCase([{ field: 'year', op: 'lt', value: 2000 }], 'Classic')],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.era).toBeUndefined()
    })

    // --- Multiple tags ---

    it('evaluates multiple virtual tags independently', () => {
        const item = makeItem({ genres: ['Animation'], year: 2024 })
        const settings = makeSettings([
            {
                id: 'tag-anime',
                name: 'is_anime',
                cases: [makeCase([{ field: 'genre', op: 'eq', value: 'Animation' }], 'Yes')],
            },
            {
                id: 'tag-recent',
                name: 'is_recent',
                cases: [makeCase([{ field: 'year', op: 'gt', value: 2020 }], 'Yes')],
            },
        ])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.is_anime).toBe('Yes')
        expect(result.is_recent).toBe('Yes')
    })

    // --- First matching case wins ---

    it('uses first matching case result (short-circuits)', () => {
        const item = makeItem({ genres: ['Animation', 'Action'] })
        const settings = makeSettings([{
            id: 'tag-category',
            name: 'category',
            cases: [
                makeCase([{ field: 'genre', op: 'eq', value: 'Animation' }], 'Animated'),
                makeCase([{ field: 'genre', op: 'eq', value: 'Action' }], 'Action'),
            ],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.category).toBe('Animated') // First match wins
    })

    // --- addedDaysAgo computed field ---

    it('evaluates addedDaysAgo "lt" condition for recently added items', () => {
        const recentItem = makeItem({ addedAt: Date.now() - 5 * 86400000 }) // 5 days ago
        const oldItem = makeItem({ addedAt: Date.now() - 60 * 86400000 })   // 60 days ago
        const settings = makeSettings([{
            id: 'tag-new',
            name: 'new',
            cases: [makeCase([{ field: 'addedDaysAgo', op: 'lt', value: 30 }], 'Yes')],
        }])
        expect(evaluateVirtualTagsForItem(recentItem, settings).new).toBe('Yes')
        expect(evaluateVirtualTagsForItem(oldItem, settings).new).toBeUndefined()
    })

    // --- Scope filter ---

    it('respects scope.parentId — does not match items in other folders', () => {
        const item = makeItem({ year: 2024, parentId: 'folder-b' })
        const settings = makeSettings([{
            id: 'tag-scoped',
            name: 'scoped',
            cases: [{
                filter: { scope: { parentId: 'folder-a' }, conditions: [{ field: 'year', op: 'gt', value: 2020 }] },
                result: 'Yes'
            }],
        }])
        expect(evaluateVirtualTagsForItem(item, settings).scoped).toBeUndefined()
    })
})
