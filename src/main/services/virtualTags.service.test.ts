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

    it('evaluates tags.key "contains" condition', () => {
        const item = makeItem({ tags: { source: 'Blu-ray Remux' } })
        const settings = makeSettings([{
            id: 'tag-source',
            name: 'source_type',
            cases: [makeCase([{ field: 'tags.source', op: 'contains', value: 'Blu-ray' }], 'Disc')],
        }])
        expect(evaluateVirtualTagsForItem(item, settings).source_type).toBe('Disc')
    })

    it('does not match tags.key when tag is absent', () => {
        const item = makeItem({ tags: {} })
        const settings = makeSettings([{
            id: 'tag-missing',
            name: 'quality',
            cases: [makeCase([{ field: 'tags.resolution', op: 'eq', value: '4K' }], 'UHD')],
        }])
        expect(evaluateVirtualTagsForItem(item, settings).quality).toBeUndefined()
    })

    // --- Virtual tag conditions (vt.*) ---

    it('evaluates vt.key condition', () => {
        const item = makeItem({ virtualTags: { is_anime: 'Yes' } } as any)
        const settings = makeSettings([{
            id: 'tag-vt',
            name: 'anime_era',
            cases: [makeCase([{ field: 'vt.is_anime', op: 'eq', value: 'Yes' }], 'Anime')],
        }])
        expect(evaluateVirtualTagsForItem(item, settings).anime_era).toBe('Anime')
    })

    it('does not match vt.key when vtag is absent', () => {
        const item = makeItem({ virtualTags: {} } as any)
        const settings = makeSettings([{
            id: 'tag-vt-missing',
            name: 'anime_era',
            cases: [makeCase([{ field: 'vt.is_anime', op: 'eq', value: 'Yes' }], 'Anime')],
        }])
        expect(evaluateVirtualTagsForItem(item, settings).anime_era).toBeUndefined()
    })

    // --- tags.* and vt.* inside conditionGroups ---

    it('conditionGroups with tags.key conditions', () => {
        const item4k = makeItem({ tags: { resolution: '4K' } })
        const itemHdr = makeItem({ tags: { hdr: 'Dolby Vision' } })
        const itemSd = makeItem({ tags: { resolution: 'SD' } })
        const settings = makeSettings([{
            id: 'tag-premium',
            name: 'premium',
            cases: [{
                filter: {
                    conditionGroups: [
                        [{ field: 'tags.resolution', op: 'eq', value: '4K' }],
                        [{ field: 'tags.hdr', op: 'contains', value: 'Dolby' }],
                    ]
                },
                result: 'Yes'
            }],
        }])
        expect(evaluateVirtualTagsForItem(item4k, settings).premium).toBe('Yes')
        expect(evaluateVirtualTagsForItem(itemHdr, settings).premium).toBe('Yes')
        expect(evaluateVirtualTagsForItem(itemSd, settings).premium).toBeUndefined()
    })

    it('conditionGroups with vt.key conditions', () => {
        const animeItem = makeItem({ virtualTags: { is_anime: 'Yes' } } as any)
        const familyItem = makeItem({ virtualTags: { is_family: 'Yes' } } as any)
        const otherItem = makeItem({ virtualTags: {} } as any)
        const settings = makeSettings([{
            id: 'tag-kid-friendly',
            name: 'kid_friendly',
            cases: [{
                filter: {
                    conditionGroups: [
                        [{ field: 'vt.is_anime', op: 'eq', value: 'Yes' }],
                        [{ field: 'vt.is_family', op: 'eq', value: 'Yes' }],
                    ]
                },
                result: 'Yes'
            }],
        }])
        expect(evaluateVirtualTagsForItem(animeItem, settings).kid_friendly).toBe('Yes')
        expect(evaluateVirtualTagsForItem(familyItem, settings).kid_friendly).toBe('Yes')
        expect(evaluateVirtualTagsForItem(otherItem, settings).kid_friendly).toBeUndefined()
    })

    it('conditionGroups mixing tags.*, vt.*, and metadata fields', () => {
        // (vt.is_anime=Yes AND year>2020) OR (tags.source contains Blu-ray)
        const newAnime = makeItem({ virtualTags: { is_anime: 'Yes' }, year: 2024 } as any)
        const oldAnime = makeItem({ virtualTags: { is_anime: 'Yes' }, year: 2010 } as any)
        const bluray = makeItem({ tags: { source: 'Blu-ray Remux' }, year: 2010 })
        const nothing = makeItem({ year: 2024 })
        const settings = makeSettings([{
            id: 'tag-premium-mix',
            name: 'premium',
            cases: [{
                filter: {
                    conditionGroups: [
                        [{ field: 'vt.is_anime', op: 'eq', value: 'Yes' }, { field: 'year', op: 'gt', value: 2020 }],
                        [{ field: 'tags.source', op: 'contains', value: 'Blu-ray' }],
                    ]
                },
                result: 'Yes'
            }],
        }])
        expect(evaluateVirtualTagsForItem(newAnime, settings).premium).toBe('Yes')   // first group
        expect(evaluateVirtualTagsForItem(oldAnime, settings).premium).toBeUndefined() // year fails
        expect(evaluateVirtualTagsForItem(bluray, settings).premium).toBe('Yes')      // second group
        expect(evaluateVirtualTagsForItem(nothing, settings).premium).toBeUndefined() // neither
    })

    // =================================================================
    // isNull / isNotNull / isEmpty / isNotEmpty — exhaustive coverage
    // Tests every field type branch in matchesCondition
    // =================================================================

    // --- Scalar fields (year, title, etc.) ---

    it('isNull: scalar field — matches when null', () => {
        const item = makeItem({ year: undefined } as any)
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'year', op: 'isNull' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isNull: scalar field — does not match when present', () => {
        const item = makeItem({ year: 2024 })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'year', op: 'isNull' }], 'Y')],
        }])).r).toBeUndefined()
    })

    it('isNotNull: scalar field — matches when present', () => {
        const item = makeItem({ year: 2024 })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'year', op: 'isNotNull' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isNotNull: scalar field — does not match when null', () => {
        const item = makeItem({ year: undefined } as any)
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'year', op: 'isNotNull' }], 'Y')],
        }])).r).toBeUndefined()
    })

    it('isEmpty: scalar field — matches when null', () => {
        const item = makeItem({ year: undefined } as any)
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'year', op: 'isEmpty' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isEmpty: scalar field — matches when empty string', () => {
        const item = makeItem({ title: '' } as any)
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'title', op: 'isEmpty' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isEmpty: scalar field — does not match when has value', () => {
        const item = makeItem({ year: 2024 })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'year', op: 'isEmpty' }], 'Y')],
        }])).r).toBeUndefined()
    })

    it('isNotEmpty: scalar field — matches when has value', () => {
        const item = makeItem({ year: 2024 })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'year', op: 'isNotEmpty' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isNotEmpty: scalar field — does not match when null', () => {
        const item = makeItem({ year: undefined } as any)
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'year', op: 'isNotEmpty' }], 'Y')],
        }])).r).toBeUndefined()
    })

    it('isNotEmpty: scalar field — does not match when empty string', () => {
        const item = makeItem({ title: '' } as any)
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'title', op: 'isNotEmpty' }], 'Y')],
        }])).r).toBeUndefined()
    })

    // --- Genre (array field) ---

    it('isNull: genre — matches when empty array', () => {
        const item = makeItem({ genres: [] })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'genre', op: 'isNull' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isNull: genre — does not match when has genres', () => {
        const item = makeItem({ genres: ['Drama'] })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'genre', op: 'isNull' }], 'Y')],
        }])).r).toBeUndefined()
    })

    it('isNotNull: genre — matches when has genres', () => {
        const item = makeItem({ genres: ['Drama'] })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'genre', op: 'isNotNull' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isEmpty: genre — matches when empty array', () => {
        const item = makeItem({ genres: [] })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'genre', op: 'isEmpty' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isEmpty: genre — matches when undefined', () => {
        const item = makeItem({ genres: undefined } as any)
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'genre', op: 'isEmpty' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isNotEmpty: genre — matches when has genres', () => {
        const item = makeItem({ genres: ['Drama'] })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'genre', op: 'isNotEmpty' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isNotEmpty: genre — does not match when empty', () => {
        const item = makeItem({ genres: [] })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'genre', op: 'isNotEmpty' }], 'Y')],
        }])).r).toBeUndefined()
    })

    // --- tags.* ---

    it('isNull: tags.key — matches when absent', () => {
        const item = makeItem({ tags: {} })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'tags.resolution', op: 'isNull' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isNotNull: tags.key — matches when present', () => {
        const item = makeItem({ tags: { resolution: '4K' } })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'tags.resolution', op: 'isNotNull' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isEmpty: tags.key — matches when absent', () => {
        const item = makeItem({ tags: {} })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'tags.resolution', op: 'isEmpty' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isEmpty: tags.key — matches when empty string', () => {
        const item = makeItem({ tags: { resolution: '' } })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'tags.resolution', op: 'isEmpty' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isNotEmpty: tags.key — matches when has value', () => {
        const item = makeItem({ tags: { resolution: '4K' } })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'tags.resolution', op: 'isNotEmpty' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isNotEmpty: tags.key — does not match when empty string', () => {
        const item = makeItem({ tags: { resolution: '' } })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'tags.resolution', op: 'isNotEmpty' }], 'Y')],
        }])).r).toBeUndefined()
    })

    // --- vt.* ---

    it('isNull: vt.key — matches when absent', () => {
        const item = makeItem({ virtualTags: {} } as any)
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'vt.is_anime', op: 'isNull' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isNotNull: vt.key — matches when present', () => {
        const item = makeItem({ virtualTags: { is_anime: 'Yes' } } as any)
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'vt.is_anime', op: 'isNotNull' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isEmpty: vt.key — matches when absent', () => {
        const item = makeItem({ virtualTags: {} } as any)
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'vt.is_anime', op: 'isEmpty' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isEmpty: vt.key — matches when empty string', () => {
        const item = makeItem({ virtualTags: { is_anime: '' } } as any)
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'vt.is_anime', op: 'isEmpty' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isNotEmpty: vt.key — matches when has value', () => {
        const item = makeItem({ virtualTags: { is_anime: 'Yes' } } as any)
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'vt.is_anime', op: 'isNotEmpty' }], 'Y')],
        }])).r).toBe('Y')
    })

    // --- addedDaysAgo (computed field) ---

    it('isNotNull: addedDaysAgo — always matches (computed field always has a value)', () => {
        const item = makeItem({ addedAt: Date.now() })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'addedDaysAgo', op: 'isNotNull' }], 'Y')],
        }])).r).toBe('Y')
    })

    it('isNotEmpty: addedDaysAgo — always matches (computed field always has a value)', () => {
        const item = makeItem({ addedAt: Date.now() })
        expect(evaluateVirtualTagsForItem(item, makeSettings([{
            id: 't', name: 'r', cases: [makeCase([{ field: 'addedDaysAgo', op: 'isNotEmpty' }], 'Y')],
        }])).r).toBe('Y')
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

    // =================================================================
    // conditionGroups: OR-of-AND groups
    // Each group is an AND-joined set of conditions; groups are OR-joined.
    // e.g. (genre=Animation AND year>2020) OR (genre=Family)
    // =================================================================

    it('matches when first AND-group matches (conditionGroups)', () => {
        const item = makeItem({ genres: ['Animation'], year: 2024 })
        const settings = makeSettings([{
            id: 'tag-or-1',
            name: 'kids',
            cases: [{
                filter: {
                    conditionGroups: [
                        [{ field: 'genre', op: 'eq', value: 'Animation' }, { field: 'year', op: 'gt', value: 2020 }],
                        [{ field: 'genre', op: 'eq', value: 'Family' }],
                    ]
                },
                result: 'Yes'
            }],
        }])
        expect(evaluateVirtualTagsForItem(item, settings).kids).toBe('Yes')
    })

    it('matches when second AND-group matches (conditionGroups)', () => {
        const item = makeItem({ genres: ['Family'], year: 1995 })
        const settings = makeSettings([{
            id: 'tag-or-2',
            name: 'kids',
            cases: [{
                filter: {
                    conditionGroups: [
                        [{ field: 'genre', op: 'eq', value: 'Animation' }, { field: 'year', op: 'gt', value: 2020 }],
                        [{ field: 'genre', op: 'eq', value: 'Family' }],
                    ]
                },
                result: 'Yes'
            }],
        }])
        expect(evaluateVirtualTagsForItem(item, settings).kids).toBe('Yes')
    })

    it('does not match when no AND-group fully matches (conditionGroups)', () => {
        // Animation but year <= 2020 → first group fails
        // Not Family → second group fails
        const item = makeItem({ genres: ['Animation'], year: 2019 })
        const settings = makeSettings([{
            id: 'tag-or-3',
            name: 'kids',
            cases: [{
                filter: {
                    conditionGroups: [
                        [{ field: 'genre', op: 'eq', value: 'Animation' }, { field: 'year', op: 'gt', value: 2020 }],
                        [{ field: 'genre', op: 'eq', value: 'Family' }],
                    ]
                },
                result: 'Yes'
            }],
        }])
        expect(evaluateVirtualTagsForItem(item, settings).kids).toBeUndefined()
    })

    it('conditionGroups with scope applies scope to all groups', () => {
        const item = makeItem({ genres: ['Animation'], year: 2024, parentId: 'folder-b' })
        const settings = makeSettings([{
            id: 'tag-or-scoped',
            name: 'scoped_kids',
            cases: [{
                filter: {
                    scope: { parentId: 'folder-a' },
                    conditionGroups: [
                        [{ field: 'genre', op: 'eq', value: 'Animation' }],
                    ]
                },
                result: 'Yes'
            }],
        }])
        // scope mismatch — should not match even though condition group matches
        expect(evaluateVirtualTagsForItem(item, settings).scoped_kids).toBeUndefined()
    })

    it('single conditionGroup behaves like legacy conditions', () => {
        const item = makeItem({ genres: ['Animation'], year: 2024 })
        // conditionGroups with one group = same as flat conditions
        const settings = makeSettings([{
            id: 'tag-single-group',
            name: 'single',
            cases: [{
                filter: {
                    conditionGroups: [
                        [{ field: 'genre', op: 'eq', value: 'Animation' }, { field: 'year', op: 'gt', value: 2020 }],
                    ]
                },
                result: 'Yes'
            }],
        }])
        expect(evaluateVirtualTagsForItem(item, settings).single).toBe('Yes')
    })

    it('empty conditionGroups matches everything (no constraints)', () => {
        const item = makeItem({ year: 2024 })
        const settings = makeSettings([{
            id: 'tag-empty-groups',
            name: 'all',
            cases: [{
                filter: { conditionGroups: [] },
                result: 'Yes'
            }],
        }])
        expect(evaluateVirtualTagsForItem(item, settings).all).toBe('Yes')
    })
})
