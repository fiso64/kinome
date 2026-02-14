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
import type { LibraryItem, Settings, VirtualTagConfig } from '@shared/types'

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
// Virtual Tags are computed by evaluating conditions against item metadata.
// Each condition has a target, operator, value, and result.
// =================================================================

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
            conditions: [{ target: 'year', operator: 'equals', value: '2024', result: 'Yes' }],
        }])
        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result).toEqual({})
    })

    // --- Genre conditions ---

    it('evaluates genre "equals" condition', () => {
        const item = makeItem({ genres: ['Animation', 'Comedy'] })
        const settings = makeSettings([{
            id: 'tag-1',
            name: 'is_anime',
            conditions: [{ target: 'genre', operator: 'equals', value: 'Animation', result: 'Yes' }],
        }])

        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.is_anime).toBe('Yes')
    })

    it('evaluates genre "contains" condition (partial match)', () => {
        const item = makeItem({ genres: ['Science Fiction'] })
        const settings = makeSettings([{
            id: 'tag-2',
            name: 'is_scifi',
            conditions: [{ target: 'genre', operator: 'contains', value: 'Science', result: 'Yes' }],
        }])

        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.is_scifi).toBe('Yes')
    })

    it('does not match when genre is absent', () => {
        const item = makeItem({ genres: ['Drama'] })
        const settings = makeSettings([{
            id: 'tag-3',
            name: 'is_anime',
            conditions: [{ target: 'genre', operator: 'equals', value: 'Animation', result: 'Yes' }],
        }])

        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.is_anime).toBeUndefined()
    })

    // --- Year conditions ---

    it('evaluates year "equals" condition', () => {
        const item = makeItem({ year: 2024 })
        const settings = makeSettings([{
            id: 'tag-4',
            name: 'decade',
            conditions: [{ target: 'year', operator: 'equals', value: '2024', result: '2020s' }],
        }])

        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.decade).toBe('2020s')
    })

    it('evaluates year "greaterThan" condition', () => {
        const item = makeItem({ year: 2024 })
        const settings = makeSettings([{
            id: 'tag-5',
            name: 'is_recent',
            conditions: [{ target: 'year', operator: 'greaterThan', value: '2020', result: 'Yes' }],
        }])

        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.is_recent).toBe('Yes')
    })

    it('evaluates year "lessThan" condition', () => {
        const item = makeItem({ year: 1990 })
        const settings = makeSettings([{
            id: 'tag-6',
            name: 'is_classic',
            conditions: [{ target: 'year', operator: 'lessThan', value: '2000', result: 'Yes' }],
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
            conditions: [{ target: 'title', operator: 'contains', value: 'Lord of the Rings', result: 'LotR' }],
        }])

        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.franchise).toBe('LotR')
    })

    it('falls back to item.name when title is null', () => {
        const item = makeItem({ name: 'My Movie.mkv', title: undefined })
        const settings = makeSettings([{
            id: 'tag-test-name',
            name: 'test',
            conditions: [{ target: 'title', operator: 'contains', value: 'My Movie', result: 'Yes' }],
        }])

        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.test).toBe('Yes')
    })

    it('evaluates path "contains" condition', () => {
        const item = makeItem({ path: 'Anime/Show/Episode.mkv' })
        const settings = makeSettings([{
            id: 'tag-anime-path',
            name: 'is_anime',
            conditions: [{ target: 'path', operator: 'contains', value: 'Anime', result: 'Yes' }],
        }])

        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.is_anime).toBe('Yes')
    })

    // --- mediaType conditions ---

    it('evaluates mediaType "equals" condition', () => {
        const item = makeItem({ mediaType: 'movie' })
        const settings = makeSettings([{
            id: 'tag-content-type',
            name: 'content_type',
            conditions: [{ target: 'mediaType', operator: 'equals', value: 'movie', result: 'Movie' }],
        }])

        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.content_type).toBe('Movie')
    })

    // --- Manual tag conditions ---

    it('evaluates custom tag condition', () => {
        const item = makeItem({ tags: { resolution: '4K' } })
        const settings = makeSettings([{
            id: 'tag-quality',
            name: 'quality',
            conditions: [{ target: 'tag', operator: 'equals', value: '4K', result: 'UHD', targetKey: 'resolution' }],
        }])

        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.quality).toBe('UHD')
    })

    // --- Default result ---

    it('applies defaultResult when no condition matches', () => {
        const item = makeItem({ year: 2024 })
        const settings = makeSettings([{
            id: 'tag-era-1',
            name: 'era',
            conditions: [{ target: 'year', operator: 'lessThan', value: '2000', result: 'Classic' }],
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
            conditions: [{ target: 'year', operator: 'lessThan', value: '2000', result: 'Classic' }],
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
                conditions: [{ target: 'genre', operator: 'equals', value: 'Animation', result: 'Yes' }],
            },
            {
                id: 'tag-recent',
                name: 'is_recent',
                conditions: [{ target: 'year', operator: 'greaterThan', value: '2020', result: 'Yes' }],
            },
        ])

        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.is_anime).toBe('Yes')
        expect(result.is_recent).toBe('Yes')
    })

    // --- First matching condition wins ---

    it('uses first matching condition result (short-circuits)', () => {
        const item = makeItem({ genres: ['Animation', 'Action'] })
        const settings = makeSettings([{
            id: 'tag-category',
            name: 'category',
            conditions: [
                { target: 'genre', operator: 'equals', value: 'Animation', result: 'Animated' },
                { target: 'genre', operator: 'equals', value: 'Action', result: 'Action' },
            ],
        }])

        const result = evaluateVirtualTagsForItem(item, settings)
        expect(result.category).toBe('Animated') // First match wins
    })
})
